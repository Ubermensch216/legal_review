// server/law/tools/verifyCitations.js
import { extractArticleReferences } from '../lawArticleRef.js';
import { getLawArticle } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { text, lawName = '' } = params;
  if (!text) throw new Error('text 매개변수가 필요합니다.');

  const refs = extractArticleReferences(text, lawName);
  const verificationResults = [];

  for (const ref of refs) {
    const targetLaw = ref.lawName || lawName;
    if (!targetLaw) {
      verificationResults.push({
        citation: ref.fullRef,
        status: 'UNVERIFIED',
        reason: '대상 법령명이 명시되지 않았습니다.'
      });
      continue;
    }

    try {
      const artResult = await getLawArticle(targetLaw, ref.articleNo, ref.branchNo);
      if (artResult && artResult.article) {
        if (artResult.article.isDeleted) {
          verificationResults.push({
            citation: ref.fullRef,
            status: 'DELETED',
            lawName: artResult.lawName,
            reason: '인용된 조문이 법령상 삭제되었습니다.'
          });
        } else {
          verificationResults.push({
            citation: ref.fullRef,
            status: 'VALID',
            lawName: artResult.lawName,
            articleTitle: artResult.article.title,
            reason: '현행 유효 조문입니다.'
          });
        }
      } else {
        verificationResults.push({
          citation: ref.fullRef,
          status: 'NOT_FOUND',
          lawName: targetLaw,
          reason: '법령 데이터베이스에 해당 조문이 존재하지 않습니다.'
        });
      }
    } catch (err) {
      verificationResults.push({
        citation: ref.fullRef,
        status: 'ERROR',
        reason: err.message
      });
    }
  }

  const validCount = verificationResults.filter(v => v.status === 'VALID').length;
  const invalidCount = verificationResults.filter(v => v.status === 'DELETED' || v.status === 'NOT_FOUND').length;

  return {
    totalChecked: verificationResults.length,
    validCount,
    invalidCount,
    citations: verificationResults
  };
}

export default { execute };
