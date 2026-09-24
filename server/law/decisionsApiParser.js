// server/law/decisionsApiParser.js - 판례, 법령해석례, 행정규칙, 자치법규 XML/JSON 응답 파서
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DecisionDataError } from './decisionDiagnostics.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false
});

function ensureArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

// 법령 본문에는 가운뎃점(&#8231;) 등 수치 문자 참조가 그대로 들어온다.
// 그대로 두면 LLM 입력과 출력 문서에 원시 엔티티가 노출된다.
function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function getText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return decodeEntities(node).trim();
  if (typeof node === 'object') {
    if (node['#text'] !== undefined) return decodeEntities(node['#text']).trim();
    if (node._ !== undefined) return decodeEntities(node._).trim();
  }
  return '';
}

// 공식 목록의 상세 링크에 API 계정 식별자(OC)가 포함될 수 있다. 응답·캐시에 싣기 전에 제거한다.
export function publicDetailUrl(node) {
  const value = getText(node);
  if (!value) return '';
  try {
    const url = new URL(value, 'https://www.law.go.kr');
    url.searchParams.delete('OC');
    return value.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch { return ''; }
}

/**
 * 판례 검색 목록 파싱
 */
export function parsePrecedents(raw) {
  if (!raw) return [];
  let root = raw;
  if (typeof raw === 'string') {
    try {
      if (!raw.trim().startsWith('{') && XMLValidator.validate(raw) !== true) throw new Error('Invalid XML');
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch { throw new Error('목록 응답을 해석할 수 없습니다.'); }
  }

  const container = root.PrecSearch || root.precSearch;
  if (!container || typeof container !== 'object') throw new Error('목록 응답 루트가 올바르지 않습니다.');
  const items = ensureArray(container.prec || container.item || container.precInfo || []);

  return items.map(item => ({
    id: getText(item.판례일련번호 || item.precSeq || item.id),
    caseNo: getText(item.사건번호 || item.caseNo),
    caseName: getText(item.사건명 || item.caseName),
    courtName: getText(item.법원명 || item.courtName),
    judgeDate: getText(item.선고일자 || item.judgeDate),
    caseType: getText(item.사건종류명 || item.caseType),
    judgeType: getText(item.판결유형 || item.judgeType),
    holding: getText(item.판시사항 || item.holding),
    summary: getText(item.판결요지 || item.summary),
    detailUrl: publicDetailUrl(item.판례상세링크 || item.detailUrl)
  })).filter(p => p.caseNo || p.caseName || p.id);
}

/**
 * 법령해석례 검색 목록 파싱
 */
export function parseInterpretations(raw) {
  if (!raw) return [];
  let root = raw;
  if (typeof raw === 'string') {
    try {
      if (!raw.trim().startsWith('{') && XMLValidator.validate(raw) !== true) throw new Error('Invalid XML');
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch { throw new Error('목록 응답을 해석할 수 없습니다.'); }
  }

  const container = root.ExpcSearch || root.expcSearch || root.Expc;
  if (!container || typeof container !== 'object') throw new Error('목록 응답 루트가 올바르지 않습니다.');
  if (container.resultCode !== undefined && getText(container.resultCode) !== '00') throw new DecisionDataError('API_RESULT_ERROR', '해석례 API가 실패 상태를 반환했습니다.');
  const items = ensureArray(container.expc || container.item || []);

  return items.map(item => ({
    id: getText(item.법령해석례일련번호 || item.해석례일련번호 || item.expcSeq || item.id),
    itemNo: getText(item.안건번호 || item.itemNo),
    title: getText(item.안건명 || item.title),
    orgName: getText(item.해석기관명 || item.회신기관명 || item.orgName),
    replyDate: getText(item.해석일자 || item.회신일자 || item.회답일자 || item.replyDate),
    question: getText(item.질의요지 || item.question),
    answer: getText(item.회답 || item.회답요지 || item.answer),
    reason: getText(item.이유 || item.reason),
    detailUrl: publicDetailUrl(item.법령해석례상세링크 || item.해석례상세링크 || item.detailUrl)
  })).filter(e => e.title || e.itemNo || e.id);
}

/**
 * 행정규칙(훈령/예규/고시) 목록 파싱
 */
export function parseAdminRules(raw) {
  if (!raw) return [];
  let root = raw;
  if (typeof raw === 'string') {
    try {
      if (!raw.trim().startsWith('{') && XMLValidator.validate(raw) !== true) throw new Error('Invalid XML');
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch { throw new Error('목록 응답을 해석할 수 없습니다.'); }
  }

  // DRF 행정규칙 목록의 루트 요소명은 <AdmRulSearch>이다. (대문자 R)
  const container = root.AdmRulSearch || root.AdmrulSearch || root.admrulSearch;
  if (!container || typeof container !== 'object') throw new Error('목록 응답 루트가 올바르지 않습니다.');
  const items = ensureArray(container.admrul || container.law || container.item || []);

  return items.map(item => ({
    id: getText(item.행정규칙일련번호 || item.admrulSeq || item.id),
    name: getText(item.행정규칙명 || item.name),
    ruleType: getText(item.행정규칙종류 || item.ruleType),
    ministry: getText(item.소관부처명 || item.ministry),
    enforceDate: getText(item.시행일자 || item.enforceDate),
    promulDate: getText(item.발령일자 || item.promulDate),
    detailUrl: publicDetailUrl(item.행정규칙상세링크 || item.detailUrl)
  })).filter(r => r.name || r.id);
}

/**
 * 자치법규(조례/규칙) 목록 파싱
 */
export function parseOrdinances(raw) {
  if (!raw) return [];
  let root = raw;
  if (typeof raw === 'string') {
    try {
      if (!raw.trim().startsWith('{') && XMLValidator.validate(raw) !== true) throw new Error('Invalid XML');
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch { throw new Error('목록 응답을 해석할 수 없습니다.'); }
  }

  const container = root.OrdinSearch || root.ordinSearch;
  if (!container || typeof container !== 'object') throw new Error('목록 응답 루트가 올바르지 않습니다.');
  // DRF 자치법규 목록의 항목 요소명은 <law>이다. (<ordin>이 아님)
  const items = ensureArray(container.law || container.ordin || container.item || []);

  return items.map(item => ({
    id: getText(item.자치법규일련번호 || item.ordinSeq || item.id),
    // 본문 조회(lawService.do)는 자치법규ID 또는 일련번호(MST)를 요구하므로 둘 다 보존한다.
    ordinanceId: getText(item.자치법규ID || item.ordinId),
    name: getText(item.자치법규명 || item.name),
    orgName: getText(item.지자체기관명 || item.orgName),
    ruleType: getText(item.자치법규종류 || item.ruleType),
    promulDate: getText(item.공포일자 || item.promulDate),
    enforceDate: getText(item.시행일자 || item.enforceDate),
    detailUrl: publicDetailUrl(item.자치법규상세링크 || item.detailUrl)
  })).filter(o => o.name || o.id);
}

/**
 * 행정규칙(훈령·예규·고시) 본문 파싱.
 * 조문내용은 조 단위 평문 문자열 배열이고, 별표는 첨부파일 링크로 제공된다.
 */
export function parseAdminRuleDetail(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    try {
      if (!raw.trim().startsWith('{') && XMLValidator.validate(raw) !== true) throw new Error('Invalid XML');
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch { throw new DecisionDataError('INVALID_XML', '본문 XML이 올바르지 않습니다.'); }
  }

  const service = root.AdmRulService || root.admRulService;
  const info = service?.행정규칙기본정보;
  if (!info) throw new DecisionDataError('UNEXPECTED_BODY_ROOT', '행정규칙 본문 응답 루트가 올바르지 않습니다.');

  const articles = ensureArray(service.조문내용).map(entry => {
    const content = decodeEntities(entry || '').replace(/<img[^>]*>[\s\S]*?<\/img>/g, '[이미지 수식]').trim();
    const head = /^제\s*(\d+)(?:조\s*의\s*(\d+))?\s*조?\s*\(([^)]*)\)/.exec(content) || /^제\s*(\d+)조(?:의(\d+))?/.exec(content);
    if (!head) return null;
    const articleNo = head[1];
    const branchNo = head[2] || '';
    return {
      articleNo,
      branchNo,
      fullArticleNo: branchNo ? `${articleNo}의${branchNo}` : articleNo,
      title: head[3] || '',
      content,
      isDeleted: /^제\s*\d+조(?:의\d+)?\s*삭제/.test(content),
      paragraphs: splitOrdinanceArticleBody(content)
    };
  }).filter(Boolean);

  const baseUrl = 'https://www.law.go.kr';
  const annexes = ensureArray(service.별표?.별표단위 || service.별표?.별표 || []).map(an => {
    const link = getText(an.별표서식파일링크 || an.별표상세링크 || an.별표링크);
    return {
      no: getText(an.별표번호 || an.no),
      branchNo: getText(an.별표가지번호),
      type: getText(an.별표구분 || an.별표종류),
      title: getText(an.별표제목 || an.title),
      // 별표 본문은 첨부파일(HWP/PDF)로만 제공되므로 다운로드 링크를 그대로 전달한다.
      fileUrl: link ? (link.startsWith('http') ? link : `${baseUrl}${link}`) : ''
    };
  }).filter(a => a.title || a.no);

  return {
    id: getText(info.행정규칙일련번호),
    ruleId: getText(info.행정규칙ID),
    name: getText(info.행정규칙명),
    ruleType: getText(info.행정규칙종류),
    ministry: getText(info.소관부처명),
    promulDate: getText(info.발령일자),
    promulNo: getText(info.발령번호),
    enforceDate: getText(info.시행일자 || info.발령일자),
    articles,
    annexes
  };
}

// 자치법규 조내용은 항/호가 중첩 요소가 아니라 본문에 함께 들어온다.
// 인용 검증(containsCitation)이 항·호 단위로 동작하므로 본문에서 복원한다.
const PARAGRAPH_MARKERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function splitOrdinanceArticleBody(content) {
  const body = String(content || '');
  // 조제목 줄("제22조(건물대부료 산출기준)")을 제외한 나머지를 항 단위로 나눈다.
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const paragraphs = [];
  let current = null;
  for (const line of lines) {
    const markerIndex = PARAGRAPH_MARKERS.indexOf(line[0]);
    if (markerIndex >= 0) {
      current = { paragraphNo: String(markerIndex + 1), content: line.slice(1).trim(), items: [] };
      paragraphs.push(current);
      continue;
    }
    const itemMatch = /^(\d+)\.\s*(.*)$/.exec(line);
    if (itemMatch && current) {
      current.items.push({ itemNo: itemMatch[1], content: itemMatch[2], subItems: [] });
      continue;
    }
    const subMatch = /^([가-힣])\.\s*(.*)$/.exec(line);
    if (subMatch && current?.items.length) {
      current.items.at(-1).subItems.push({ subItemNo: subMatch[1], content: subMatch[2] });
      continue;
    }
    if (current) current.content = `${current.content} ${line}`.trim();
  }
  return paragraphs;
}

/**
 * 자치법규(조례/규칙) 본문 파싱 — 법령 조문과 동일한 형태로 맞춘다.
 */
export function parseOrdinanceDetail(raw) {
  let root = raw;
  if (typeof raw === 'string') {
    try {
      if (!raw.trim().startsWith('{') && XMLValidator.validate(raw) !== true) throw new Error('Invalid XML');
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch { throw new DecisionDataError('INVALID_XML', '본문 XML이 올바르지 않습니다.'); }
  }

  const service = root.LawService || root.lawService;
  const info = service?.자치법규기본정보;
  if (!info) throw new DecisionDataError('UNEXPECTED_BODY_ROOT', '자치법규 본문 응답 루트가 올바르지 않습니다.');

  const articles = ensureArray(service.조문?.조 || service.조문?.조문단위 || []).map(art => {
    // 조문번호는 100배 표기다. (002200 → 제22조, 002202 → 제22조의2)
    const rawNo = Number(getText(art['@_조문번호'] || art.조문번호) || 0);
    const articleNo = String(Math.floor(rawNo / 100));
    const branchNo = rawNo % 100 ? String(rawNo % 100) : '';
    const content = getText(art.조내용 || art.조문내용);
    return {
      articleNo,
      branchNo,
      fullArticleNo: branchNo ? `${articleNo}의${branchNo}` : articleNo,
      title: getText(art.조제목 || art.조문제목),
      content,
      enforceDate: getText(info.시행일자),
      isDeleted: /^제\s*\d+조(?:의\d+)?\s*삭제/.test(content),
      paragraphs: splitOrdinanceArticleBody(content)
    };
  }).filter(a => a.articleNo && a.articleNo !== '0');

  return {
    id: getText(info.자치법규일련번호),
    ordinanceId: getText(info.자치법규ID),
    lawName: getText(info.자치법규명),
    lawType: getText(info.자치법규종류),
    orgName: getText(info.지자체기관명),
    promulDate: getText(info.공포일자),
    enforceDate: getText(info.시행일자),
    articles,
    annexes: ensureArray(service.별표?.별표단위 || service.별표?.별표 || []).map(an => ({
      no: getText(an.별표번호 || an.no),
      title: getText(an.별표제목 || an.title),
      detailUrl: publicDetailUrl(an.별표상세링크 || an.detailUrl)
    }))
  };
}

export default {
  parsePrecedents,
  parseInterpretations,
  parseAdminRules,
  parseOrdinances,
  parseAdminRuleDetail,
  parseOrdinanceDetail
};

function detailRoot(raw, keys) {
  if (typeof raw === 'string' && !raw.trim().startsWith('{') && XMLValidator.validate(raw) !== true) throw new DecisionDataError('INVALID_XML', '본문 XML이 올바르지 않습니다.');
  const root = typeof raw === 'string' ? (raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw)) : raw;
  const found = keys.map(k => root?.[k]).find(r => r && typeof r === 'object');
  if (!found) throw new DecisionDataError('UNEXPECTED_BODY_ROOT', '본문 응답 루트가 올바르지 않습니다. 권한 또는 제공 범위는 별도 확인이 필요합니다.');
  return found;
}
export function parsePrecedentDetail(raw) {
  const root = detailRoot(raw, ['PrecService', 'precService', '판례']);
  const result = {
    id: getText(root.판례정보일련번호 || root.판례일련번호), caseNo: getText(root.사건번호), caseName: getText(root.사건명),
    courtName: getText(root.법원명), judgeDate: getText(root.선고일자), holding: getText(root.판시사항),
    summary: getText(root.판결요지), content: getText(root.판례내용), referencedArticles: getText(root.참조조문)
  };
  if (!result.id || !result.caseNo || !(result.summary || result.holding || result.content)) throw new DecisionDataError('MISSING_BODY_FIELDS', '판례 본문을 확보하지 못했습니다.');
  return result;
}
export function parseInterpretationDetail(raw) {
  const root = detailRoot(raw, ['ExpcService', 'expcService', '법령해석례', '법령해석']);
  const result = {
    id: getText(root.법령해석례일련번호 || root.해석례일련번호), itemNo: getText(root.안건번호), title: getText(root.안건명),
    orgName: getText(root.해석기관명), replyDate: getText(root.해석일자), question: getText(root.질의요지), answer: getText(root.회답), reason: getText(root.이유)
  };
  if (!result.id || !result.title || !(result.answer || result.reason)) throw new DecisionDataError('MISSING_BODY_FIELDS', '해석례 본문을 확보하지 못했습니다.');
  return result;
}
