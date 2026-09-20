// server/law/lawWorkbench.js - 종합 법령 워크벤치 오케스트레이터 (Re-ranking & Cascading 통합)
import { expandQueryKeywords } from './lawTermKb.js';
import { extractArticleReferences, normalizeArticleNo } from './lawArticleRef.js';
import { searchLaw, getLawDetail, getLawArticle } from './lawApiClient.js';
import { searchPrecedents, searchInterpretations, searchAdminRules, searchOrdinances } from './decisionsApiClient.js';
import { reRankPrecedents, reRankInterpretations } from './reRanker.js';
import { retrieveCascadingHierarchy } from './cascadingRetriever.js';
import { optimizeDocumentContext } from '../parsers/contextOptimizer.js';
import { runTool } from './tools/toolRunner.js';

/**
 * 법령 워크벤치 종합 분석 실행
 * @param {object} options
 * @param {string} options.query - 자연어 질문 또는 검토 요청 내용
 * @param {string} options.preset - 6대 검토 유형 (compliance, contract_risk 등)
 * @param {string} options.documentText - 첨부문서에서 추출된 텍스트
 * @param {string} options.targetLaw - 특정 지정 법령명 (선택)
 * @returns {Promise<object>}
 */
export async function buildWorkbenchContext({ query = '', preset = 'compliance', documentText = '', targetLaw = '' }) {
  const startTime = Date.now();
  const fullContextText = `${query}\n${documentText}`.trim();

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
  let primaryLawName = targetLaw;
  let lawLookupFailed = false;

  if (!primaryLawName) {
    if (explicitRefs.length > 0 && explicitRefs[0].lawName) {
      primaryLawName = explicitRefs[0].lawName;
    } else if (kbResult.suggestedLaws.length > 0) {
      primaryLawName = kbResult.suggestedLaws[0].name;
    }
  }

  // 4. 주요 법령 검색 및 상세 조문 조회
  let mainLawDetail = null;
  if (primaryLawName) {
    const requestedLawName = primaryLawName;
    const searchRes = await searchLaw(primaryLawName, 1, 3);

    // 검색 결과 중 요청한 법령과 실제로 일치하는 항목만 채택한다.
    // 과거에는 무조건 searchRes[0]을 채택해, 검색이 빗나가면 사용자가 지정한
    // targetLaw가 조용히 다른 법령으로 바뀌었다.
    const normalizedRequest = requestedLawName.replace(/\s+/g, '');
    const exactMatch = searchRes.find(l => {
      const name = (l.lawName || '').replace(/\s+/g, '');
      return name.includes(normalizedRequest) || normalizedRequest.includes(name);
    });

    if (exactMatch) {
      primaryLawName = exactMatch.lawName;
      mainLawDetail = await getLawDetail(exactMatch.lawId, exactMatch.lawSeq);
    } else {
      // 일치하는 법령을 찾지 못하면 요청한 법령명을 유지하고 조문 없이 진행한다.
      // (다른 법령의 조문을 요청 법령명으로 표기하는 교차 오표기를 방지)
      console.warn(`[LawWorkbench] '${requestedLawName}'과 일치하는 법령을 찾지 못했습니다. 공식 조문 없이 진행합니다.`);
      lawLookupFailed = true;
    }
  } else if (query) {
    // 질의어 자체로 법령 검색.
    // 질의가 비어 있을 때 '개인정보 보호법'을 기본 검색어로 넣던 동작은 제거했다.
    // 무관한 사안에 개인정보 보호법이 기준 법령으로 붙는 원인이었다.
    const generalSearch = await searchLaw(query, 1, 3);
    if (generalSearch.length > 0) {
      primaryLawName = generalSearch[0].lawName;
      mainLawDetail = await getLawDetail(generalSearch[0].lawId, generalSearch[0].lawSeq);
    } else {
      lawLookupFailed = true;
    }
  } else {
    lawLookupFailed = true;
  }

  // 목업 스텁(조문 없음)은 기준 법령으로 삼지 않는다.
  if (mainLawDetail && mainLawDetail.isMockData && (!mainLawDetail.articles || mainLawDetail.articles.length === 0)) {
    lawLookupFailed = true;
  }

  // 5. 관련 조문 핀포인트 추출
  const targetArticleNos = new Set();
  explicitRefs.forEach(r => targetArticleNos.add(r.fullArticleNo));

  if (targetArticleNos.size === 0 && kbResult.suggestedLaws.length > 0) {
    const matched = kbResult.suggestedLaws.find(l => l.name === primaryLawName);
    if (matched) {
      matched.mainArticles.forEach(a => targetArticleNos.add(normalizeArticleNo(a)));
    }
  }

  const collectedArticles = [];
  if (mainLawDetail && mainLawDetail.articles) {
    if (targetArticleNos.size > 0) {
      mainLawDetail.articles.forEach(art => {
        if (targetArticleNos.has(art.fullArticleNo) || targetArticleNos.has(art.articleNo)) {
          collectedArticles.push(art);
        }
      });
    }
    
    // 조문이 매칭되지 않았으면 앞부분 주요 조문 4~6개 제공
    if (collectedArticles.length === 0) {
      collectedArticles.push(...mainLawDetail.articles.slice(0, 5));
    }
  }

  const targetArticleList = Array.from(targetArticleNos);

  // 6. 병렬 조회: 판례, 유권해석례, 행정규칙, 자치법규, 3단계 연쇄 체계, 영향 분석, 개정 이력
  const compactKeyword = kbResult.matchedKeywords.length > 0 ? kbResult.matchedKeywords[0] : '';
  const searchQuery = primaryLawName ? (compactKeyword ? `${primaryLawName} ${compactKeyword}` : primaryLawName) : (query || '').slice(0, 20);
  const textToAnalyze = `${documentText}\n${query}`.trim();

  const [precRes, expcRes, admrulRes, ordinRes, cascadingRes, impactRes, historyRes] = await Promise.allSettled([
    searchPrecedents(searchQuery, 1, 10),
    searchInterpretations(searchQuery, 1, 8),
    searchAdminRules(primaryLawName || query, 1, 5),
    searchOrdinances(primaryLawName || query, 1, 5),
    primaryLawName ? retrieveCascadingHierarchy({ lawName: primaryLawName, articleNos: targetArticleList }) : Promise.resolve(null),
    runTool('impactMap', { documentText: textToAnalyze, targetLaw: primaryLawName }),
    primaryLawName ? runTool('lawHistory', { lawName: primaryLawName }) : Promise.resolve(null)
  ]);

  const rawPrecedents = precRes.status === 'fulfilled' ? precRes.value : [];
  const rawInterpretations = expcRes.status === 'fulfilled' ? expcRes.value : [];
  const adminRules = admrulRes.status === 'fulfilled' ? admrulRes.value : [];
  const ordinances = ordinRes.status === 'fulfilled' ? ordinRes.value : [];
  const cascadingHierarchy = cascadingRes.status === 'fulfilled' ? cascadingRes.value : null;
  const impactMap = impactRes.status === 'fulfilled' && impactRes.value ? impactRes.value.result : null;
  const lawHistory = historyRes.status === 'fulfilled' && historyRes.value ? historyRes.value.result : null;

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
    primaryLawName
  });

  if (dataIntegrity.isFallback) {
    console.warn(`[LawWorkbench] 폴백 데이터 포함 응답: ${dataIntegrity.warnings.join(' / ')}`);
  }

  return {
    meta: {
      query,
      preset,
      primaryLawName,
      hasAttachedDocument: Boolean(documentText),
      isOptimizedDoc: Boolean(optimizedDoc.omittedCount > 0),
      durationMs,
      dataIntegrity,
      timestamp: new Date().toISOString()
    },
    // Tab 2: 공식 근거 데이터 (Re-ranking 및 Cascading 반영)
    officialEvidence: {
      lawDetail: mainLawDetail ? {
        lawId: mainLawDetail.lawId,
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
      ordinances
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
  lawDetail, articles, precedents, interpretations, adminRules, ordinances, lawLookupFailed, primaryLawName
}) {
  const isMock = (list) => Array.isArray(list) && list.length > 0 && list.some(x => x && x.isMockData);
  const sourceOf = (list) => {
    if (!Array.isArray(list) || list.length === 0) return 'NONE';
    return isMock(list) ? 'MOCK' : 'OFFICIAL_API';
  };

  const lawSource = lawLookupFailed
    ? 'NONE'
    : (lawDetail && lawDetail.isMockData ? 'MOCK' : (lawDetail ? 'OFFICIAL_API' : 'NONE'));

  const sources = {
    law: lawSource,
    articles: lawSource === 'MOCK' ? 'MOCK' : (articles.length > 0 ? 'OFFICIAL_API' : 'NONE'),
    precedents: sourceOf(precedents),
    interpretations: sourceOf(interpretations),
    adminRules: sourceOf(adminRules),
    ordinances: sourceOf(ordinances)
  };

  const warnings = [];
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
