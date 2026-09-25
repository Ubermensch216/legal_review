import { matchesLaw, sameLaw, isOfficial, today, articleText, validDate, inForceAt } from './evidence.js';
// server/law/lawWorkbench.js - 종합 법령 워크벤치 오케스트레이터 (Re-ranking & Cascading 통합)
import { expandQueryKeywords, kbArticlesAt } from './lawTermKb.js';
import { extractArticleReferences, extractOrdinanceNames, normalizeArticleNo, isCitationReference } from './lawArticleRef.js';
import { searchLaw, getLawDetail, getLawArticle, getLawVersions } from './lawApiClient.js';
import { getLawDetailAt } from './lawVersionAt.js';
import { searchPrecedents, searchInterpretations, searchPrecedentCandidates, searchInterpretationCandidates,
  getPrecedentDetail, getInterpretationDetail, searchAdminRules, searchOrdinances, getOrdinanceDetail, getAdminRuleDetail } from './decisionsApiClient.js';
import { screenEvidenceCandidates, hydrateSelectedCandidates } from './evidenceScreen.js';
import { reRankPrecedents, reRankInterpretations } from './reRanker.js';
import { retrieveCascadingHierarchy } from './cascadingRetriever.js';
import { optimizeDocumentContext } from '../parsers/contextOptimizer.js';
import { generatedReportShellWarning } from '../parsers/sourceQuality.js';
import { runTool } from './tools/toolRunner.js';
import { summarizeAvailability } from './decisionDiagnostics.js';
import { NOOP_PROGRESS, countLabel } from './progressReporter.js';
import { detectContractLawSeeds } from '../reasoning/contractReview.js';

// 준용·위임 추적 깊이와 조문 수집 상한.
// 법령 조문은 서로를 광범위하게 인용하므로, 제한 없이 따라가면 법령 전체를 끌어오게 된다.
const MAX_REFERENCE_HOPS = 1;
const MAX_COLLECTED_ARTICLES = 16;

// 같은 법령 안의 조문을, '준용·적용' 취지로 가리키는 지시만 추출한다.
// "제3조(정의)에서 말하는" 같은 단순 언급까지 따라가면 법령 전체가 딸려 온다.
// "법 제22조" / "영 제31조"처럼 다른 법령을 가리키는 표기는 연쇄 검색이 담당하므로 제외한다.
const SAME_LAW_REFERENCE_REGEX =
  /(?<!법\s)(?<!영\s)(?<!규칙\s)제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?:[^.]{0,60}?(준용|적용한다|따른다|따라|의한다|의하여))?/g;

function extractSameLawReferences(text) {
  const numbers = new Set();
  for (const match of String(text || '').matchAll(SAME_LAW_REFERENCE_REGEX)) {
    // 준용·적용 취지의 지시가 확인된 경우에만 추적 대상으로 삼는다.
    if (!match[3]) continue;
    numbers.add(match[2] ? `${match[1]}의${match[2]}` : match[1]);
  }
  return numbers;
}

/**
 * 법령 워크벤치 종합 분석 실행
 * @param {object} options
 * @param {string} options.query - 자연어 질문 또는 검토 요청 내용
 * @param {string} options.preset - 6대 검토 유형 (compliance, contract_risk 등)
 * @param {string} options.documentText - 첨부문서에서 추출된 텍스트
 * @param {string} options.targetLaw - 특정 지정 법령명 (선택)
 * @param {string} options.targetDate - 검토 기준 시점 (YYYYMMDD, 선택). 미지정 시 현행 법령 기준
 * @param {object} [options.progress] - 진행 상황 리포터 (createProgressReporter). 없으면 계측하지 않는다.
 * @returns {Promise<object>}
 */
