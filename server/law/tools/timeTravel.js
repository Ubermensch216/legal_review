import { getLawVersions, getLawDetail } from '../lawApiClient.js';
import { validDate, isOfficial, exactArticle } from '../evidence.js';

export async function execute({ lawName, targetDate, articleNo = '' } = {}, dependencies = {}) {
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');
  const date = validDate(targetDate);
  if (!date) throw new Error('유효한 targetDate(YYYYMMDD 또는 YYYY-MM-DD)가 필요합니다.');
  const versions = await (dependencies.getLawVersions || getLawVersions)(lawName);
  const applicable = versions.filter(v => isOfficial(v) && validDate(v.enforceDate) && v.enforceDate <= date)
    .sort((a, b) => b.enforceDate.localeCompare(a.enforceDate) || (b.promulDate || '').localeCompare(a.promulDate || '') || Number(b.lawSeq) - Number(a.lawSeq));
  const version = applicable[0];
  if (!version) return { found: false, targetDate: date, message: '해당 시점에 시행 중인 법령 버전을 확인하지 못했습니다.' };
  const detail = await (dependencies.getLawDetail || getLawDetail)(version.lawId, version.lawSeq, { enforceDate: version.enforceDate });
  if (!isOfficial(detail) || !detail.articles?.length || Number(detail.lawId) !== Number(version.lawId) || Number(detail.lawSeq) !== Number(version.lawSeq) || detail.enforceDate !== version.enforceDate) return { found: false, targetDate: date, message: '선택한 버전의 공식 본문을 확인하지 못했습니다.' };
  const articles = detail.articles.filter(a => !a.isDeleted && (!a.enforceDate || a.enforceDate <= date));
  const targetArticle = articleNo ? exactArticle(articles, articleNo) : null;
  return { found: !articleNo || Boolean(targetArticle), targetDate: date, appliedVersion: version, targetArticle: targetArticle || null,
    totalArticlesInVersion: articles.length, source: detail.source, limitations: ['부칙·경과조치에 따른 개별 사안 적용 여부는 별도 검토가 필요합니다.'] };
}
export default { execute };
