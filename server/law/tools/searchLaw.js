// server/law/tools/searchLaw.js
import { searchLaw } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { query, page = 1, display = 10 } = params;
  if (!query) throw new Error('query 매개변수가 필요합니다.');
  
  const results = await searchLaw(query, page, display);
  return {
    total: results.length,
    fetchStatus: results.fetchStatus || 'SUCCESS',
    message: results.unavailableReason,
    page,
    items: results
  };
}

export default { execute };
