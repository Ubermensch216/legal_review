import { matchesLaw, sameLaw, isOfficial, today, articleText, validDate, inForceAt } from './evidence.js';
// server/law/lawWorkbench.js - 종합 법령 워크벤치 오케스트레이터 (Re-ranking & Cascading 통합)
import { expandQueryKeywords } from './lawTermKb.js';
import { extractArticleReferences, extractOrdinanceNames, normalizeArticleNo } from './lawArticleRef.js';
import { searchLaw, getLawDetail, getLawArticle, getLawVersions } from './lawApiClient.js';
import { getLawDetailAt } from './lawVersionAt.js';
import { searchPrecedents, searchInterpretations, searchAdminRules, searchOrdinances, getOrdinanceDetail, getAdminRuleDetail } from './decisionsApiClient.js';
import { reRankPrecedents, reRankInterpretations } from './reRanker.js';
import { retrieveCascadingHierarchy } from './cascadingRetriever.js';
import { optimizeDocumentContext } from '../parsers/contextOptimizer.js';
import { runTool } from './tools/toolRunner.js';
import { summarizeAvailability } from './decisionDiagnostics.js';

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
 * @returns {Promise<object>}
 */
export async function buildWorkbenchContext({ query = '', preset = 'compliance', documentText = '', targetLaw = '', targetDate = '' }, dependencies = {}) {
  const clients = { searchLaw, getLawDetail, getLawVersions, searchPrecedents, searchInterpretations, searchAdminRules, searchOrdinances, getOrdinanceDetail, getAdminRuleDetail, retrieveCascadingHierarchy, runTool, ...dependencies };
  const collectionWarnings = [];
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
  const optimizedDoc = optimizeDocumentContext({
    documentText,
    query,
    maxChars: 4500
  });

  // 2. 키워드 및 도메인 지식베이스 다중 확장
  const kbResult = expandQueryKeywords(fullContextText);
  const explicitRefs = extractArticleReferences(fullContextText, targetLaw);

  // 3. 검색 대상 주요 법령 결정
  // 자치법규(조례/자치규칙)는 법령 API(searchLaw)가 제공하지 않으므로 별도 채널로 보낸다.
  // 인용 순서상 첫 항목이 조례이면 과거에는 여기서 조회가 끝나버렸다.
  const isOrdinanceName = name => /(?:조례|자치법규)(?:\s*시행규칙)?$/.test(String(name || '').trim());
  const citedLawNames = [...new Set(explicitRefs.map(r => r.lawName).filter(Boolean))];
  const citedStatuteNames = citedLawNames.filter(n => !isOrdinanceName(n));
  // 조문 인용이 붙은 조례 + 제명만 언급된 조례를 합친다.
  // 신청 서식의 근거가 되는 절차 조례(예: 사전 컨설팅감사 운영 조례)는
  // 보통 "제O조" 인용 없이 제명만 등장하므로 별도로 수집해야 한다.
  const citedOrdinanceNames = [...new Set([
    ...citedLawNames.filter(isOrdinanceName),
    ...extractOrdinanceNames(fullContextText)
  ])];

  let primaryLawName = targetLaw;
  let lawLookupFailed = false;

  // 4. 주요 법령 검색 및 상세 조문 조회
  // 후보를 순서대로 시도하되, 각 후보는 자기 이름과 정확히 일치할 때만 채택한다.
  // (검색이 빗나갔을 때 다른 법령의 조문이 요청 법령명으로 표기되는 교차 오표기를 방지)
  let mainLawDetail = null;
  const primaryCandidates = targetLaw
    ? [targetLaw]
    : [...new Set([...citedStatuteNames, ...kbResult.suggestedLaws.map(l => l.name)])];

  if (primaryCandidates.length > 0) {
    const unresolved = [];
    for (const candidate of primaryCandidates.slice(0, 5)) {
      const searchRes = await clients.searchLaw(candidate, 1, 100);
      const exactMatch = Array.isArray(searchRes) ? searchRes.find(l => matchesLaw(l, candidate)) : null;
      if (!exactMatch) { unresolved.push(candidate); continue; }

      const detail = await resolveDetail(exactMatch)
        .catch(err => { collectionWarnings.push(err.message); return null; });
      if (!detail?.articles?.length || !sameLaw(detail.lawName, exactMatch.lawName)) { unresolved.push(candidate); continue; }

      primaryLawName = exactMatch.lawName;
      mainLawDetail = detail;
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

  // 5. 관련 조문 핀포인트 추출
  const targetArticleNos = new Set();
  explicitRefs.filter(r => !r.lawName || sameLaw(r.lawName, primaryLawName)).forEach(r => targetArticleNos.add(r.fullArticleNo));

  // 도메인 지식베이스의 주요 조문을 인용 조문과 '합집합'으로 수집한다.
  // 신청인이 인용한 조문만 모으면, 인용하지 않은 핵심 조문(예: 관리위탁 의제 조항)에
  // 영영 닿지 못한다. 실제 검토자는 사실관계를 보고 그런 조문을 스스로 끌어온다.
  const kbSeededArticleNos = new Set();
  if (kbResult.suggestedLaws.length > 0) {
    const matched = kbResult.suggestedLaws.find(l => sameLaw(l.name, primaryLawName));
    if (matched) {
      matched.mainArticles.forEach(a => {
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
    : (kbResult.suggestedLaws.find(l => sameLaw(l.name, parentActName))?.mainArticles || []).map(normalizeArticleNo);

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

  if (targetArticleNos.size && !collectedArticles.length) collectionWarnings.push('요청한 조문을 공식 본문에서 확인하지 못했습니다.');
  // Preserve each article's law identity and provenance, including multi-law documents.
  const tagArticle = (article, detail) => ({ ...article, lawName: detail.lawName, lawId: detail.lawId, lawSeq: detail.lawSeq,
    source: detail.source || (detail.isMockData ? 'MOCK' : 'UNKNOWN'), isMockData: Boolean(detail.isMockData), enforceDate: article.enforceDate || detail.enforceDate });
  collectedArticles.splice(0, collectedArticles.length, ...collectedArticles.map(a => tagArticle(a, mainLawDetail)));
  // 자치법규는 법령 API 대상이 아니므로 여기서 제외한다. (아래 자치법규 채널에서 조회)
  const otherNames = citedStatuteNames.filter(n => !sameLaw(n, primaryLawName));
  if (otherNames.length > 5) collectionWarnings.push('추가 인용 법령이 조회 예산을 초과하여 일부만 수집했습니다.');
  for (const name of otherNames.slice(0, 5)) {
    try {
      const match = (await clients.searchLaw(name, 1, 100)).find(l => matchesLaw(l, name));
      const detail = match && await resolveDetail(match);
      if (!detail || !sameLaw(detail.lawName, match.lawName)) { collectionWarnings.push(`${name} 본문 수집 실패`); continue; }
      const numbers = new Set(explicitRefs.filter(r => sameLaw(r.lawName, name)).map(r => r.fullArticleNo));
      collectedArticles.push(...detail.articles.filter(a => numbers.has(a.fullArticleNo || String(a.articleNo))).map(a => tagArticle(a, detail)));
    } catch { collectionWarnings.push(`${name} 본문 수집 실패`); }
  }
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

  const [precRes, expcRes, admrulRes, ordinRes, cascadingRes, impactRes, historyRes] = await Promise.allSettled([
    multiSearch(clients.searchPrecedents, decisionQueries, 4),
    multiSearch(clients.searchInterpretations, decisionQueries, 4),
    multiSearch(clients.searchAdminRules, adminRuleQueries, 5),
    // 문서가 특정 자치법규를 명시 인용했으면 그 이름으로 조회한다.
    clients.searchOrdinances(citedOrdinanceNames[0] || primaryLawName || query, 1, 5),
    primaryLawName ? clients.retrieveCascadingHierarchy({ lawName: primaryLawName, articleNos: targetArticleList, actArticleNos: kbActArticleNos, asOfDate: isHistorical ? asOfDate : '' }, clients) : Promise.resolve(null),
    clients.runTool('impactMap', { documentText: textToAnalyze, targetLaw: primaryLawName }),
    primaryLawName ? clients.runTool('lawHistory', { lawName: primaryLawName }) : Promise.resolve(null)
  ]);

  for (const [name, result] of Object.entries({ '판례': precRes, '해석례': expcRes, '행정규칙': admrulRes, '자치법규': ordinRes, '하위 법령': cascadingRes, '영향 분석': impactRes, '법령 연혁': historyRes })) {
    if (result.status === 'rejected' || result.value?.fetchStatus || result.value?.ok === false) collectionWarnings.push(`${name}: 공식 자료 조회 미완료`);
  }

  const rawPrecedents = precRes.status === 'fulfilled' ? precRes.value : [];
  const rawInterpretations = expcRes.status === 'fulfilled' ? expcRes.value : [];
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
  for (const rule of rankedAdminRules.slice(0, 5)) {
    if (!rule?.id) continue;
    try {
      adminRuleDetails.push(await clients.getAdminRuleDetail(rule.id, { expectedName: rule.name }));
    } catch (err) {
      collectionWarnings.push(`${rule.name} 본문 수집 실패: ${err.message}`);
    }
  }

  // 6-1. 문서가 명시 인용한 자치법규의 조문 본문을 확보한다.
  // 목록만으로는 조례 조문을 근거로 쓸 수 없어 과거에는 '조문 확인 필요'로 남았다.
  const ordinanceArticles = [];
  for (const ordinanceName of citedOrdinanceNames.slice(0, 3)) {
    try {
      // 조례마다 제명으로 직접 조회한다. (병렬 조회 목록에는 첫 번째 조례만 반영되어 있다)
      let listed = ordinances.find(o => sameLaw(o.name, ordinanceName));
      if (!listed?.id) {
        const found = await clients.searchOrdinances(ordinanceName, 1, 10);
        listed = Array.isArray(found) ? found.find(o => sameLaw(o.name, ordinanceName)) : null;
      }
      if (!listed?.id) { collectionWarnings.push(`${ordinanceName}: 자치법규 목록에서 확인하지 못했습니다.`); continue; }

      const detail = await clients.getOrdinanceDetail(listed.id, { expectedName: ordinanceName });
      const wanted = new Set(explicitRefs.filter(r => sameLaw(r.lawName, ordinanceName)).map(r => r.fullArticleNo));
      const live = detail.articles.filter(a => inForceAt(a, asOfDate));
      // 특정 조문이 인용된 경우 해당 조문만, 제명만 언급된 경우 앞부분 주요 조문을 확보한다.
      // (절차 조례는 신청·처리·반려 요건이 앞쪽 조문에 모여 있다)
      const picked = wanted.size > 0 ? live.filter(a => wanted.has(a.fullArticleNo)) : live.slice(0, 10);
      if (wanted.size > 0 && picked.length === 0) collectionWarnings.push(`${ordinanceName}의 인용 조문을 본문에서 확인하지 못했습니다.`);
      ordinanceArticles.push(...picked.map(a => ({ ...a, lawName: detail.lawName, lawId: detail.ordinanceId,
        lawType: detail.lawType, orgName: detail.orgName, source: detail.source, isMockData: false })));
    } catch (err) {
      collectionWarnings.push(`${ordinanceName} 본문 수집 실패: ${err.message}`);
    }
  }
  const impactMap = impactRes.status === 'fulfilled' && impactRes.value ? impactRes.value.result : null;
  const lawHistory = historyRes.status === 'fulfilled' && historyRes.value ? historyRes.value.result : null;
  const retrievalAvailability = {
    precedents: summarizeAvailability(precRes.status === 'fulfilled' ? rawPrecedents : Object.assign([], { fetchStatus: 'ERROR' })),
    interpretations: summarizeAvailability(expcRes.status === 'fulfilled' ? rawInterpretations : Object.assign([], { fetchStatus: 'ERROR' }))
  };
  for (const [name, stats] of [['판례', retrievalAvailability.precedents], ['해석례', retrievalAvailability.interpretations]]) {
    if (stats.unavailableCount) collectionWarnings.push(`${name} 목록 ${stats.listCount}건 중 본문 ${stats.fullTextCount}건 확보, ${stats.unavailableCount}건 미확보`);
  }

  // 7. 시맨틱 Re-ranking 적용 (Top 3 판례, Top 2 해석례 엄선)
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

  return {
    meta: {
      query,
      preset,
      primaryLawName,
      // targetDate는 '과거/미래 시점 검토로 요청됨'을 뜻한다. 검증기와 보고서가 이 표식을 본다.
      // asOfDate는 실제로 적용한 기준일이며, 지정이 없으면 오늘이다.
      targetDate: isHistorical ? asOfDate : '',
      asOfDate,
      hasAttachedDocument: Boolean(documentText),
      isOptimizedDoc: Boolean(optimizedDoc.omittedCount > 0 || optimizedDoc.truncatedCount > 0),
      durationMs,
      dataIntegrity,
      retrievalAvailability,
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
    if (!Array.isArray(list) || list.length === 0) return 'NONE';
    return isMock(list) ? 'MOCK' : (list.every(isOfficial) ? 'OFFICIAL_API' : 'UNKNOWN');
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

  const warnings = [...collectionWarnings];
  if (Object.values(sources).includes('UNKNOWN')) warnings.push('출처를 확인하지 못한 자료가 포함되어 있습니다.');
  if (precedents.some(p => p.contentStatus !== 'FULL_TEXT' && !p.isMockData)) warnings.push('본문을 확보하지 못한 판례는 검토 근거에서 제외했습니다.');
  if (interpretations.some(p => p.contentStatus !== 'FULL_TEXT' && !p.isMockData)) warnings.push('본문을 확보하지 못한 해석례는 검토 근거에서 제외했습니다.');
  if (lawLookupFailed) {
    warnings.push(primaryLawName
      ? `'${primaryLawName}'의 공식 조문을 가져오지 못했습니다. 조문 근거 없이 작성된 검토입니다.`
      : '기준 법령을 특정하지 못했습니다. 조문 근거 없이 작성된 검토입니다.');
  }
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

  return {
    isFallback: warnings.length > 0,
    hasOfficialArticles: sources.articles === 'OFFICIAL_API',
    sources,
    warnings
  };
}

export default {
  buildWorkbenchContext
};
