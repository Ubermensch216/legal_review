// server/law/tools/linkedOrdinances.js
import { searchOrdinances } from '../decisionsApiClient.js';

export async function execute(params = {}) {
  const { lawName, region = '' } = params;
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');

  const query = region ? `${region} ${lawName}` : lawName;
  const results = await searchOrdinances(query, 1, 15);

  return {
    lawName,
    region,
    total: results.length,
    items: results
  };
}

export default { execute };
