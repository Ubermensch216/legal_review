// Official law data, with explicit demo mode and version-specific cache keys.
import { ENV } from '../env.js';
import { LAW_CONFIG } from './lawConfig.js';
import { parseLawSearchList, parseLawDetail } from './lawApiParser.js';
import { getCache, setCache } from './lawCache.js';
import { LawApiError } from './lawErrors.js';
import { matchesLaw, exactArticle, isOfficial, validDate, unavailableList } from './evidence.js';
import { normalizeArticleNo } from './lawArticleRef.js';

async function fetchWithRetry(url, retries = LAW_CONFIG.MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(LAW_CONFIG.TIMEOUT_MS), headers: { Accept: 'application/xml' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text(); // Abort signal remains active while reading the body.
    } catch (err) {
      if (attempt === retries) throw new LawApiError(`법령 API 조회 실패: ${err.message}`, { code: 'API_FETCH_FAILED' });
      await new Promise(resolve => setTimeout(resolve, LAW_CONFIG.RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

function apiUrl(base, params) {
  return `${base}?${new URLSearchParams({ OC: ENV.LAW_OC, type: 'XML', ...params })}`;
}
const official = item => ({ ...item, source: 'OFFICIAL_API', retrievedAt: new Date().toISOString() });

export async function searchLaw(query, page = 1, display = 20, options = {}) {
  if (!String(query || '').trim()) return [];
  const trimmed = String(query).trim();
  page = Math.max(1, Number(page) || 1);
  display = Math.min(100, Math.max(1, Number(display) || 20));
  const nw = options.nw || '3';
  const cacheKey = `v2:search:eflaw:${nw}:${options.lawId || ''}:${trimmed}:${page}:${display}`;
  const cached = await getCache(cacheKey);
  if (Array.isArray(cached) && cached.every(isOfficial)) return cached;
  if (!ENV.LAW_OC) return ENV.LAW_DEMO_MODE && nw === '3' ? getMockLawSearch(trimmed) : unavailableList('UNAVAILABLE', 'LAW_OC 미설정');
  try {
    const xml = await fetchWithRetry(apiUrl(LAW_CONFIG.LAW_DRF_BASE_URL, {
      target: 'eflaw', query: trimmed, nw, page: String(page), display: String(display),
      ...(options.lawId ? { LID: options.lawId } : {})
    }));
    const parsed = parseLawSearchList(xml).map(official);
    await setCache(cacheKey, parsed, LAW_CONFIG.CACHE_TTL.LAW_SEARCH, 'search');
    return parsed;
  } catch (err) {
    return unavailableList('ERROR', err.message);
  }
}

export async function getLawDetail(lawId, lawSeq = '', options = {}) {
  if ((!lawId && !lawSeq) || (lawId && !/^\d+$/.test(lawId)) || (lawSeq && !/^\d+$/.test(lawSeq))) return null;
  const enforceDate = options.enforceDate ? validDate(options.enforceDate) : '';
  if (options.enforceDate && !enforceDate) throw new Error('올바른 시행일자가 필요합니다.');
  const target = enforceDate || !lawSeq ? 'eflaw' : 'law';
  const cacheKey = `v3:detail:${target}:${lawId || ''}:${lawSeq}:${enforceDate}`;
  const cached = await getCache(cacheKey);
  if (isOfficial(cached) && cached.contentStatus === 'FULL_TEXT') return cached;
  if (!ENV.LAW_OC) return ENV.LAW_DEMO_MODE ? getMockLawDetail(lawId) : null;
  const params = { target, ...(lawSeq ? { MST: lawSeq } : { ID: lawId }), ...(lawSeq && enforceDate ? { efYd: enforceDate } : {}) };
  const parsed = parseLawDetail(await fetchWithRetry(apiUrl(LAW_CONFIG.LAW_SERVICE_BASE_URL, params)));
  if (!parsed || !parsed.lawId || !parsed.lawName || !parsed.articles.length) throw new LawApiError('공식 법령 본문이 비어 있습니다.', { code: 'INVALID_LAW_BODY' });
  if (lawId && Number(parsed.lawId) !== Number(lawId)) throw new LawApiError('요청과 다른 법령 본문입니다.', { code: 'LAW_ID_MISMATCH' });
  if (enforceDate && parsed.enforceDate !== enforceDate) throw new LawApiError('요청과 다른 시행일의 본문입니다.', { code: 'LAW_VERSION_MISMATCH' });
  const detail = { ...official(parsed), lawSeq: lawSeq || parsed.lawSeq, contentStatus: 'FULL_TEXT', requestTarget: target };
  await setCache(cacheKey, detail, LAW_CONFIG.CACHE_TTL.LAW_DETAIL, 'detail');
  return detail;
}

export async function getLawArticle(lawIdOrName, articleNo, branchNo = '') {
  if (!lawIdOrName || !articleNo) return null;
  let detail;
  if (/^\d+$/.test(lawIdOrName)) detail = await getLawDetail(lawIdOrName);
  else {
    const results = await searchLaw(lawIdOrName, 1, 100);
    const match = results.find(l => matchesLaw(l, lawIdOrName));
    if (match) detail = await getLawDetail(match.lawId, match.lawSeq, { enforceDate: match.enforceDate });
    if (detail && !matchesLaw(detail, lawIdOrName)) return null;
  }
  if (!detail) return null;
  const fullNo = branchNo ? `${normalizeArticleNo(articleNo).split('의')[0]}의${branchNo}` : normalizeArticleNo(articleNo);
  const article = exactArticle(detail.articles, fullNo);
  if (!article) return null;
  return { lawName: detail.lawName, lawId: detail.lawId, lawSeq: detail.lawSeq, promulDate: detail.promulDate,
    enforceDate: detail.enforceDate, source: detail.source || 'MOCK', isMockData: Boolean(detail.isMockData), article };
}

// Fetch all available versions of the exact law, without silently treating a partial list as complete.
export async function getLawVersions(lawName) {
  const candidates = await searchLaw(lawName, 1, 100, { nw: '1,2,3' });
  if (candidates.fetchStatus) throw new LawApiError(candidates.unavailableReason, { code: 'HISTORY_UNAVAILABLE' });
  const exact = candidates.find(l => matchesLaw(l, lawName));
  if (!exact) return [];
  const versions = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const items = await searchLaw(lawName, page, 100, { nw: '1,2,3', lawId: exact.lawId });
    if (items.fetchStatus) throw new LawApiError(items.unavailableReason, { code: 'HISTORY_UNAVAILABLE' });
    for (const item of items) {
      if (Number(item.lawId) !== Number(exact.lawId)) continue;
      const key = `${item.lawSeq}:${item.enforceDate}`;
      if (!seen.has(key)) { seen.add(key); versions.push(item); }
    }
    if (items.length < 100) return versions;
  }
  throw new LawApiError('법령 이력이 조회 한도를 초과하여 일부 결과만 확보되었습니다.', { code: 'HISTORY_INCOMPLETE' });
}

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

  // 법령명이 실제로 맞아떨어지는 샘플만 돌려준다.
  // 과거에는 `query.includes('법')` 조건이 있어 '저작권법', '중대재해처벌법' 등
  // '법'을 포함한 모든 질의가 5건 전부와 매칭되었고, 그 결과 첫 항목인
  // 개인정보 보호법이 무관한 질의의 기준 법령으로 선택되었다.
  const normalized = query.replace(/\s+/g, '');
  const matched = samples.filter(s => {
    const name = s.lawName.replace(/\s+/g, '');
    const shortName = (s.lawNameShort || '').replace(/\s+/g, '');
    return normalized.includes(name) || name.includes(normalized) ||
           (shortName && (normalized.includes(shortName) || shortName.includes(normalized)));
  });

  return matched.map(s => ({ ...s, isMockData: true }));
}

function getMockLawDetail(lawId) {
  // 샘플 본문을 보유한 법령은 개인정보 보호법뿐이다. 다른 법령의 ID로 조회된
  // 경우에도 이 본문을 돌려주면 '근로기준법 제15조(개인정보의 수집·이용)' 같은
  // 교차 오표기가 발생하므로, 조문 없이 목업임을 표시한 스텁만 반환한다.
  if (lawId && lawId !== '001552' && lawId !== 'sample') {
    return {
      lawId,
      lawName: '',
      articles: [],
      annexes: [],
      isMockData: true,
      unavailableReason: 'LAW_OC 미설정 또는 법령 API 응답 실패로 공식 조문을 가져오지 못했습니다.'
    };
  }

  return {
    isMockData: true,
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


export default { searchLaw, getLawDetail, getLawArticle, getLawVersions };
