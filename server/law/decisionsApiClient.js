// server/law/decisionsApiClient.js - 판례, 법령해석례, 행정규칙, 자치법규 오픈API 클라이언트
import { ENV } from '../env.js';
import { LAW_CONFIG } from './lawConfig.js';
import { parsePrecedents, parseInterpretations, parseAdminRules, parseOrdinances } from './decisionsApiParser.js';
import { getCache, setCache } from './lawCache.js';
import { LawApiError, maskLawSecrets } from './lawErrors.js';

async function fetchXml(url, timeoutMs = LAW_CONFIG.TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/xml, text/xml, */*',
        'User-Agent': 'LegalReviewer-Standalone/1.0'
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    throw new LawApiError(`판례/결정례 API 통신 실패 (${url}): ${err.message}`, {
      code: 'DECISIONS_API_FETCH_FAILED',
      details: { url: maskLawSecrets(url) }
    });
  }
}

/**
 * 키워드 또는 사건번호로 판례 검색
 * @param {string} query 
 * @param {number} page 
 * @param {number} display 
 * @returns {Promise<Array<object>>}
 */
export async function searchPrecedents(query, page = 1, display = 10) {
  if (!query || !query.trim()) return [];
  const trimmed = query.trim();
  const cacheKey = `prec:${trimmed}:${page}:${display}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const oc = ENV.LAW_OC;
  if (!oc) {
    return getMockPrecedents(trimmed);
  }

  const url = `${LAW_CONFIG.PRECEDENT_BASE_URL}&OC=${oc}&type=XML&query=${encodeURIComponent(trimmed)}&page=${page}&display=${display}`;

  try {
    const rawXml = await fetchXml(url);
    const parsed = parsePrecedents(rawXml);
    if (parsed.length > 0) {
      await setCache(cacheKey, parsed, LAW_CONFIG.CACHE_TTL.PRECEDENT_DETAIL, 'precedent');
    }
    return parsed;
  } catch (err) {
    console.error('[DecisionsApiClient] searchPrecedents 실패:', err.message);
    return getMockPrecedents(trimmed);
  }
}

/**
 * 키워드로 법령해석례 검색
 * @param {string} query 
 * @param {number} page 
 * @param {number} display 
 * @returns {Promise<Array<object>>}
 */
export async function searchInterpretations(query, page = 1, display = 10) {
  if (!query || !query.trim()) return [];
  const trimmed = query.trim();
  const cacheKey = `expc:${trimmed}:${page}:${display}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const oc = ENV.LAW_OC;
  if (!oc) {
    return getMockInterpretations(trimmed);
  }

  const url = `${LAW_CONFIG.DECISION_BASE_URL}&OC=${oc}&type=XML&query=${encodeURIComponent(trimmed)}&page=${page}&display=${display}`;

  try {
    const rawXml = await fetchXml(url);
    const parsed = parseInterpretations(rawXml);
    if (parsed.length > 0) {
      await setCache(cacheKey, parsed, LAW_CONFIG.CACHE_TTL.PRECEDENT_DETAIL, 'interpretation');
    }
    return parsed;
  } catch (err) {
    console.error('[DecisionsApiClient] searchInterpretations 실패:', err.message);
    return getMockInterpretations(trimmed);
  }
}

/**
 * 행정규칙(훈령/예규/고시) 검색
 * @param {string} query 
 * @param {number} page 
 * @param {number} display 
 * @returns {Promise<Array<object>>}
 */
export async function searchAdminRules(query, page = 1, display = 10) {
  if (!query || !query.trim()) return [];
  const trimmed = query.trim();
  const cacheKey = `admrul:${trimmed}:${page}:${display}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const oc = ENV.LAW_OC;
  if (!oc) {
    return getMockAdminRules(trimmed);
  }

  const url = `${LAW_CONFIG.ADMIN_RULE_BASE_URL}&OC=${oc}&type=XML&query=${encodeURIComponent(trimmed)}&page=${page}&display=${display}`;

  try {
    const rawXml = await fetchXml(url);
    const parsed = parseAdminRules(rawXml);
    if (parsed.length > 0) {
      await setCache(cacheKey, parsed, LAW_CONFIG.CACHE_TTL.LAW_DETAIL, 'adminRule');
    }
    return parsed;
  } catch (err) {
    console.error('[DecisionsApiClient] searchAdminRules 실패:', err.message);
    return getMockAdminRules(trimmed);
  }
}

/**
 * 자치법규(조례/규칙) 검색
 * @param {string} query 
 * @param {number} page 
 * @param {number} display 
 * @returns {Promise<Array<object>>}
 */
export async function searchOrdinances(query, page = 1, display = 10) {
  if (!query || !query.trim()) return [];
  const trimmed = query.trim();
  const cacheKey = `ordin:${trimmed}:${page}:${display}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const oc = ENV.LAW_OC;
  if (!oc) {
    return getMockOrdinances(trimmed);
  }

  const url = `${LAW_CONFIG.ORDINANCE_BASE_URL}&OC=${oc}&type=XML&query=${encodeURIComponent(trimmed)}&page=${page}&display=${display}`;

  try {
    const rawXml = await fetchXml(url);
    const parsed = parseOrdinances(rawXml);
    if (parsed.length > 0) {
      await setCache(cacheKey, parsed, LAW_CONFIG.CACHE_TTL.ORDINANCE_DETAIL, 'ordinance');
    }
    return parsed;
  } catch (err) {
    console.error('[DecisionsApiClient] searchOrdinances 실패:', err.message);
    return getMockOrdinances(trimmed);
  }
}

// -------------------------------------------------------------
// LAW_OC 미설정 시 Fallback 샘플 목업 데이터
// -------------------------------------------------------------

/**
 * 목업 레코드에 출처 표식을 부착한다.
 * 이 표식이 없으면 샘플 판례/해석례가 공식 수집 결과와 구분되지 않은 채
 * 검토의견서와 결재 문서에 그대로 인용된다.
 */
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

export default {
  searchPrecedents,
  searchInterpretations,
  searchAdminRules,
  searchOrdinances
};
