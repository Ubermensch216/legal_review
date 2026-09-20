import { normalizeArticleNo } from './lawArticleRef.js';
import { getLawArticle } from './lawApiClient.js';
import { sameLaw, isOfficial, exactArticle, containsCitation, validDate, today } from './evidence.js';

/** Checks citation existence, not the correctness of a legal conclusion. Never substitutes citations. */
export async function verifyAndCorrectReviewCitations({ review, workbenchContext = {}, lookupArticle = getLawArticle }) {
  if (!review) return { verifiedReview: review, verificationReport: null };
  const evidence = workbenchContext.officialEvidence || {};
  const primaryLaw = workbenchContext.meta?.primaryLawName || '';
  const asOf = validDate(workbenchContext.meta?.targetDate) || today();
  const lawDetail = evidence.lawDetail;
  const basisIsMock = workbenchContext.meta?.dataIntegrity?.sources?.articles === 'MOCK';
  const legalBasis = (Array.isArray(review.legalBasis) ? review.legalBasis : []).map(item => ({ ...item }));
  let hasOfficialBasis = !basisIsMock && isOfficial(lawDetail) && (evidence.articles || []).length > 0;
  const details = [];

  const validMatch = (result, item, number, lawName) => {
    if (!isOfficial(result) || !sameLaw(result.lawName, lawName)) return false;
    if (item.lawId && Number(item.lawId) !== Number(result.lawId)) return false;
    if (item.lawSeq && Number(item.lawSeq) !== Number(result.lawSeq)) return false;
    if (item.enforceDate && validDate(item.enforceDate) !== validDate(result.enforceDate)) return false;
    const effective = validDate(result.article?.enforceDate || result.enforceDate);
    if (!effective || effective > asOf) return false;
    return normalizeArticleNo(result.article?.fullArticleNo || result.article?.articleNo) === number && containsCitation(result.article, String(item.articleNo || ''));
  };

  for (const item of legalBasis) {
    const lawName = item.lawName || primaryLaw;
    const raw = String(item.articleNo || '');
    const number = normalizeArticleNo(raw);
    let verified = false;
    // Ranges and compound citations need separate entries; do not validate just the first number.
    if (lawName && /^\d+(?:의\d+)?$/.test(number) && !/[~,]|및|부터/.test(raw) && !basisIsMock) {
      const candidates = (evidence.articles || []).filter(a => sameLaw(a.lawName || lawDetail?.lawName || primaryLaw, lawName));
      const article = exactArticle(candidates, number);
      const local = article ? { ...lawDetail, ...article, lawName: article.lawName || lawDetail?.lawName || primaryLaw, article } : null;
      if (isOfficial(local)) hasOfficialBasis = true;
      verified = validMatch(local, item, number, lawName);
      if (!verified) {
        try {
          const [mainNo, branchNo = ''] = number.split('의');
          // A historical citation cannot be verified against a current-law endpoint.
          if (!workbenchContext.meta?.targetDate && !item.lawSeq && !item.enforceDate) {
            const result = await lookupArticle(lawName, mainNo, branchNo);
            if (isOfficial(result)) hasOfficialBasis = true;
            verified = validMatch(result, item, number, lawName);
          }
        } catch { /* Preserve the citation and explicitly leave it unverified. */ }
      }
    }
    item.verificationStatus = verified ? 'VERIFIED' : 'UNVERIFIED';
    item.verificationNote = verified
      ? '공식 출처에서 해당 법령·조문 존재를 확인했습니다. 법적 적용 타당성은 별도 검토 대상입니다.'
      : '해당 법령·버전·조문을 공식 출처로 확인하지 못했습니다. 원문 확인이 필요합니다.';
    details.push({ lawName, articleNo: raw, status: item.verificationStatus, reason: item.verificationNote });
  }
  const validCount = details.filter(d => d.status === 'VERIFIED').length;
  const totalChecked = details.length;
  const isMeasurable = totalChecked > 0 && hasOfficialBasis;
  const report = {
    metric: 'OFFICIAL_CITATION_EXISTENCE', scope: 'legalBasis', totalChecked, validCount,
    invalidCount: 0, // Unavailable evidence is not proof that the citation is nonexistent.
    unverifiedCount: totalChecked - validCount, correctionsCount: 0,
    citationConfidence: isMeasurable ? Math.round(validCount / totalChecked * 100) : null,
    isMeasurable, unmeasurableReason: isMeasurable ? undefined : '공식 대조 자료 또는 검증 대상 인용이 없습니다.',
    details, correctionsApplied: [], unverifiedCitations: details.filter(d => d.status !== 'VERIFIED')
  };
  const verifiedReview = { ...review, legalBasis, factualityVerification: report,
    ...(review.reviewStatus === 'COMPLETE' && (!totalChecked || report.unverifiedCount > 0) ? { reviewStatus: 'PARTIAL' } : {}) };
  return { verifiedReview, verificationReport: report };
}
export default { verifyAndCorrectReviewCitations };