export async function buildWorkbenchContext({ query = '', preset = 'compliance', documentText = '', targetLaw = '', targetDate = '',
  llmConfig = {}, session = null, progress = NOOP_PROGRESS }, dependencies = {}) {
  const clients = { searchLaw, getLawDetail, getLawVersions, searchPrecedents, searchInterpretations,
    searchPrecedentCandidates, searchInterpretationCandidates, getPrecedentDetail, getInterpretationDetail,
    searchAdminRules, searchOrdinances, getOrdinanceDetail, getAdminRuleDetail, retrieveCascadingHierarchy, runTool, ...dependencies };
  // 기존 주입 테스트/호출자가 본문 포함 검색만 제공하면 그 함수를 그대로 사용한다.
  if (dependencies.searchPrecedents && !dependencies.searchPrecedentCandidates) clients.searchPrecedentCandidates = dependencies.searchPrecedents;
  if (dependencies.searchInterpretations && !dependencies.searchInterpretationCandidates) clients.searchInterpretationCandidates = dependencies.searchInterpretations;
  const collectionWarnings = [];
  const reportShellWarning = generatedReportShellWarning(documentText);
  if (reportShellWarning) collectionWarnings.push(reportShellWarning);
  const startTime = Date.now();
  const fullContextText = `${query}\n${documentText}`.trim();

  // 검토 기준 시점. 지정하지 않으면 현행 법령(오늘)을 기준으로 한다.
  // 이 값 하나가 조문 효력 판단, 버전 선택, 인용 검증의 기준을 모두 결정한다.
  const requestedDate = String(targetDate || '').trim();
  const asOfDate = validDate(requestedDate) || today();
  const isHistorical = Boolean(validDate(requestedDate));
  if (requestedDate && !isHistorical) {
    collectionWarnings.push(`검토 기준일 '${requestedDate}'의 형식이 올바르지 않아 현행 법령(${asOfDate}) 기준으로 검토했습니다.`);
  }
  if (isHistorical && asOfDate > today()) {
    collectionWarnings.push(`검토 기준일(${asOfDate})이 미래입니다. 아직 시행되지 않은 조문이 포함될 수 있습니다.`);
  }

  // 기준 시점이 지정되면 그 날짜에 시행 중이던 버전의 본문을 가져온다.
  // 확인하지 못하면 현행 본문으로 대체하지 않는다. (대체하면 검토자가 그 사실을 알 수 없다)
  const resolveDetail = async (match) => {
    if (!isHistorical) return clients.getLawDetail(match.lawId, match.lawSeq, { enforceDate: match.enforceDate });
    const { detail, reason } = await getLawDetailAt(match, asOfDate, clients);
    if (!detail) collectionWarnings.push(reason);
    return detail;
  };

  // 1. 대용량 첨부문서 컨텍스트 최적화
  progress.start('doc', '첨부문서 조항 선별', documentText ? `${documentText.length.toLocaleString()}자 분석` : '첨부문서 없음', '준비');
  const optimizedDoc = optimizeDocumentContext({
    documentText,
    query,
    maxChars: 4500
  });
  if (!documentText) {
    progress.done('doc', '첨부문서 없이 질의만으로 검토');
  } else {
    const riskCount = (optimizedDoc.selectedChunks || []).filter(c => c.isRiskClause).length;
    progress.done('doc', `조항 ${countLabel((optimizedDoc.selectedChunks || []).length, '개')} 선별`
      + `${optimizedDoc.omittedCount ? `, ${countLabel(optimizedDoc.omittedCount, '개')} 생략` : ''}`
      + `${riskCount ? ` · 위험 조항 ${countLabel(riskCount, '개')} 탐지` : ''}`);
    if (optimizedDoc.omittedCount || optimizedDoc.truncatedCount) {
      progress.warn('doc', `문서가 커서 일부 조항을 생략(${optimizedDoc.omittedCount})·축약(${optimizedDoc.truncatedCount})했습니다.`);
    }
  }

  // 2. 키워드 및 도메인 지식베이스 다중 확장
  progress.start('keywords', '쟁점어 확장 및 인용 조문 추출', '', '준비');
  const kbResult = expandQueryKeywords(fullContextText);
  const contractSeeds = preset === 'contract_risk' ? detectContractLawSeeds(documentText) : [];
  for (const seed of contractSeeds) {
    const index = kbResult.suggestedLaws.findIndex(l => sameLaw(l.name, seed.name));
    const existing = kbResult.suggestedLaws[index];
    if (existing) kbResult.suggestedLaws[index] = { ...existing,
      mainArticles: [...new Set([...(existing.mainArticles || []), ...seed.articles.map(a => `제${a}조`)])] };
    else kbResult.suggestedLaws.push({ name: seed.name, mainArticles: seed.articles.map(a => `제${a}조`) });
  }
  // The preset field may contain several statute names. It is not a single citation default.
  const requestedLawNames = [...new Set(String(targetLaw || '').split(/[,;、，\n]+/).map(name => name.trim()).filter(Boolean))];
  const explicitRefs = extractArticleReferences(fullContextText, requestedLawNames.length === 1 ? requestedLawNames[0] : '');
  progress.done('keywords', `쟁점어 ${countLabel(kbResult.matchedKeywords.length, '개')}`
    + `${kbResult.matchedKeywords.length ? ` (${kbResult.matchedKeywords.slice(0, 4).join(', ')})` : ''}`
    + ` · 인용 조문 ${countLabel(explicitRefs.filter(isCitationReference).length, '개')}`
    + ` · 추천 법령 ${countLabel(kbResult.suggestedLaws.length, '개')}`);
  progress.note('keywords', `기준 시점: ${isHistorical ? `${asOfDate} (과거 시점 검토)` : `${asOfDate} (현행 법령)`}`);

  // 3. 검색 대상 주요 법령 결정
  // 자치법규(조례/자치규칙)는 법령 API(searchLaw)가 제공하지 않으므로 별도 채널로 보낸다.
  // 인용 순서상 첫 항목이 조례이면 과거에는 여기서 조회가 끝나버렸다.
  const isOrdinanceName = name => /(?:조례|자치법규)(?:\s*시행규칙)?$/.test(String(name || '').trim());
  const citedLawNames = [...new Set(explicitRefs.filter(isCitationReference).map(r => r.lawName).filter(Boolean))];
  const citedStatuteNames = citedLawNames.filter(n => !isOrdinanceName(n));
  // 조문 인용이 붙은 조례 + 제명만 언급된 조례를 합친다.
  // 신청 서식의 근거가 되는 절차 조례(예: 사전 컨설팅감사 운영 조례)는
  // 보통 "제O조" 인용 없이 제명만 등장하므로 별도로 수집해야 한다.
  const citedOrdinanceNames = [...new Set([
    ...citedLawNames.filter(isOrdinanceName),
    ...extractOrdinanceNames(fullContextText)
  ])];

  let primaryLawName = requestedLawNames[0] || '';
  let lawLookupFailed = false;

  // 4. 주요 법령 검색 및 상세 조문 조회
  // 후보를 순서대로 시도하되, 각 후보는 자기 이름과 정확히 일치할 때만 채택한다.
  // (검색이 빗나갔을 때 다른 법령의 조문이 요청 법령명으로 표기되는 교차 오표기를 방지)
  let mainLawDetail = null;
  const primaryCandidates = requestedLawNames.length
    ? requestedLawNames.filter(n => !isOrdinanceName(n))
    : [...new Set([...citedStatuteNames, ...kbResult.suggestedLaws.map(l => l.name)])];

  progress.start('law', '기준 법령 확정', primaryCandidates.length
    ? `후보 ${primaryCandidates.slice(0, 5).join(', ')}`
    : (query ? '질의어로 법령 검색' : '후보 없음'), '수집');

  if (primaryCandidates.length > 0) {
    const unresolved = [];
    for (const candidate of primaryCandidates.slice(0, 5)) {
      progress.note('law', `${candidate} 조회 중`);
      const searchRes = await clients.searchLaw(candidate, 1, 100);
      const exactMatch = Array.isArray(searchRes) ? searchRes.find(l => matchesLaw(l, candidate)) : null;
      if (!exactMatch) { unresolved.push(candidate); continue; }

      const detail = await resolveDetail(exactMatch)
        .catch(err => { collectionWarnings.push(err.message); return null; });
      if (!detail?.articles?.length || !sameLaw(detail.lawName, exactMatch.lawName)) { unresolved.push(candidate); continue; }

      primaryLawName = exactMatch.lawName;
      mainLawDetail = detail;
      progress.note('law', `${exactMatch.lawName} 본문 확보 (조문 ${countLabel(detail.articles.length, '개')})`);
      break;
    }

    if (!mainLawDetail) {
      primaryLawName = primaryCandidates[0];
      console.warn(`[LawWorkbench] 후보 법령(${primaryCandidates.slice(0, 5).join(', ')}) 중 조회 가능한 법령이 없습니다. 공식 조문 없이 진행합니다.`);
      lawLookupFailed = true;
    } else if (unresolved.length > 0) {
      collectionWarnings.push(`${unresolved.join(', ')}은(는) 법령 API에서 조회되지 않아 기준 법령을 '${primaryLawName}'으로 확정했습니다.`);
    }
  } else if (query) {
    // 질의어 자체로 법령 검색.
    // 질의가 비어 있을 때 '개인정보 보호법'을 기본 검색어로 넣던 동작은 제거했다.
    // 무관한 사안에 개인정보 보호법이 기준 법령으로 붙는 원인이었다.
    const generalSearch = await clients.searchLaw(query, 1, 3);
    if (generalSearch.length > 0) {
      primaryLawName = generalSearch[0].lawName;
      mainLawDetail = await resolveDetail(generalSearch[0]).catch(err => { collectionWarnings.push(err.message); return null; });
    } else {
      lawLookupFailed = true;
    }
  } else {
    lawLookupFailed = true;
  }

  if (!mainLawDetail?.articles?.length || !sameLaw(mainLawDetail.lawName, primaryLawName)) lawLookupFailed = true;

  progress.done('law', mainLawDetail
    ? `${primaryLawName} · 시행 ${mainLawDetail.enforceDate || '일자 미확인'}`
    : `조회 실패 — 공식 조문 없이 진행 (${primaryLawName || '기준 법령 미확정'})`,
    mainLawDetail ? 'DONE' : 'FAILED');

  // 5. 관련 조문 핀포인트 추출
  progress.start('articles', '적용 조문 수집 및 준용 지시 추적', '', '수집');
  const targetArticleNos = new Set();
  // 문서 자신의 조문(SELF)과 서식 빈칸(PLACEHOLDER)은 기준 법령 조문으로 끌어오지 않는다.
  // 조례안의 '제8조'가 상위법 제8조로 둔갑해 공식 근거로 실리던 경로다.
  explicitRefs.filter(isCitationReference)
    .filter(r => !r.lawName || sameLaw(r.lawName, primaryLawName))
    .forEach(r => targetArticleNos.add(r.fullArticleNo));

  // 도메인 지식베이스의 주요 조문을 인용 조문과 '합집합'으로 수집한다.
  // 신청인이 인용한 조문만 모으면, 인용하지 않은 핵심 조문(예: 관리위탁 의제 조항)에
  // 영영 닿지 못한다. 실제 검토자는 사실관계를 보고 그런 조문을 스스로 끌어온다.
  const kbSeededArticleNos = new Set();
  if (kbResult.suggestedLaws.length > 0) {
    const matched = kbResult.suggestedLaws.find(l => sameLaw(l.name, primaryLawName));
    if (matched) {
      kbArticlesAt(matched, isHistorical ? asOfDate : '').forEach(a => {
        const no = normalizeArticleNo(a);
        if (!targetArticleNos.has(no)) kbSeededArticleNos.add(no);
        targetArticleNos.add(no);
      });
    }
  }

  // 기준 법령이 시행령이면 모법 조문은 하위 조문의 인용을 따라가야만 닿는다.
  // 그 경로로는 위임 관계가 본문에 적히지 않은 조문(예: 관리위탁 의제)에 도달할 수 없으므로,
  // 도메인 지식베이스가 지정한 모법 주요 조문을 연쇄 검색에 함께 넘긴다.
  const parentActName = String(primaryLawName || '').replace(/\s*(시행령|시행규칙)$/, '').trim();
  const kbActArticleNos = sameLaw(parentActName, primaryLawName)
    ? []
    : kbArticlesAt(kbResult.suggestedLaws.find(l => sameLaw(l.name, parentActName)), isHistorical ? asOfDate : '').map(normalizeArticleNo);

  const collectedArticles = [];
  if (mainLawDetail && mainLawDetail.articles) {
    if (targetArticleNos.size > 0) {
      mainLawDetail.articles.filter(a => inForceAt(a, asOfDate)).forEach(art => {
        if (targetArticleNos.has(art.fullArticleNo || String(art.articleNo))) {
          collectedArticles.push(art);
        }
      });
    }
    
    // 조문이 매칭되지 않았으면 앞부분 주요 조문 4~6개 제공
    if (collectedArticles.length === 0 && targetArticleNos.size === 0) {
      collectedArticles.push(...mainLawDetail.articles.filter(a => inForceAt(a, asOfDate)).slice(0, 5));
    }

    // 5-1. 준용·위임 지시 추적.
    // 법령 조문은 "제31조제2항부터 제8항까지의 규정을 준용한다"처럼 같은 법령의 다른 조문을
    // 명시적으로 가리킨다. 그 지시를 따라가지 않으면 법령 체계가 끊긴 채로 검토가 나간다.
    const liveArticles = mainLawDetail.articles.filter(a => inForceAt(a, asOfDate));
    const byNumber = new Map(liveArticles.map(a => [a.fullArticleNo || String(a.articleNo), a]));
    const followedArticleNos = new Set();

    for (let hop = 0; hop < MAX_REFERENCE_HOPS; hop++) {
      const frontier = [];
      for (const article of collectedArticles) {
        for (const no of extractSameLawReferences(articleText(article))) {
          if (targetArticleNos.has(no) || followedArticleNos.has(no)) continue;
          const referenced = byNumber.get(no);
          if (!referenced) continue;
          followedArticleNos.add(no);
          frontier.push(referenced);
        }
      }
      if (frontier.length === 0) break;
      if (collectedArticles.length + frontier.length > MAX_COLLECTED_ARTICLES) {
        collectionWarnings.push('준용·위임으로 연결된 조문이 많아 일부만 수집했습니다.');
        collectedArticles.push(...frontier.slice(0, Math.max(0, MAX_COLLECTED_ARTICLES - collectedArticles.length)));
        break;
      }
      collectedArticles.push(...frontier);
    }
  }

  // 이 집합에는 문서 인용뿐 아니라 지식베이스가 제안한 조문도 들어 있다.
  // 따라서 이를 통틀어 사용자가 "요청한 조문"이라고 표시하면 출처를 잘못 설명한다.
  if (targetArticleNos.size && !collectedArticles.length) collectionWarnings.push('문서 인용·지식베이스 후보 조문을 공식 본문에서 확인하지 못했습니다.');
  // Preserve each article's law identity and provenance, including multi-law documents.
  const tagArticle = (article, detail) => ({ ...article, lawName: detail.lawName, lawId: detail.lawId, lawSeq: detail.lawSeq,
    source: detail.source || (detail.isMockData ? 'MOCK' : 'UNKNOWN'), isMockData: Boolean(detail.isMockData), enforceDate: article.enforceDate || detail.enforceDate });
  collectedArticles.splice(0, collectedArticles.length, ...collectedArticles.map(a => tagArticle(a, mainLawDetail)));
  // 자치법규는 법령 API 대상이 아니므로 여기서 제외한다. (아래 자치법규 채널에서 조회)
  const otherNames = [...new Set([...contractSeeds.map(seed => seed.name),
    ...requestedLawNames.filter(n => !isOrdinanceName(n)), ...citedStatuteNames])]
    .filter(n => !sameLaw(n, primaryLawName));
  if (otherNames.length > 5) collectionWarnings.push('추가 인용 법령이 조회 예산을 초과하여 일부만 수집했습니다.');
  for (const name of otherNames.slice(0, 5)) {
    try {
      const match = (await clients.searchLaw(name, 1, 100)).find(l => matchesLaw(l, name));
      const detail = match && await resolveDetail(match);
      if (!detail || !sameLaw(detail.lawName, match.lawName)) { collectionWarnings.push(`${name} 본문 수집 실패`); continue; }
      const numbers = new Set(explicitRefs.filter(r => isCitationReference(r) && sameLaw(r.lawName, name)).map(r => r.fullArticleNo));
      // A named secondary law is an explicit review target even without an article citation.
      if (requestedLawNames.some(n => sameLaw(n, name)) || contractSeeds.some(seed => sameLaw(seed.name, name))) {
        for (const article of kbArticlesAt(kbResult.suggestedLaws.find(l => sameLaw(l.name, name)), isHistorical ? asOfDate : '')) {
          numbers.add(normalizeArticleNo(article));
        }
      }
      const live = detail.articles.filter(a => inForceAt(a, asOfDate));
      const picked = live.filter(a => numbers.has(a.fullArticleNo || String(a.articleNo)));
      if (!picked.length && (requestedLawNames.some(n => sameLaw(n, name)) || contractSeeds.some(seed => sameLaw(seed.name, name))) && !numbers.size) picked.push(...live.slice(0, 5));
      collectedArticles.push(...picked.map(a => tagArticle(a, detail)));
    } catch { collectionWarnings.push(`${name} 본문 수집 실패`); }
  }
  progress.done('articles', collectedArticles.length
    ? `조문 ${countLabel(collectedArticles.length, '개')} 확보`
      + `${targetArticleNos.size ? ` (인용·지식베이스 지정 ${countLabel(targetArticleNos.size, '개')})` : ' (인용 없음 — 앞부분 주요 조문)'}`
      + `${otherNames.length ? ` · 타 법령 ${countLabel(Math.min(otherNames.length, 5), '개')} 병행 수집` : ''}`
    : '공식 조문을 확보하지 못했습니다', collectedArticles.length ? 'DONE' : 'FAILED');

  const targetArticleList = Array.from(targetArticleNos);

  // 6. 병렬 조회: 판례, 유권해석례, 행정규칙, 자치법규, 3단계 연쇄 체계, 영향 분석, 개정 이력
  const compactKeyword = kbResult.matchedKeywords.length > 0 ? kbResult.matchedKeywords[0] : '';
  const searchQuery = primaryLawName ? (compactKeyword ? `${primaryLawName} ${compactKeyword}` : primaryLawName) : (query || '').slice(0, 20);
  // 판례·해석례 DRF 검색은 질의어를 하나의 문구로 대조하므로 어절이 길수록 0건에 수렴한다.
  // 짧은 주제어 여러 개로 나눠 조회한 뒤 합치고, 순위는 Re-ranker에 맡긴다.
  const topicalQueries = [...new Set([...kbResult.matchedKeywords.slice(0, 3), primaryLawName].filter(Boolean))].slice(0, 4);
  const decisionQueries = topicalQueries.length > 0 ? topicalQueries : [searchQuery].filter(Boolean);

  // 행정규칙(고시·훈령)의 제명은 모법의 핵심 명사를 담는 경우가 많다.
  // 전체 법령명("공유재산 및 물품 관리법 시행령")으로는 거의 잡히지 않으므로
  // 시행령/시행규칙을 떼고 핵심 명사까지 함께 질의한다.
  const baseLawName = String(primaryLawName || '').replace(/\s*(시행령|시행규칙)$/, '').trim();
  const coreNoun = baseLawName.split(/\s*(?:및|·)\s*/)[0].trim();
  const adminRuleQueries = [...new Set([baseLawName, coreNoun, ...kbResult.matchedKeywords.slice(0, 2)].filter(Boolean))].slice(0, 4);

  const multiSearch = async (fn, queries, perQuery) => {
    const lists = await Promise.all(queries.map(q => Promise.resolve(fn(q, 1, perQuery)).catch(() => Object.assign([], { fetchStatus: 'ERROR' }))));
    const merged = [];
    const seen = new Set();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const key = String(item.id || item.caseNo || item.title || '');
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        merged.push(item);
      }
    }
    // 전부 비었을 때는 조회 상태 플래그(UNAVAILABLE/ERROR)를 보존해 '없음'과 '못 가져옴'을 구분한다.
    return merged.length > 0 ? merged : (lists.find(l => Array.isArray(l) && l.fetchStatus) || []);
  };
  const textToAnalyze = `${documentText}\n${query}`.trim();

  // 7개 채널을 동시에 호출한다. 어느 채널이 무엇을 가져왔는지 개별로 알린다.
  progress.start('search', '판례·해석례·행정규칙·자치법규 동시 조회',
    `질의 ${[...new Set([...decisionQueries, ...adminRuleQueries])].slice(0, 5).join(' / ')}`, '수집');

  const [precRes, expcRes, admrulRes, ordinRes, cascadingRes, impactRes, historyRes] = await Promise.allSettled([
    multiSearch(clients.searchPrecedentCandidates, decisionQueries, 4),
    multiSearch(clients.searchInterpretationCandidates, decisionQueries, 4),
    multiSearch(clients.searchAdminRules, adminRuleQueries, 5),
    // 문서가 특정 자치법규를 명시 인용했으면 그 이름으로 조회한다.
    clients.searchOrdinances(citedOrdinanceNames[0] || primaryLawName || query, 1, 5),
    primaryLawName ? clients.retrieveCascadingHierarchy({ lawName: primaryLawName, articleNos: targetArticleList, actArticleNos: kbActArticleNos, asOfDate: isHistorical ? asOfDate : '' }, clients) : Promise.resolve(null),
    clients.runTool('impactMap', { documentText: textToAnalyze, targetLaw: primaryLawName }),
    primaryLawName ? clients.runTool('lawHistory', { lawName: primaryLawName }) : Promise.resolve(null)
  ]);

  const channels = { '판례': precRes, '해석례': expcRes, '행정규칙': admrulRes, '자치법규': ordinRes, '하위 법령': cascadingRes, '영향 분석': impactRes, '법령 연혁': historyRes };
  for (const [name, result] of Object.entries(channels)) {
    if (result.status === 'rejected' || result.value?.fetchStatus || result.value?.ok === false) collectionWarnings.push(`${name}: 공식 자료 조회 미완료`);
  }

  // 채널별 수확량을 개별 줄로 남긴다. '없음'과 '못 가져옴'을 화면에서도 구분한다.
  for (const [name, result] of Object.entries(channels)) {
    if (result.status === 'rejected') { progress.warn('search', `${name}: 조회 실패 (${result.reason?.message || '원인 미상'})`); continue; }
    const value = result.value;
    if (value?.fetchStatus || value?.ok === false) { progress.warn('search', `${name}: 조회 미완료`); continue; }
    if (Array.isArray(value)) { progress.note('search', `${name} ${countLabel(value.length)}`); continue; }
    if (name === '하위 법령') {
      const tiers = value?.hierarchy ? Object.keys(value.hierarchy).length : 0;
      progress.note('search', value ? `법–시행령–시행규칙 연쇄 ${countLabel(tiers, '단')} 확인` : '하위 법령 연쇄: 해당 없음');
      continue;
    }
    progress.note('search', `${name} 확보`);
  }
  progress.done('search', `판례 ${countLabel((precRes.status === 'fulfilled' ? precRes.value : []).length)}`
    + ` · 해석례 ${countLabel((expcRes.status === 'fulfilled' ? expcRes.value : []).length)}`
    + ` · 행정규칙 ${countLabel((admrulRes.status === 'fulfilled' ? admrulRes.value : []).length)}`
    + ` · 자치법규 ${countLabel((ordinRes.status === 'fulfilled' ? ordinRes.value : []).length)}`);

  const listedPrecedents = precRes.status === 'fulfilled' ? precRes.value : [];
  const listedInterpretations = expcRes.status === 'fulfilled' ? expcRes.value : [];
  const screening = { decisions: [], warnings: [] };
  const screenAndLoad = async (candidates, kind, loadDetail) => {
    if (candidates.fetchStatus) return candidates;
    const protectedIds = candidates.filter(item => {
      const number = kind === 'precedent' ? item.caseNo : item.itemNo;
      if (number && fullContextText.includes(number)) return true;
      const excerpt = `${item.holding || ''} ${item.summary || ''} ${item.question || ''}`;
      return explicitRefs.some(ref => isCitationReference(ref) && ref.lawName && excerpt.includes(ref.lawName)
        && excerpt.includes(`제${ref.fullArticleNo}조`));
    }).map(item => item.id);
    const screened = await screenEvidenceCandidates({ candidates, kind,
      query: `검토 질의: ${query}\n적용 법령: ${primaryLawName}\n관련 조문: ${targetArticleList.join(', ')}\n쟁점어: ${kbResult.matchedKeywords.join(', ')}`,
      provider: llmConfig.provider, model: llmConfig.model, apiKey: llmConfig.apiKey, session, protectedIds });
    screening.decisions.push(...screened.decisions);
    screening.warnings.push(...screened.warnings);
    const hydrated = await hydrateSelectedCandidates({ candidates: screened.selected, kind, loadDetail });
    screening.warnings.push(...hydrated.warnings);
    return hydrated.items;
  };
  progress.start('screen', '검색 목록 적합성 선별·공식 본문 확보', '', '수집');
  // 로컬 Ollama에는 직렬로 보내 접두부 캐시와 모델 메모리를 안정적으로 사용한다.
  const rawPrecedents = await screenAndLoad(listedPrecedents, 'precedent', clients.getPrecedentDetail);
  const rawInterpretations = await screenAndLoad(listedInterpretations, 'interpretation', clients.getInterpretationDetail);
  collectionWarnings.push(...screening.warnings);
  progress.done('screen', `목록 ${countLabel(listedPrecedents.length + listedInterpretations.length)} · 본문 ${countLabel([...rawPrecedents, ...rawInterpretations].filter(x => x.contentStatus === 'FULL_TEXT').length)}`);
  const adminRules = admrulRes.status === 'fulfilled' ? admrulRes.value : [];
  const ordinances = ordinRes.status === 'fulfilled' ? ordinRes.value : [];
  const cascadingHierarchy = cascadingRes.status === 'fulfilled' ? cascadingRes.value : null;

  // 6-0. 사안과 직결된 행정규칙(고시·훈령)의 조문 본문과 별표 목록을 확보한다.
  // 별표 본문은 국가법령정보센터가 첨부파일로만 제공하므로 링크로 전달한다.
  // 본문까지 가져올 대상은 기준 법령과의 관련성이 높은 순으로 고른다.
  // (질의어가 넓게 걸려 무관한 타 부처 고시가 앞에 오는 것을 막는다)
  const adminRuleRelevance = rule => {
    const name = String(rule?.name || '');
    let score = 0;
    if (coreNoun && name.includes(coreNoun)) score += 3;
    if (baseLawName && name.includes(baseLawName)) score += 3;
    for (const kw of kbResult.matchedKeywords.slice(0, 3)) if (kw && name.includes(kw)) score += 1;
    return score;
  };
  const rankedAdminRules = [...adminRules].sort((a, b) => adminRuleRelevance(b) - adminRuleRelevance(a));

  // 어느 고시가 결정적 근거인지는 휴리스틱으로 확정할 수 없다.
  // 후보 수가 적으므로 본문을 모두 확보하고, 선택은 검토자에게 맡긴다.
  const adminRuleDetails = [];
  const adminRuleTargets = rankedAdminRules.slice(0, 5).filter(r => r?.id);
  if (adminRuleTargets.length) progress.start('adminrule', '행정규칙 본문·별표 확보', `대상 ${countLabel(adminRuleTargets.length)}`, '수집');
  for (const rule of adminRuleTargets) {
    try {
      adminRuleDetails.push(await clients.getAdminRuleDetail(rule.id, { expectedName: rule.name }));
      progress.note('adminrule', `${rule.name} 본문 확보`);
    } catch (err) {
      collectionWarnings.push(`${rule.name} 본문 수집 실패: ${err.message}`);
      progress.warn('adminrule', `${rule.name} 본문 수집 실패`);
    }
  }
  if (adminRuleTargets.length) {
    progress.done('adminrule', `본문 ${countLabel(adminRuleDetails.length)} 확보`,
      adminRuleDetails.length ? 'DONE' : 'FAILED');
  }

  // 6-1. 문서가 명시 인용한 자치법규의 조문 본문을 확보한다.
  // 목록만으로는 조례 조문을 근거로 쓸 수 없어 과거에는 '조문 확인 필요'로 남았다.
  const ordinanceArticles = [];
  const ordinanceTargets = citedOrdinanceNames.slice(0, 3);
  if (ordinanceTargets.length) progress.start('ordinance', '인용 자치법규 조문 확보', ordinanceTargets.join(', '), '수집');
  for (const ordinanceName of ordinanceTargets) {
    try {
      // 조례마다 제명으로 직접 조회한다. (병렬 조회 목록에는 첫 번째 조례만 반영되어 있다)
      let listed = ordinances.find(o => sameLaw(o.name, ordinanceName));
      if (!listed?.id) {
        const found = await clients.searchOrdinances(ordinanceName, 1, 10);
        listed = Array.isArray(found) ? found.find(o => sameLaw(o.name, ordinanceName)) : null;
      }
      if (!listed?.id) { collectionWarnings.push(`${ordinanceName}: 자치법규 목록에서 확인하지 못했습니다.`); continue; }

      const detail = await clients.getOrdinanceDetail(listed.id, { expectedName: ordinanceName });
      const wanted = new Set(explicitRefs.filter(r => isCitationReference(r) && sameLaw(r.lawName, ordinanceName)).map(r => r.fullArticleNo));
      const live = detail.articles.filter(a => inForceAt(a, asOfDate));
      // 특정 조문이 인용된 경우 해당 조문만, 제명만 언급된 경우 앞부분 주요 조문을 확보한다.
      // (절차 조례는 신청·처리·반려 요건이 앞쪽 조문에 모여 있다)
      const picked = wanted.size > 0 ? live.filter(a => wanted.has(a.fullArticleNo)) : live.slice(0, 10);
      if (wanted.size > 0 && picked.length === 0) collectionWarnings.push(`${ordinanceName}의 인용 조문을 본문에서 확인하지 못했습니다.`);
      ordinanceArticles.push(...picked.map(a => ({ ...a, lawName: detail.lawName, lawId: detail.ordinanceId,
        lawType: detail.lawType, orgName: detail.orgName, source: detail.source, isMockData: false })));
      progress.note('ordinance', `${ordinanceName} 조문 ${countLabel(picked.length, '개')} 확보`);
    } catch (err) {
      collectionWarnings.push(`${ordinanceName} 본문 수집 실패: ${err.message}`);
      progress.warn('ordinance', `${ordinanceName} 본문 수집 실패`);
    }
  }
  if (ordinanceTargets.length) {
    progress.done('ordinance', `조문 ${countLabel(ordinanceArticles.length, '개')} 확보`,
      ordinanceArticles.length ? 'DONE' : 'FAILED');
  }
  const impactMap = impactRes.status === 'fulfilled' && impactRes.value ? impactRes.value.result : null;
  const lawHistory = historyRes.status === 'fulfilled' && historyRes.value ? historyRes.value.result : null;
  const retrievalAvailability = {
    precedents: summarizeAvailability(precRes.status === 'fulfilled' ? rawPrecedents : Object.assign([], { fetchStatus: 'ERROR' })),
    interpretations: summarizeAvailability(expcRes.status === 'fulfilled' ? rawInterpretations : Object.assign([], { fetchStatus: 'ERROR' }))
  };
  retrievalAvailability.precedents.candidateCount = listedPrecedents.length;
  retrievalAvailability.interpretations.candidateCount = listedInterpretations.length;
  retrievalAvailability.precedents.screenedOutCount = screening.decisions.filter(d => d.kind === 'precedent' && !d.selected).length;
  retrievalAvailability.interpretations.screenedOutCount = screening.decisions.filter(d => d.kind === 'interpretation' && !d.selected).length;
  for (const [name, stats] of [['판례', retrievalAvailability.precedents], ['해석례', retrievalAvailability.interpretations]]) {
    if (stats.unavailableCount) collectionWarnings.push(`${name} 목록 ${stats.listCount}건 중 본문 ${stats.fullTextCount}건 확보, ${stats.unavailableCount}건 미확보`);
  }

  // 7. 시맨틱 Re-ranking 적용 (Top 3 판례, Top 2 해석례 엄선)
  progress.start('rerank', '판례·해석례 시맨틱 재순위',
    `후보 판례 ${countLabel(rawPrecedents.length)} · 해석례 ${countLabel(rawInterpretations.length)}`, '분석');
  const rankedPrecedents = reRankPrecedents({
    precedents: rawPrecedents,
    query: `${query} ${kbResult.matchedKeywords.join(' ')}`,
    targetLaw: primaryLawName,
    articleNos: targetArticleList,
    expandedTerms: kbResult.expandedTerms
  });

  const rankedInterpretations = reRankInterpretations({
    interpretations: rawInterpretations,
    query,
    targetLaw: primaryLawName,
    expandedTerms: kbResult.expandedTerms
  });

  progress.done('rerank', `상위 판례 ${countLabel(rankedPrecedents.length)} · 해석례 ${countLabel(rankedInterpretations.length)} 채택`);

  const annexes = (mainLawDetail && mainLawDetail.annexes) ? mainLawDetail.annexes : [];
  const durationMs = Date.now() - startTime;

  // 수집된 데이터의 출처를 집계한다. 목업/폴백이 섞인 결과가 공식 수집 결과와
  // 구분되지 않은 채 결재 문서로 나가는 것을 막기 위한 표식이다.
  const dataIntegrity = buildDataIntegrityReport({
    lawDetail: mainLawDetail,
    articles: collectedArticles,
    precedents: rankedPrecedents,
    interpretations: rankedInterpretations,
    adminRules,
    ordinances,
    lawLookupFailed,
    primaryLawName,
    collectionWarnings
  });

  if (dataIntegrity.isFallback) {
    console.warn(`[LawWorkbench] 검토 제한 사항: ${dataIntegrity.warnings.join(' / ')}`);
  }

  progress.mark('integrity', '수집 자료 출처 검증',
    `공식 조문 ${dataIntegrity.hasOfficialArticles ? '확보' : '미확보'}`
    + ` · 제한 사항 ${countLabel(dataIntegrity.warnings.length)}`
    + (dataIntegrity.isFallback ? ' · 폴백/목업 포함' : ''), '검증');
  for (const w of dataIntegrity.warnings.slice(0, 8)) progress.warn('integrity', w);

  return {
    meta: {
      query,
      preset,
      primaryLawName,
      ...(preset === 'contract_risk' ? { governingLaws: [...new Set(contractSeeds.map(seed => seed.name))] } : {}),
      // targetDate는 '과거/미래 시점 검토로 요청됨'을 뜻한다. 검증기와 보고서가 이 표식을 본다.
      // asOfDate는 실제로 적용한 기준일이며, 지정이 없으면 오늘이다.
      targetDate: isHistorical ? asOfDate : '',
      asOfDate,
      hasAttachedDocument: Boolean(documentText),
      isOptimizedDoc: Boolean(optimizedDoc.omittedCount > 0 || optimizedDoc.truncatedCount > 0),
      durationMs,
      dataIntegrity,
      retrievalAvailability,
      evidenceScreening: screening.decisions,
      timestamp: new Date().toISOString()
    },
    reviewContext: { document: optimizedDoc },
    // Tab 2: 공식 근거 데이터 (Re-ranking 및 Cascading 반영)
    officialEvidence: {
      lawDetail: mainLawDetail ? {
        lawId: mainLawDetail.lawId,
        lawSeq: mainLawDetail.lawSeq,
        source: mainLawDetail.source || (mainLawDetail.isMockData ? 'MOCK' : 'UNKNOWN'),
        isMockData: Boolean(mainLawDetail.isMockData),
        contentStatus: mainLawDetail.contentStatus,
        lawName: mainLawDetail.lawName,
        promulDate: mainLawDetail.promulDate,
        enforceDate: mainLawDetail.enforceDate,
        lawType: mainLawDetail.lawType,
        ministry: mainLawDetail.ministry
      } : null,
      articles: collectedArticles,
      annexes,
      cascadingHierarchy,
      precedents: rankedPrecedents,
      interpretations: rankedInterpretations,
      adminRules,
      ordinances,
      // 문서가 인용한 자치법규의 확보된 조문 본문 (조례 근거)
      ordinanceArticles,
      // 행정규칙 조문 본문 및 별표 목록 (별표는 첨부파일 링크)
      adminRuleDetails
    },
    // Tab 3: 개정 및 영향 분석 데이터 (위험 조항 및 법령 이력 완비)
    impactAndRevisions: {
      primaryLawDetail: mainLawDetail,
      impactMap,
      lawHistory,
      extractedReferences: explicitRefs,
      expandedKeywords: kbResult.expandedTerms,
      documentChunks: optimizedDoc.selectedChunks,
      riskClauses: (optimizedDoc.selectedChunks || []).filter(c => c.isRiskClause)
    }
  };
}

