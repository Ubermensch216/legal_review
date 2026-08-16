// server/law/tools/delegatedLaws.js
import { searchLaw } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { lawName, articleNo = '' } = params;
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');

  // 모법 이름 기반으로 시행령, 시행규칙 검색
  const baseName = lawName.replace(/(시행령|시행규칙|법률|법)$/g, '').trim();
  const searchResults = await searchLaw(baseName, 1, 10);

  const hierarchy = {
    act: searchResults.find(l => l.lawType === '법률' || (!l.lawName.includes('시행령') && !l.lawName.includes('시행규칙'))),
    decree: searchResults.find(l => l.lawName.includes('시행령') || l.lawType === '대통령령'),
    rule: searchResults.find(l => l.lawName.includes('시행규칙') || l.lawType === '부령' || l.lawType === '총리령')
  };

  return {
    baseName,
    requestedArticleNo: articleNo,
    hierarchy,
    matchedLaws: searchResults
  };
}

export default { execute };
