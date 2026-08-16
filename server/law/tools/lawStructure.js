// server/law/tools/lawStructure.js
import { searchLaw, getLawDetail } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { lawName } = params;
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');

  const searchResults = await searchLaw(lawName, 1, 1);
  if (searchResults.length === 0) {
    return { found: false, message: `법령 [${lawName}]을 찾을 수 없습니다.` };
  }

  const detail = await getLawDetail(searchResults[0].lawId);
  if (!detail || !detail.articles) {
    return { found: false, message: `법령 상세 정보를 불러올 수 없습니다.` };
  }

  const articleSummaries = detail.articles.map(a => ({
    articleNo: a.fullArticleNo,
    title: a.title || '제목 없음',
    isDeleted: a.isDeleted || false,
    paragraphCount: a.paragraphs ? a.paragraphs.length : 0
  }));

  return {
    found: true,
    lawName: detail.lawName,
    lawId: detail.lawId,
    promulDate: detail.promulDate,
    enforceDate: detail.enforceDate,
    totalArticles: detail.articles.length,
    totalAnnexes: detail.annexes ? detail.annexes.length : 0,
    articles: articleSummaries
  };
}

export default { execute };
