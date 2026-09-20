// server/law/factualityVerifier.js - 조문 실존성 자동 검증기 및 환각 방지 엔진 (Anti-Hallucination)
import { extractArticleReferences, normalizeArticleNo } from './lawArticleRef.js';
import { getLawArticle } from './lawApiClient.js';

/**
 * LLM이 생성한 법률 검토 결과의 인용 조문 실존성 검증 및 오인용 자동 교정
 * @param {object} params
 * @param {object} params.review - LLM 생성 검토 결과 객체
 * @param {object} params.workbenchContext - 워크벤치 수집 데이터
 * @returns {Promise<{ verifiedReview: object, verificationReport: object }>}
 */
export async function verifyAndCorrectReviewCitations({ review, workbenchContext }) {
  if (!review) return { verifiedReview: review, verificationReport: null };

  const primaryLaw = workbenchContext?.meta?.primaryLawName || '관련 법령';
  const officialArticles = workbenchContext?.officialEvidence?.articles || [];

  // 대조 기준이 목업이면 검증 자체가 성립하지 않는다.
  // 목업 조문을 기준으로 '검증 완료 100%'를 찍던 동작을 막는다.
  const basisIsMock = Boolean(workbenchContext?.meta?.dataIntegrity?.sources?.articles === 'MOCK');
  if (basisIsMock) {
    const report = {
      totalChecked: Array.isArray(review.legalBasis) ? review.legalBasis.length : 0,
      validCount: 0,
      invalidCount: 0,
      correctionsCount: 0,
      unverifiedCount: Array.isArray(review.legalBasis) ? review.legalBasis.length : 0,
      citationConfidence: null,
      isMeasurable: false,
      unmeasurableReason: '대조 기준 조문이 공식 법령 API 데이터가 아니어서 인용 검증을 수행할 수 없습니다.',
      details: [],
      correctionsApplied: [],
      unverifiedCitations: []
    };
    review.factualityVerification = report;
    return { verifiedReview: review, verificationReport: report };
  }

  // 공식 수집된 유효 조문 맵 (예: "제25조" -> { title, content, ... })
  const validArticleMap = new Map();
  officialArticles.forEach(art => {
    const key = `제${art.fullArticleNo || art.articleNo}조`;
    validArticleMap.set(key, art);
    validArticleMap.set(String(art.articleNo), art);
    validArticleMap.set(String(art.fullArticleNo), art);
  });

  const legalBasis = Array.isArray(review.legalBasis) ? [...review.legalBasis] : [];
  const correctionsApplied = [];
  const unverifiedCitations = [];
  const verificationDetails = [];

  let validCount = 0;
  let invalidCount = 0;

  for (let i = 0; i < legalBasis.length; i++) {
    const item = legalBasis[i];
    const targetLaw = item.lawName || primaryLaw;
    const rawArtNo = item.articleNo || '';
    const normArtNo = normalizeArticleNo(rawArtNo);
    const fullArtKey = normArtNo.startsWith('제') ? normArtNo : `제${normArtNo}조`;

    // 1. 이미 워크벤치에 수집된 공식 조문과 대조
    if (validArticleMap.has(fullArtKey) || validArticleMap.has(normArtNo)) {
      const matched = validArticleMap.get(fullArtKey) || validArticleMap.get(normArtNo);
      validCount++;
      verificationDetails.push({
        lawName: targetLaw,
        articleNo: fullArtKey,
        title: matched.title || item.title,
        status: 'VERIFIED',
        confidence: 100
      });
      // 공식 명칭으로 정규화 보완
      if (matched.title && (!item.title || item.title.includes('조문'))) {
        item.title = matched.title;
      }
      continue;
    }

    // 2. 워크벤치에 없는 경우 조문 번호 번호 파싱 후 API 검증 시도
    const artNumMatch = rawArtNo.match(/(\d+)(?:의(\d+))?/);
    if (artNumMatch) {
      const artNo = parseInt(artNumMatch[1], 10);
      const branchNo = artNumMatch[2] ? parseInt(artNumMatch[2], 10) : 0;

      try {
        const artResult = await getLawArticle(targetLaw, artNo, branchNo);
        if (artResult && artResult.article && !artResult.article.isDeleted) {
          validCount++;
          verificationDetails.push({
            lawName: targetLaw,
            articleNo: fullArtKey,
            title: artResult.article.title,
            status: 'VERIFIED',
            confidence: 95
          });
          item.title = artResult.article.title || item.title;
          continue;
        }
      } catch {
        // API 조회 실패 시 아래 오인용 교정으로 진행
      }
    }

    // 3. 검증에 실패한 인용은 UNVERIFIED로 표시한다.
    //
    // 과거에는 officialArticles[Math.min(i, ...)] 로 '배열 순번상' 아무 조문이나
    // 골라 인용을 바꿔치기하고 AUTO_CORRECTED(신뢰도 90)로 통과시켰다.
    // 의미적 근거가 전혀 없는 치환이라, 환각 인용이 '다른 틀린 인용'으로
    // 바뀐 뒤 검증을 통과한 것처럼 표시되는 결과를 낳았다.
    // 지금은 원본 인용을 그대로 두고 검증 실패 사실만 드러낸다.
    invalidCount++;
    item.verificationStatus = 'UNVERIFIED';
    item.verificationNote = officialArticles.length > 0
      ? '수집된 공식 조문 및 법령 API에서 확인되지 않은 인용입니다. 원문을 직접 확인하십시오.'
      : '공식 조문을 수집하지 못해 검증할 수 없는 인용입니다. 원문을 직접 확인하십시오.';

    unverifiedCitations.push({
      lawName: targetLaw,
      articleNo: rawArtNo,
      title: item.title,
      reason: item.verificationNote
    });

    verificationDetails.push({
      lawName: targetLaw,
      articleNo: rawArtNo,
      title: item.title,
      status: 'UNVERIFIED',
      confidence: 0
    });
  }

  const totalChecked = legalBasis.length;

  // 검증된 인용의 실제 비율. 과거에는 Math.min(Math.max(x, 80), 99) 로 묶여 있어
  // 인용이 전부 환각이어도 80% 미만이 나올 수 없었고, 검증할 인용이 하나도 없으면
  // 기본값 95%가 표시됐다. 두 경우 모두 측정값이 아니므로 제거한다.
  const citationConfidence = totalChecked > 0
    ? Math.round((validCount / totalChecked) * 100)
    : null; // 검증 대상이 없으면 '측정 불가'

  const verificationReport = {
    totalChecked,
    validCount,
    invalidCount,
    correctionsCount: correctionsApplied.length,
    unverifiedCount: unverifiedCitations.length,
    citationConfidence,
    isMeasurable: totalChecked > 0,
    details: verificationDetails,
    correctionsApplied,
    unverifiedCitations
  };

  review.legalBasis = legalBasis;
  review.factualityVerification = verificationReport;

  return {
    verifiedReview: review,
    verificationReport
  };
}

export default {
  verifyAndCorrectReviewCitations
};
