import { getLawDetailAt } from '../lawVersionAt.js';
import { validDate, inForceAt, exactArticle } from '../evidence.js';

export async function execute({ lawName, targetDate, articleNo = '' } = {}, dependencies = {}) {
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');
  const date = validDate(targetDate);
  if (!date) throw new Error('유효한 targetDate(YYYYMMDD 또는 YYYY-MM-DD)가 필요합니다.');
  const { detail, version, reason } = await getLawDetailAt({ lawName }, date, dependencies);
  if (!detail) return { found: false, targetDate: date, message: reason };
  const articles = detail.articles.filter(a => inForceAt(a, date));
  const targetArticle = articleNo ? exactArticle(articles, articleNo) : null;
  return { found: !articleNo || Boolean(targetArticle), targetDate: date, appliedVersion: version, targetArticle: targetArticle || null,
    totalArticlesInVersion: articles.length, source: detail.source, limitations: ['부칙·경과조치에 따른 개별 사안 적용 여부는 별도 검토가 필요합니다.'] };
}
export default { execute };
