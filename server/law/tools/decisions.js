// server/law/tools/decisions.js
import { searchPrecedents, searchInterpretations } from '../decisionsApiClient.js';

export async function execute(params = {}) {
  const { query, display = 10 } = params;
  if (!query) throw new Error('query 매개변수가 필요합니다.');

  // 판례 및 유권해석례 동시 조회
  const [precResults, expcResults] = await Promise.allSettled([
    searchPrecedents(query, 1, display),
    searchInterpretations(query, 1, display)
  ]);

  const precedents = precResults.status === 'fulfilled' ? precResults.value : [];
  const interpretations = expcResults.status === 'fulfilled' ? expcResults.value : [];

  return {
    query,
    totalPrecedents: precedents.length,
    totalInterpretations: interpretations.length,
    precedents,
    interpretations
  };
}

export default { execute };
