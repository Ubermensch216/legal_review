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

function getText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object') {
    if (node['#text'] !== undefined) return String(node['#text']).trim();
    if (node._ !== undefined) return String(node._).trim();
  }
  return '';
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
    detailUrl: getText(item.판례상세링크 || item.detailUrl)
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
    detailUrl: getText(item.법령해석례상세링크 || item.해석례상세링크 || item.detailUrl)
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

  const container = root.AdmrulSearch || root.admrulSearch;
  if (!container || typeof container !== 'object') throw new Error('목록 응답 루트가 올바르지 않습니다.');
  const items = ensureArray(container.admrul || container.item || []);

  return items.map(item => ({
    id: getText(item.행정규칙일련번호 || item.admrulSeq || item.id),
    name: getText(item.행정규칙명 || item.name),
    ruleType: getText(item.행정규칙종류 || item.ruleType),
    ministry: getText(item.소관부처명 || item.ministry),
    enforceDate: getText(item.시행일자 || item.enforceDate),
    promulDate: getText(item.발령일자 || item.promulDate),
    detailUrl: getText(item.행정규칙상세링크 || item.detailUrl)
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
  const items = ensureArray(container.ordin || container.item || []);

  return items.map(item => ({
    id: getText(item.자치법규일련번호 || item.ordinSeq || item.id),
    name: getText(item.자치법규명 || item.name),
    orgName: getText(item.지자체기관명 || item.orgName),
    ruleType: getText(item.자치법규종류 || item.ruleType),
    enforceDate: getText(item.시행일자 || item.enforceDate),
    detailUrl: getText(item.자치법규상세링크 || item.detailUrl)
  })).filter(o => o.name || o.id);
}

export default {
  parsePrecedents,
  parseInterpretations,
  parseAdminRules,
  parseOrdinances
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
