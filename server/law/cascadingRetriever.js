// server/law/cascadingRetriever.js - 3단계 체계적 연쇄 검색 (모법 ➔ 시행령 ➔ 시행규칙 ➔ 행정규칙 번들링)
import { searchLaw, getLawDetail } from './lawApiClient.js';
import { searchAdminRules } from './decisionsApiClient.js';

/**
 * 모법(법률)과 조문을 바탕으로 하위 시행령, 시행규칙, 행정규칙을 3단계 연쇄 검색
 * @param {object} params
 * @param {string} params.lawName - 기준 법률명 (예: 개인정보 보호법)
 * @param {Array<string>} params.articleNos - 핵심 조문 번호 목록 (예: ['제15조', '제25조'])
 * @returns {Promise<object>} 연쇄 법령 세트
 */
export async function retrieveCascadingHierarchy({ lawName = '', articleNos = [] }) {
  if (!lawName) return null;

  const cleanBaseName = lawName
    .replace(/(시행령|시행규칙|보호법|법률|법)$/g, '')
    .trim();

  try {
    // 1. 법률/시행령/시행규칙 검색
    const lawList = await searchLaw(cleanBaseName || lawName, 1, 6);

    const actInfo = lawList.find(l => l.lawType === '법률' || (!l.lawName.includes('시행령') && !l.lawName.includes('시행규칙'))) || lawList[0];
    const decreeInfo = lawList.find(l => l.lawName.includes('시행령') || l.lawType === '대통령령');
    const ruleInfo = lawList.find(l => l.lawName.includes('시행규칙') || l.lawType === '부령' || l.lawType === '총리령');

    // 2. 시행령 및 시행규칙 상세 조문 병렬 조회
    const [decreeDetail, ruleDetail, adminRules] = await Promise.all([
      decreeInfo ? getLawDetail(decreeInfo.lawId, decreeInfo.lawSeq).catch(() => null) : Promise.resolve(null),
      ruleInfo ? getLawDetail(ruleInfo.lawId, ruleInfo.lawSeq).catch(() => null) : Promise.resolve(null),
      searchAdminRules(cleanBaseName || lawName, 1, 3).catch(() => [])
    ]);

    // 3. 연계 하위 조문 선별
    const decreeArticles = decreeDetail?.articles ? decreeDetail.articles.slice(0, 3) : [];
    const ruleArticles = ruleDetail?.articles ? ruleDetail.articles.slice(0, 2) : [];

    return {
      baseName: cleanBaseName,
      act: actInfo ? { lawId: actInfo.lawId, lawName: actInfo.lawName, lawType: actInfo.lawType || '법률' } : null,
      decree: decreeInfo ? {
        lawId: decreeInfo.lawId,
        lawName: decreeInfo.lawName,
        lawType: decreeInfo.lawType || '대통령령',
        articles: decreeArticles
      } : null,
      rule: ruleInfo ? {
        lawId: ruleInfo.lawId,
        lawName: ruleInfo.lawName,
        lawType: ruleInfo.lawType || '부령',
        articles: ruleArticles
      } : null,
      adminRules: (adminRules || []).slice(0, 2),
      isCompleteHierarchy: Boolean(actInfo && decreeInfo)
    };
  } catch (err) {
    console.warn('[CascadingRetriever] 연쇄 검색 실패:', err.message);
    return null;
  }
}

export default {
  retrieveCascadingHierarchy
};
