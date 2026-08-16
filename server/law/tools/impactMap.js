// server/law/tools/impactMap.js
import { extractArticleReferences } from '../lawArticleRef.js';
import { searchLaw, getLawArticle } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { documentText, targetLaw = '' } = params;
  if (!documentText) throw new Error('documentText 매개변수가 필요합니다.');

  // 1. 문서 내 조문 인용구 추출
  const refs = extractArticleReferences(documentText, targetLaw);
  const impactItems = [];

  for (const ref of refs.slice(0, 10)) {
    const lawName = ref.lawName || targetLaw;
    if (!lawName) continue;

    try {
      const artResult = await getLawArticle(lawName, ref.articleNo, ref.branchNo);
      if (artResult && artResult.article) {
        impactItems.push({
          citation: ref.fullRef,
          lawName: artResult.lawName,
          articleNo: ref.fullArticleNo,
          articleTitle: artResult.article.title,
          isDeleted: artResult.article.isDeleted || false,
          currentTextSnippet: (artResult.article.content || '').slice(0, 150) + '...',
          riskLevel: artResult.article.isDeleted ? 'HIGH' : 'NORMAL',
          note: artResult.article.isDeleted ? '인용된 조문이 현재 삭제/폐지 상태입니다.' : '현행 유효 조문과 일치합니다.'
        });
      } else {
        impactItems.push({
          citation: ref.fullRef,
          lawName,
          articleNo: ref.fullArticleNo,
          riskLevel: 'CAUTION',
          note: '공식 법령 데이터베이스에서 해당 조문을 확인하지 못했습니다.'
        });
      }
    } catch {
      // ignore
    }
  }

  const highRiskCount = impactItems.filter(i => i.riskLevel === 'HIGH').length;

  return {
    analyzedReferencesCount: refs.length,
    impactSummary: {
      total: impactItems.length,
      highRiskCount,
      overallStatus: highRiskCount > 0 ? 'WARNING_DETECTED' : 'CLEAR'
    },
    impactItems
  };
}

export default { execute };
