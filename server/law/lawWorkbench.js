// server/law/lawWorkbench.js - 종합 법령 워크벤치 오케스트레이터
import { expandQueryKeywords } from './lawTermKb.js';
import { extractArticleReferences, normalizeArticleNo } from './lawArticleRef.js';
import { searchLaw, getLawDetail, getLawArticle } from './lawApiClient.js';
import { searchPrecedents, searchInterpretations, searchAdminRules, searchOrdinances } from './decisionsApiClient.js';
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

  // 1. 키워드 및 도메인 지식베이스 확장
  const kbResult = expandQueryKeywords(fullContextText);
  const explicitRefs = extractArticleReferences(fullContextText, targetLaw);

  // 2. 검색 대상 주요 법령 결정
  let primaryLawName = targetLaw;
  let primaryArticles = [];

  if (!primaryLawName) {
    if (explicitRefs.length > 0 && explicitRefs[0].lawName) {
      primaryLawName = explicitRefs[0].lawName;
    } else if (kbResult.suggestedLaws.length > 0) {
      primaryLawName = kbResult.suggestedLaws[0].name;
    }
  }

  // 3. 주요 법령 검색 및 상세 조문 조회
  let mainLawDetail = null;
  if (primaryLawName) {
    const searchRes = await searchLaw(primaryLawName, 1, 3);
    if (searchRes.length > 0) {
      primaryLawName = searchRes[0].lawName;
      mainLawDetail = await getLawDetail(searchRes[0].lawId, searchRes[0].lawSeq);
    }
  } else {
    // 질의어 자체로 법령 검색
    const generalSearch = await searchLaw(query || '개인정보 보호법', 1, 3);
    if (generalSearch.length > 0) {
      primaryLawName = generalSearch[0].lawName;
      mainLawDetail = await getLawDetail(generalSearch[0].lawId, generalSearch[0].lawSeq);
    }
  }

  // 4. 관련 조문 핀포인트 추출
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
    
    // 조문이 매칭되지 않았으면 앞부분 주요 조문 3~5개 제공
    if (collectedArticles.length === 0) {
      collectedArticles.push(...mainLawDetail.articles.slice(0, 4));
    }
  }

  // 5. 병렬 조회: 판례, 유권해석례, 행정규칙, 자치법규, 3단체계, 별표
  const searchQuery = primaryLawName ? `${primaryLawName} ${query}`.trim() : query;

  const [precRes, expcRes, admrulRes, ordinRes, hierarchyRes, impactRes] = await Promise.allSettled([
    searchPrecedents(searchQuery, 1, 5),
    searchInterpretations(searchQuery, 1, 5),
    searchAdminRules(primaryLawName || query, 1, 5),
    searchOrdinances(primaryLawName || query, 1, 5),
    primaryLawName ? runTool('delegatedLaws', { lawName: primaryLawName }) : Promise.resolve(null),
    documentText ? runTool('impactMap', { documentText, targetLaw: primaryLawName }) : Promise.resolve(null)
  ]);

  const precedents = precRes.status === 'fulfilled' ? precRes.value : [];
  const interpretations = expcRes.status === 'fulfilled' ? expcRes.value : [];
  const adminRules = admrulRes.status === 'fulfilled' ? admrulRes.value : [];
  const ordinances = ordinRes.status === 'fulfilled' ? ordinRes.value : [];
  const hierarchy = hierarchyRes.status === 'fulfilled' && hierarchyRes.value ? hierarchyRes.value.result : null;
  const impactMap = impactRes.status === 'fulfilled' && impactRes.value ? impactRes.value.result : null;

  const annexes = (mainLawDetail && mainLawDetail.annexes) ? mainLawDetail.annexes : [];

  const durationMs = Date.now() - startTime;

  return {
    meta: {
      query,
      preset,
      primaryLawName,
      hasAttachedDocument: Boolean(documentText),
      durationMs,
      timestamp: new Date().toISOString()
    },
    // Tab 2: 공식 근거 데이터
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
      hierarchy,
      precedents,
      interpretations,
      adminRules,
      ordinances
    },
    // Tab 3: 개정 및 영향 분석 데이터
    impactAndRevisions: {
      impactMap,
      extractedReferences: explicitRefs,
      expandedKeywords: kbResult.expandedTerms
    }
  };
}

export default {
  buildWorkbenchContext
};
