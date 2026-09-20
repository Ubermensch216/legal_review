import { getLawVersions } from '../lawApiClient.js';

export async function execute({ lawName } = {}, dependencies = {}) {
  if (!lawName) throw new Error('lawName 매개변수가 필요합니다.');
  const timeline = await (dependencies.getLawVersions || getLawVersions)(lawName);
  timeline.sort((a, b) => (b.enforceDate || '').localeCompare(a.enforceDate || '') || (b.promulDate || '').localeCompare(a.promulDate || ''));
  return { lawName, totalRevisions: timeline.length, timeline, source: timeline.length ? 'OFFICIAL_API' : 'NONE', complete: true };
}
export default { execute };
