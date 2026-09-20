import { extractArticleReferences } from '../lawArticleRef.js';
import { verifyAndCorrectReviewCitations } from '../factualityVerifier.js';

export async function execute({ text, lawName = '' } = {}) {
  if (!text) throw new Error('text 매개변수가 필요합니다.');
  const refs = extractArticleReferences(text, lawName);
  const legalBasis = refs.map(ref => ({ lawName: ref.lawName || lawName, articleNo: ref.fullRef.replace(ref.lawName, '').trim() }));
  const { verificationReport } = await verifyAndCorrectReviewCitations({ review: { legalBasis }, workbenchContext: {} });
  return { ...verificationReport, citations: verificationReport.details };
}
export default { execute };
