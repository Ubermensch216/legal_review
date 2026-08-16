// server/law/tools/searchAiLaw.js
import { searchLaw } from '../lawApiClient.js';
import { expandQueryKeywords } from '../lawTermKb.js';

export async function execute(params = {}) {
  const { query } = params;
  if (!query) throw new Error('query 매개변수가 필요합니다.');

  const kbExpansion = expandQueryKeywords(query);
  const searchPromises = [];

  // 원본 질의 검색
  searchPromises.push(searchLaw(query, 1, 5));

  // 추천 법령 및 확장 키워드로 추가 검색
  for (const item of kbExpansion.suggestedLaws.slice(0, 3)) {
    searchPromises.push(searchLaw(item.name, 1, 3));
  }
  for (const term of kbExpansion.expandedTerms.slice(0, 2)) {
    searchPromises.push(searchLaw(term, 1, 3));
  }

  const allResults = await Promise.allSettled(searchPromises);
  const lawMap = new Map();

  for (const res of allResults) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      for (const law of res.value) {
        if (!lawMap.has(law.lawId || law.lawName)) {
          lawMap.set(law.lawId || law.lawName, law);
        }
      }
    }
  }

  return {
    query,
    expandedKeywords: kbExpansion.expandedTerms,
    suggestedDomainLaws: kbExpansion.suggestedLaws,
    matchedLaws: Array.from(lawMap.values()).slice(0, 10)
  };
}

export default { execute };
