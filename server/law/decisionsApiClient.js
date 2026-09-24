import { ENV } from '../env.js';
import { LAW_CONFIG } from './lawConfig.js';
import { parsePrecedents, parseInterpretations, parseAdminRules, parseOrdinances, parseOrdinanceDetail, parseAdminRuleDetail,
  parsePrecedentDetail, parseInterpretationDetail, publicDetailUrl } from './decisionsApiParser.js';
import { getCache, setCache } from './lawCache.js';
import { isOfficial, unavailableList, normalizedLawName } from './evidence.js';
import { DecisionDataError } from './decisionDiagnostics.js';

async function fetchXml(base, params) {
  const url = `${base}?${new URLSearchParams({ OC: ENV.LAW_OC, type: 'XML', ...params })}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(LAW_CONFIG.TIMEOUT_MS), headers: { Accept: 'application/xml' } });
    if (!response.ok) throw new DecisionDataError(`HTTP_${response.status}`, `법률 자료 조회 HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    if (err instanceof DecisionDataError) throw err;
    const timeout = ['TimeoutError', 'AbortError'].includes(err.name);
    throw new DecisionDataError(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', timeout ? '법률 자료 조회 시간 초과' : '법률 자료 연결 실패');
  }
}

async function detail(target, id, parse) {
  if (!/^\d+$/.test(String(id || ''))) throw new Error('유효한 본문 일련번호가 필요합니다.');
  const key = `v2:${target}:detail:${id}`;
  const cached = await getCache(key);
  if (isOfficial(cached) && cached.contentStatus === 'FULL_TEXT') return cached;
  if (!ENV.LAW_OC) throw new Error('LAW_OC 미설정으로 본문 조회 불가');
  const result = parse(await fetchXml(LAW_CONFIG.LAW_SERVICE_BASE_URL, { target, ID: id }));
  if (String(result.id) !== String(id)) throw new DecisionDataError('RECORD_ID_MISMATCH', '목록과 본문 일련번호가 일치하지 않습니다.');
  const value = { ...result, source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT', retrievedAt: new Date().toISOString() };
  await setCache(key, value, LAW_CONFIG.CACHE_TTL.PRECEDENT_DETAIL, target);
  return value;
}
export const getPrecedentDetail = id => detail('prec', id, parsePrecedentDetail);
export const getInterpretationDetail = id => detail('expc', id, parseInterpretationDetail);

async function search(target, query, page, display, parse, mock, loadDetail, extraParams = {}) {
  if (!String(query || '').trim()) return [];
  display = Math.min(100, Math.max(1, Number(display) || 10));
  page = Math.max(1, Number(page) || 1);
  const trimmed = String(query).trim();
  const scope = extraParams.search ? `:s${extraParams.search}` : '';
  const key = `v2:${target}:list:${trimmed}:${page}:${display}${scope}`;
  let items = await getCache(key);
  // 빈 배열은 캐시 적중으로 취급하지 않는다. []는 .every()가 항상 참이므로
  // 과거의 파싱 실패나 일시적 장애로 저장된 빈 결과가 TTL 내내 재조회를 막았다.
  if (!Array.isArray(items) || items.length === 0 || !items.every(isOfficial)) {
    if (!ENV.LAW_OC) return ENV.LAW_DEMO_MODE ? mock(trimmed) : unavailableList('UNAVAILABLE', 'LAW_OC 미설정');
    try {
      items = parse(await fetchXml(LAW_CONFIG.LAW_DRF_BASE_URL, { target, query: trimmed, page, display, ...extraParams })).map(item => ({ ...item, source: 'OFFICIAL_API', contentStatus: 'LIST_ONLY', retrievedAt: new Date().toISOString() }));
      // 빈 결과는 저장하지 않는다. (다음 호출에서 정상적으로 재조회되도록)
      if (items.length) await setCache(key, items, LAW_CONFIG.CACHE_TTL.LAW_SEARCH, target);
    } catch (err) { return unavailableList('ERROR', err.message); }
  }
  // 이전 버전 캐시에 API 계정 식별자가 들어간 링크가 남아 있어도 클라이언트로 보내지 않는다.
  items = items.map(item => item.detailUrl ? { ...item, detailUrl: publicDetailUrl(item.detailUrl) } : item);
  if (!loadDetail) return items;
  const enriched = [];
  for (let i = 0; i < items.length; i += 3) {
    enriched.push(...await Promise.all(items.slice(i, i + 3).map(async item => {
      try {
        const body = await loadDetail(item.id);
        // A detail may list consolidated cases while search exposes only the lead case.
        // The detail loader has already checked the exact official record ID.
        const leadCase = value => String(value || '').split(/[,，]/)[0].replace(/\s+/g, '');
        if (item.caseNo && leadCase(body.caseNo) !== leadCase(item.caseNo)) throw new DecisionDataError('CASE_NUMBER_MISMATCH', '판례 사건번호 불일치');
        return { ...item, ...body };
      } catch (err) { return { ...item, contentStatus: 'LIST_ONLY', summary: '', holding: '', answer: '', reason: '', detailError: err.message, detailErrorCode: err.code || 'BODY_FETCH_FAILED' }; }
    })));
  }
  return enriched;
}
/**
 * 판례 검색. DRF 기본 검색(search=1)은 '사건명'만 대조하므로
 * "공유재산 대부료 감정평가" 같은 주제어 질의는 사실상 항상 0건이 된다.
 * 결과가 없으면 본문검색(search=2)으로 재시도한다.
 */
export async function searchPrecedents(q, p = 1, d = 10) {
  const byCaseName = await search('prec', q, p, d, parsePrecedents, getMockPrecedents, getPrecedentDetail);
  if (Array.isArray(byCaseName) && byCaseName.length > 0) return byCaseName;
  const byFullText = await search('prec', q, p, d, parsePrecedents, getMockPrecedents, getPrecedentDetail, { search: 2 });
  // 본문검색도 비었으면 원래 결과(상태 플래그 포함)를 그대로 돌려준다.
  return Array.isArray(byFullText) && byFullText.length > 0 ? byFullText : byCaseName;
}
export const searchInterpretations = (q, p = 1, d = 10) => search('expc', q, p, d, parseInterpretations, getMockInterpretations, getInterpretationDetail);
/** 본문 조회 전 적합성 선별에 사용하는 공식 목록. 기존 본문 포함 검색 API와 분리한다. */
export async function searchPrecedentCandidates(q, p = 1, d = 10) {
  const byCaseName = await search('prec', q, p, d, parsePrecedents, getMockPrecedents, null);
  if (Array.isArray(byCaseName) && byCaseName.length > 0) return byCaseName;
  const byFullText = await search('prec', q, p, d, parsePrecedents, getMockPrecedents, null, { search: 2 });
  return Array.isArray(byFullText) && byFullText.length > 0 ? byFullText : byCaseName;
}
export const searchInterpretationCandidates = (q, p = 1, d = 10) => search('expc', q, p, d, parseInterpretations, getMockInterpretations, null);
export const searchAdminRules = (q, p = 1, d = 10) => search('admrul', q, p, d, parseAdminRules, getMockAdminRules);
export const searchOrdinances = (q, p = 1, d = 10) => search('ordin', q, p, d, parseOrdinances, getMockOrdinances);

/**
 * 행정규칙 본문(조문 + 별표 목록) 조회.
 * 별표 본문은 국가법령정보센터가 첨부파일로만 제공하므로 링크를 함께 돌려준다.
 */
export async function getAdminRuleDetail(id, { expectedName = '' } = {}) {
  if (!/^\d+$/.test(String(id || ''))) throw new DecisionDataError('INVALID_ID', '유효한 행정규칙 일련번호가 필요합니다.');
  const verify = record => {
    if (String(record.id) !== String(id)) throw new DecisionDataError('RECORD_ID_MISMATCH', '목록과 본문 일련번호가 일치하지 않습니다.');
    if (expectedName && normalizedLawName(record.name) !== normalizedLawName(expectedName)) {
      throw new DecisionDataError('ADMIN_RULE_NAME_MISMATCH', `요청한 행정규칙(${expectedName})과 본문(${record.name})이 일치하지 않습니다.`);
    }
    return record;
  };

  const key = `v2:admrul:detail:${id}`;
  const cached = await getCache(key);
  if (isOfficial(cached) && cached.contentStatus === 'FULL_TEXT' && cached.articles?.length) return verify(cached);
  if (!ENV.LAW_OC) throw new DecisionDataError('UNAVAILABLE', 'LAW_OC 미설정으로 본문 조회 불가');

  const result = verify(parseAdminRuleDetail(await fetchXml(LAW_CONFIG.LAW_SERVICE_BASE_URL, { target: 'admrul', ID: id })));
  const value = { ...result, source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT', retrievedAt: new Date().toISOString() };
  if (value.articles.length) await setCache(key, value, LAW_CONFIG.CACHE_TTL.LAW_SEARCH, 'admrul');
  return value;
}

/**
 * 자치법규 본문(조문) 조회. 목록의 일련번호(MST)를 사용한다.
 * 요청한 자치법규와 응답이 일치할 때만 반환한다. (다른 자치법규의 조문이 섞이는 것을 방지)
 */
export async function getOrdinanceDetail(seq, { expectedName = '' } = {}) {
  if (!/^\d+$/.test(String(seq || ''))) throw new DecisionDataError('INVALID_ID', '유효한 자치법규 일련번호가 필요합니다.');

  // 이름 대조는 캐시 적중 경로에도 반드시 적용한다.
  // (다른 자치법규의 조문이 요청한 이름으로 표기되는 교차 오표기 방지)
  const verify = record => {
    if (String(record.id) !== String(seq)) throw new DecisionDataError('RECORD_ID_MISMATCH', '목록과 본문 일련번호가 일치하지 않습니다.');
    if (expectedName && normalizedLawName(record.lawName) !== normalizedLawName(expectedName)) {
      throw new DecisionDataError('ORDINANCE_NAME_MISMATCH', `요청한 자치법규(${expectedName})와 본문(${record.lawName})이 일치하지 않습니다.`);
    }
    return record;
  };

  const key = `v2:ordin:detail:${seq}`;
  const cached = await getCache(key);
  if (isOfficial(cached) && cached.contentStatus === 'FULL_TEXT' && cached.articles?.length) return verify(cached);
  if (!ENV.LAW_OC) throw new DecisionDataError('UNAVAILABLE', 'LAW_OC 미설정으로 본문 조회 불가');

  const result = verify(parseOrdinanceDetail(await fetchXml(LAW_CONFIG.LAW_SERVICE_BASE_URL, { target: 'ordin', MST: seq })));
  const value = { ...result, source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT', retrievedAt: new Date().toISOString() };
  if (value.articles.length) await setCache(key, value, LAW_CONFIG.CACHE_TTL.LAW_SEARCH, 'ordin');
  return value;
}

function markMock(items) {
  return items.map(item => ({ ...item, isMockData: true }));
}

function getMockPrecedents(query) {
  return markMock([
    {
      id: '210452',
      caseNo: '2021다247854',
      caseName: '손해배상(기)',
      courtName: '대법원',
      judgeDate: '2022.06.30',
      caseType: '민사',
      judgeType: '판결',
      holding: '정보주체의 동의 없이 수집한 개인정보의 제3자 제공 시 손해배상 책임의 성립 요건',
      summary: '개인정보 보호법 제15조 및 제17조 위반 시 정보주체에게 발생한 정신적 손해에 대해 상당인과관계가 인정되는 한 위자료 배상책임이 인정된다.',
      detailUrl: 'http://www.law.go.kr/판례/2021다247854'
    },
    {
      id: '198751',
      caseNo: '2019두51234',
      caseName: '시정명령등처분취소',
      courtName: '대법원',
      judgeDate: '2020.11.26',
      caseType: '행정',
      judgeType: '판결',
      holding: '지자체 조례가 상위 법령의 위임 범위를 벗어나 주민의 권리를 제한한 경우 그 효력(무효)',
      summary: '법률의 위임 없이 주민의 권리를 제한하거나 의무를 부과하는 조례 규정은 지방자치법 제28조 단서에 위배되어 효력이 없다.',
      detailUrl: 'http://www.law.go.kr/판례/2019두51234'
    }
  ]);
}

function getMockInterpretations(query) {
  return markMock([
    {
      id: '98452',
      itemNo: '21-0342',
      title: '개인정보 보호법 제15조 제1항 제4호의 계약 체결 및 이행에 불가피한 경우의 해석',
      orgName: '법제처',
      replyDate: '2021.08.12',
      question: '온라인 회원 가입 시 서비스 제공에 필수적인 최소한의 정보 수집에 별도의 동의가 필요한지 여부',
      answer: '계약의 체결 및 이행을 위하여 불가피하게 필요한 정보에 대해서는 법 제15조제1항제4호에 따라 별도의 동의 없이 수집·이용할 수 있다.',
      reason: '법률 규정의 문언상 계약 당사자의 명확한 의사에 부합하는 범위 내에서는 동의권 남용을 방지하기 위함이다.',
      detailUrl: 'http://www.law.go.kr/해석례/21-0342'
    }
  ]);
}

function getMockAdminRules(query) {
  return markMock([
    {
      id: '8910',
      name: '개인정보의 안전성 확보조치 기준',
      ruleType: '고시',
      ministry: '개인정보보호위원회',
      enforceDate: '2023.09.22',
      promulDate: '2023.09.22',
      detailUrl: 'http://www.law.go.kr/행정규칙/개인정보의안전성확보조치기준'
    }
  ]);
}

function getMockOrdinances(query) {
  return markMock([
    {
      id: '54321',
      name: '서울특별시 개인정보 보호에 관한 조례',
      orgName: '서울특별시',
      ruleType: '조례',
      enforceDate: '2023.05.18',
      detailUrl: 'http://www.law.go.kr/자치법규/서울특별시개인정보보호에관한조례'
    }
  ]);
}


export default { searchPrecedents, searchInterpretations, searchPrecedentCandidates, searchInterpretationCandidates,
  searchAdminRules, searchOrdinances, getOrdinanceDetail, getAdminRuleDetail, getPrecedentDetail, getInterpretationDetail };
