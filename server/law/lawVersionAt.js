import { getLawVersions, getLawDetail } from './lawApiClient.js';
import { selectVersionAt, validDate, isOfficial } from './evidence.js';

/**
 * 기준 시점에 시행 중이던 법령 버전의 공식 본문을 가져온다.
 *
 * 시점 확인에 실패하면 현행 본문으로 대체하지 않고 실패를 돌려준다.
 * '2021년 기준'이라고 표시된 검토에 현행 조문이 섞이면 검토자는 그 사실을 알 수 없고,
 * 그 상태가 조문 근거 없이 나가는 것보다 위험하다.
 *
 * @param {{lawName: string}} match - 법령명이 확정된 검색 결과
 * @param {string} asOfDate - 기준일 (YYYYMMDD 또는 YYYY-MM-DD)
 * @returns {Promise<{detail: object|null, version: object|null, reason: string}>}
 */
export async function getLawDetailAt(match, asOfDate, api = {}) {
  const clients = { getLawVersions, getLawDetail, ...api };
  const lawName = match?.lawName || '';
  const date = validDate(asOfDate);
  if (!lawName) return { detail: null, version: null, reason: '법령명이 없어 시점 본문을 조회할 수 없습니다.' };
  if (!date) return { detail: null, version: null, reason: `기준일 '${asOfDate}'이(가) 유효하지 않습니다.` };

  const versions = await clients.getLawVersions(lawName);
  const version = selectVersionAt(versions, date);
  if (!version) return { detail: null, version: null, reason: `${lawName}: ${date} 시점에 시행 중이던 버전을 확인하지 못했습니다.` };

  const detail = await clients.getLawDetail(version.lawId, version.lawSeq, { enforceDate: version.enforceDate });
  // 돌려받은 본문이 요청한 그 버전인지 확인한다. 일련번호나 시행일이 어긋나면 다른 버전이다.
  if (!isOfficial(detail) || !detail.articles?.length
    || Number(detail.lawId) !== Number(version.lawId)
    || Number(detail.lawSeq) !== Number(version.lawSeq)
    || detail.enforceDate !== version.enforceDate) {
    return { detail: null, version, reason: `${lawName}: ${date} 시점 버전(${version.enforceDate} 시행)의 공식 본문을 확인하지 못했습니다.` };
  }
  return { detail, version, reason: '' };
}

export default { getLawDetailAt };
