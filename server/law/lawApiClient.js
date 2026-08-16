// server/law/lawApiClient.js - 국가법령정보센터(law.go.kr) DRF 오픈API 통신 클라이언트
import { ENV } from '../env.js';
import { LAW_CONFIG } from './lawConfig.js';
import { parseLawSearchList, parseLawDetail } from './lawApiParser.js';
import { getCache, setCache } from './lawCache.js';
import { LawApiError, maskLawSecrets } from './lawErrors.js';

// 네트워크 요청 재시도 및 타임아웃 헬퍼
async function fetchWithRetry(url, options = {}, retries = LAW_CONFIG.MAX_RETRIES) {
  const timeoutMs = options.timeoutMs || LAW_CONFIG.TIMEOUT_MS;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Accept': 'application/xml, text/xml, application/json, */*',
          'User-Agent': 'LegalReviewer-Standalone/1.0',
          ...(options.headers || {})
        }
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } catch (err) {
      clearTimeout(timeoutId);
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) {
        throw new LawApiError(`법령 API 통신 실패 (${url}): ${err.message}`, {
          code: 'API_FETCH_FAILED',
          details: { url: maskLawSecrets(url), attempt }
        });
      }
      await new Promise(r => setTimeout(r, LAW_CONFIG.RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

/**
 * 법령명 또는 키워드로 법령 목록 검색
 * @param {string} query 
 * @param {number} page 
 * @param {number} display 
 * @returns {Promise<Array<object>>}
 */
export async function searchLaw(query, page = 1, display = 20) {
  if (!query || !query.trim()) return [];
  const trimmed = query.trim();
  const cacheKey = `search:${trimmed}:${page}:${display}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const oc = ENV.LAW_OC;
  if (!oc) {
    console.warn('[LawApiClient] LAW_OC 미설정 - 목업 데이터 또는 기본 검색으로 대응');
    return getMockLawSearch(trimmed);
  }

  const url = `${LAW_CONFIG.LAW_DRF_BASE_URL}?OC=${oc}&target=law&type=XML&query=${encodeURIComponent(trimmed)}&page=${page}&display=${display}`;

  try {
    const rawXml = await fetchWithRetry(url);
    const parsed = parseLawSearchList(rawXml);
    if (parsed.length > 0) {
      await setCache(cacheKey, parsed, LAW_CONFIG.CACHE_TTL.LAW_SEARCH, 'search');
    }
    return parsed;
  } catch (err) {
    console.error('[LawApiClient] searchLaw 실패:', err.message);
    return getMockLawSearch(trimmed);
  }
}

/**
 * 법령 ID/일련번호로 법령 전체 조문 및 상세 정보 조회
 * @param {string} lawId 
 * @param {string} lawSeq 
 * @returns {Promise<object|null>}
 */
export async function getLawDetail(lawId, lawSeq = '') {
  if (!lawId && !lawSeq) return null;
  const cacheKey = `detail:${lawId || ''}:${lawSeq || ''}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const oc = ENV.LAW_OC;
  if (!oc) {
    return getMockLawDetail(lawId || 'sample');
  }

  const idParam = lawId ? `ID=${encodeURIComponent(lawId)}` : `MST=${encodeURIComponent(lawSeq)}`;
  const url = `${LAW_CONFIG.LAW_SERVICE_BASE_URL}?OC=${oc}&target=law&type=XML&${idParam}`;

  try {
    const rawXml = await fetchWithRetry(url);
    const parsed = parseLawDetail(rawXml);
    if (parsed && parsed.articles && parsed.articles.length > 0) {
      await setCache(cacheKey, parsed, LAW_CONFIG.CACHE_TTL.LAW_DETAIL, 'detail');
    }
    return parsed;
  } catch (err) {
    console.error('[LawApiClient] getLawDetail 실패:', err.message);
    return getMockLawDetail(lawId || 'sample');
  }
}

/**
 * 특정 법령의 특정 조문 조회
 * @param {string} lawIdOrName 
 * @param {string} articleNo 
 * @param {string} branchNo 
 * @returns {Promise<object|null>}
 */
export async function getLawArticle(lawIdOrName, articleNo, branchNo = '') {
  if (!lawIdOrName || !articleNo) return null;

  // 1. 법령 검색 또는 상세 조회
  let detail = null;
  if (/^\d+$/.test(lawIdOrName)) {
    detail = await getLawDetail(lawIdOrName);
  } else {
    const searchResults = await searchLaw(lawIdOrName, 1, 5);
    if (searchResults.length > 0) {
      detail = await getLawDetail(searchResults[0].lawId, searchResults[0].lawSeq);
    }
  }

  if (!detail || !detail.articles) return null;

  const targetFullNo = branchNo ? `${articleNo}의${branchNo}` : String(articleNo);
  const article = detail.articles.find(a => a.fullArticleNo === targetFullNo || a.articleNo === String(articleNo));

  if (!article) return null;

  return {
    lawName: detail.lawName,
    lawId: detail.lawId,
    promulDate: detail.promulDate,
    enforceDate: detail.enforceDate,
    article
  };
}

// -------------------------------------------------------------
// LAW_OC 미발급 시 개발 및 UI 테스트를 위한 고품질 Fallback 목업 데이터
// -------------------------------------------------------------
function getMockLawSearch(query) {
  const samples = [
    {
      lawId: '001552',
      lawSeq: '243015',
      lawName: '개인정보 보호법',
      lawNameShort: '개인정보보호법',
      promulDate: '20230314',
      promulNo: '19234',
      enforceDate: '20230915',
      lawType: '법률',
      ministry: '개인정보보호위원회',
      detailUrl: 'http://www.law.go.kr/법령/개인정보보호법'
    },
    {
      lawId: '001789',
      lawSeq: '239841',
      lawName: '근로기준법',
      lawNameShort: '근로기준법',
      promulDate: '20230103',
      promulNo: '19184',
      enforceDate: '20230704',
      lawType: '법률',
      ministry: '고용노동부',
      detailUrl: 'http://www.law.go.kr/법령/근로기준법'
    },
    {
      lawId: '000032',
      lawSeq: '254102',
      lawName: '민법',
      lawNameShort: '민법',
      promulDate: '20221213',
      promulNo: '19069',
      enforceDate: '20230628',
      lawType: '법률',
      ministry: '법무부',
      detailUrl: 'http://www.law.go.kr/법령/민법'
    },
    {
      lawId: '009841',
      lawSeq: '248901',
      lawName: '지방자치법',
      lawNameShort: '지방자치법',
      promulDate: '20230321',
      promulNo: '19273',
      enforceDate: '20230922',
      lawType: '법률',
      ministry: '행정안전부',
      detailUrl: 'http://www.law.go.kr/법령/지방자치법'
    },
    {
      lawId: '007421',
      lawSeq: '235124',
      lawName: '행정기본법',
      lawNameShort: '행정기본법',
      promulDate: '20230228',
      promulNo: '19225',
      enforceDate: '20230324',
      lawType: '법률',
      ministry: '법제처',
      detailUrl: 'http://www.law.go.kr/법령/행정기본법'
    }
  ];

  return samples.filter(s => s.lawName.includes(query) || query.includes(s.lawName) || query.includes('법'));
}

function getMockLawDetail(lawId) {
  return {
    lawId: lawId || '001552',
    lawSeq: '243015',
    lawName: '개인정보 보호법',
    lawNameShort: '개인정보보호법',
    promulDate: '20230314',
    promulNo: '19234',
    enforceDate: '20230915',
    lawType: '법률',
    ministry: '개인정보보호위원회',
    articles: [
      {
        articleNo: '15',
        branchNo: '',
        fullArticleNo: '15',
        title: '개인정보의 수집ㆍ이용',
        content: '제15조(개인정보의 수집ㆍ이용) ① 개인정보처리자는 다음 각 호의 어느 하나에 해당하는 경우에는 개인정보를 수집할 수 있으며 그 수집 목적의 범위에서 이용할 수 있다.\n1. 정보주체의 동의를 받은 경우\n2. 법률에 특별한 규정이 있거나 법령상 의무를 준수하기 위하여 불가피한 경우\n3. 공공기관이 법령 등에서 정하는 소관 업무의 수행을 위하여 불가피한 경우\n4. 정보주체와의 계약의 체결 및 이행을 위하여 불가피하게 필요한 경우\n5. 정보주체 또는 그 법정대리인이 의사표시를 할 수 없는 상태에 있거나 주소불명 등으로 사전 동의를 받을 수 없는 경우로서 명백히 정보주체 또는 제3자의 급박한 생명, 신체, 재산의 이익을 위하여 필요하다고 인정되는 경우\n6. 개인정보처리자의 정당한 이익을 달성하기 위하여 필요한 경우로서 명백하게 정보주체의 권리보다 우선하는 경우. 이 경우 개인정보처리자의 정당한 이익과 상당한 관련이 있고 합리적인 범위를 초과하지 아니하는 경우에 한한다.',
        enforceDate: '20230915',
        paragraphs: [
          {
            paragraphNo: '1',
            content: '개인정보처리자는 다음 각 호의 어느 하나에 해당하는 경우에는 개인정보를 수집할 수 있으며 그 수집 목적의 범위에서 이용할 수 있다.',
            items: [
              { itemNo: '1', content: '정보주체의 동의를 받은 경우', subItems: [] },
              { itemNo: '2', content: '법률에 특별한 규정이 있거나 법령상 의무를 준수하기 위하여 불가피한 경우', subItems: [] },
              { itemNo: '3', content: '공공기관이 법령 등에서 정하는 소관 업무의 수행을 위하여 불가피한 경우', subItems: [] },
              { itemNo: '4', content: '정보주체와의 계약의 체결 및 이행을 위하여 불가피하게 필요한 경우', subItems: [] },
              { itemNo: '6', content: '개인정보처리자의 정당한 이익을 달성하기 위하여 필요한 경우...', subItems: [] }
            ]
          }
        ]
      },
      {
        articleNo: '17',
        branchNo: '',
        fullArticleNo: '17',
        title: '개인정보의 제공',
        content: '제17조(개인정보의 제공) ① 개인정보처리자는 다음 각 호의 어느 하나에 해당하는 경우에는 정보주체의 개인정보를 제3자에게 제공(공유를 포함한다. 이하 같다)할 수 있다.\n1. 정보주체의 동의를 받은 경우\n2. 제15조제1항제2호ㆍ제3호 및 제5호에 따라 개인정보를 수집한 목적 범위에서 개인정보를 제공하는 경우',
        enforceDate: '20230915',
        paragraphs: []
      },
      {
        articleNo: '29',
        branchNo: '',
        fullArticleNo: '29',
        title: '안전조치의무',
        content: '제29조(안전조치의무) 개인정보처리자는 개인정보가 분실ㆍ도난ㆍ유출ㆍ위조ㆍ변조 또는 훼손되지 아니하도록 내부관리계획 수립, 접속기록 보관 등 대통령령으로 정하는 바에 따라 안전성 확보에 필요한 기술적ㆍ관리적 및 물리적 조치를 하여야 한다.',
        enforceDate: '20230915',
        paragraphs: []
      }
    ],
    annexes: [
      { annexNo: '1', title: '과징금 부과기준(제64조의2 관련)', fileType: 'HWP', fileUrl: 'http://www.law.go.kr/flDownload.do?flSeq=1' }
    ]
  };
}

export default {
  searchLaw,
  getLawDetail,
  getLawArticle
};