/**
 * 수집 결과에 목업/폴백 데이터가 섞였는지 집계한다.
 * @returns {{ isFallback: boolean, hasOfficialArticles: boolean, sources: object, warnings: string[] }}
 */
function buildDataIntegrityReport({
  lawDetail, articles, precedents, interpretations, adminRules, ordinances, lawLookupFailed, primaryLawName, collectionWarnings = []
}) {
  const isMock = (list) => Array.isArray(list) && list.length > 0 && list.some(x => x && x.isMockData);
  const sourceOf = (list) => {
    const usable = Array.isArray(list) ? list.filter(x => x?.contentStatus !== 'LIST_ONLY') : [];
    if (!usable.length) return 'NONE';
    return isMock(usable) ? 'MOCK' : (usable.every(isOfficial) ? 'OFFICIAL_API' : 'UNKNOWN');
  };

  const lawSource = lawLookupFailed
    ? 'NONE'
    : (lawDetail && lawDetail.isMockData ? 'MOCK' : (isOfficial(lawDetail) ? 'OFFICIAL_API' : 'NONE'));

  const sources = {
    law: lawSource,
    articles: sourceOf(articles),
    precedents: sourceOf(precedents),
    interpretations: sourceOf(interpretations),
    adminRules: sourceOf(adminRules),
    ordinances: sourceOf(ordinances)
  };

  // 조회 실패는 수집 진단에 남기되, 확보한 자료로 작성한 검토의 품질 판정과 분리한다.
  const warnings = [];
  warnings.push(...collectionWarnings.filter(w => /검토 기준일|기준일\(|시점|시행되지 않은|기존 AI 검토보고서/.test(w)));
  if (Object.values(sources).includes('UNKNOWN')) warnings.push('출처를 확인하지 못한 자료가 포함되어 있습니다.');
  if (sources.law === 'MOCK' || sources.articles === 'MOCK') {
    warnings.push('법령 조문이 공식 API가 아닌 샘플 목업 데이터입니다. 인용하지 마십시오.');
  }
  if (sources.precedents === 'MOCK') {
    warnings.push('판례가 공식 API가 아닌 샘플 목업 데이터입니다. 실제 사건번호가 아닙니다.');
  }
  if (sources.interpretations === 'MOCK') {
    warnings.push('유권해석례가 공식 API가 아닌 샘플 목업 데이터입니다.');
  }
  if (sources.adminRules === 'MOCK' || sources.ordinances === 'MOCK') {
    warnings.push('행정규칙/자치법규가 샘플 목업 데이터입니다.');
  }
  const hasUsableEvidence = [articles, precedents, interpretations, adminRules, ordinances]
    .some(list => Array.isArray(list) && list.some(item => isOfficial(item) && item.contentStatus !== 'LIST_ONLY'));
  if (!hasUsableEvidence) warnings.push('검토에 사용할 수 있는 공식 근거 본문이 없습니다.');

  return {
    isFallback: warnings.length > 0,
    hasOfficialArticles: sources.articles === 'OFFICIAL_API',
    sources,
    collectionDiagnostics: collectionWarnings,
    warnings
  };
}

export default {
  buildWorkbenchContext
};
