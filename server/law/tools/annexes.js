// server/law/tools/annexes.js
import { searchLaw, getLawDetail } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { lawName } = params;
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');

  const searchResults = await searchLaw(lawName, 1, 1);
  if (searchResults.length === 0) {
    return { found: false, message: `법령 [${lawName}]을 찾을 수 없습니다.` };
  }

  const detail = await getLawDetail(searchResults[0].lawId);
  const annexes = (detail && detail.annexes) || [];

  return {
    found: true,
    lawName: (detail && detail.lawName) || lawName,
    total: annexes.length,
    annexes
  };
}

export default { execute };
