// server/law/tools/precedents.js
import { searchPrecedents } from '../decisionsApiClient.js';

export async function execute(params = {}) {
  const { query, display = 10 } = params;
  if (!query) throw new Error('query 매개변수가 필요합니다.');

  const results = await searchPrecedents(query, 1, display);
  return {
    query,
    total: results.length,
    items: results
  };
}

export default { execute };
