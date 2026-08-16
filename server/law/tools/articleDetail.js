// server/law/tools/articleDetail.js
import { getLawArticle, getLawDetail, searchLaw } from '../lawApiClient.js';
import { normalizeArticleNo } from '../lawArticleRef.js';

export async function execute(params = {}) {
  const { lawName, articleNo, branchNo = '' } = params;
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');
  if (!articleNo) throw new Error('articleNo 매개변수가 필요합니다.');

  const normArtNo = normalizeArticleNo(articleNo);
  const result = await getLawArticle(lawName, normArtNo, branchNo);

  if (!result) {
    // 대체로 법령 상세에서 전체 조문 번호 리스트 제공
    const search = await searchLaw(lawName, 1, 1);
    let availableArticles = [];
    if (search.length > 0) {
      const detail = await getLawDetail(search[0].lawId);
      if (detail && detail.articles) {
        availableArticles = detail.articles.map(a => a.fullArticleNo).slice(0, 20);
      }
    }

    return {
      found: false,
      message: `법령 [${lawName}]에서 제${normArtNo}조를 찾을 수 없습니다.`,
      availableArticlesSample: availableArticles
    };
  }

  return {
    found: true,
    lawName: result.lawName,
    lawId: result.lawId,
    promulDate: result.promulDate,
    enforceDate: result.enforceDate,
    article: result.article
  };
}

export default { execute };
