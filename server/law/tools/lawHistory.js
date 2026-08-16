// server/law/tools/lawHistory.js
import { searchLaw, getLawDetail } from '../lawApiClient.js';

export async function execute(params = {}) {
  const { lawName } = params;
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');

  const searchResults = await searchLaw(lawName, 1, 10);
  const matched = searchResults.filter(l => l.lawName.includes(lawName) || lawName.includes(l.lawName));

  const historyTimeline = matched.map(m => ({
    lawName: m.lawName,
    lawId: m.lawId,
    promulDate: m.promulDate,
    promulNo: m.promulNo,
    enforceDate: m.enforceDate,
    lawType: m.lawType,
    ministry: m.ministry,
    detailUrl: m.detailUrl
  })).sort((a, b) => (b.promulDate || '').localeCompare(a.promulDate || ''));

  return {
    lawName,
    totalRevisions: historyTimeline.length,
    timeline: historyTimeline
  };
}

export default { execute };
