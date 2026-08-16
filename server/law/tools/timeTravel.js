// server/law/tools/timeTravel.js
import { searchLaw, getLawDetail } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { lawName, targetDate, articleNo = '' } = params;
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');
  if (!targetDate) throw new Error('targetDate(YYYYMMDD) 매개변수가 필요합니다.');

  const cleanDate = targetDate.replace(/[^0-9]/g, '');
  const searchResults = await searchLaw(lawName, 1, 10);

  // 대상 일자 이전에 공포/시행된 개정본 필터링
  const applicable = searchResults
    .filter(l => (l.enforceDate && l.enforceDate.replace(/[^0-9]/g, '') <= cleanDate) ||
                 (l.promulDate && l.promulDate.replace(/[^0-9]/g, '') <= cleanDate))
    .sort((a, b) => (b.enforceDate || '').localeCompare(a.enforceDate || ''));

  if (applicable.length === 0) {
    return {
      found: false,
      message: `지정하신 일자(${targetDate}) 시점의 [${lawName}] 유효 법령을 찾을 수 없습니다.`
    };
  }

  const targetVersion = applicable[0];
  const detail = await getLawDetail(targetVersion.lawId, targetVersion.lawSeq);

  let targetArticle = null;
  if (articleNo && detail && detail.articles) {
    targetArticle = detail.articles.find(a => a.fullArticleNo === String(articleNo) || a.articleNo === String(articleNo));
  }

  return {
    found: true,
    targetDate: cleanDate,
    appliedVersion: {
      lawName: targetVersion.lawName,
      lawId: targetVersion.lawId,
      promulDate: targetVersion.promulDate,
      promulNo: targetVersion.promulNo,
      enforceDate: targetVersion.enforceDate,
      ministry: targetVersion.ministry
    },
    targetArticle: targetArticle || null,
    totalArticlesInVersion: detail && detail.articles ? detail.articles.length : 0
  };
}

export default { execute };
