// server/law/decisionsApiParser.js - 판례, 법령해석례, 행정규칙, 자치법규 XML/JSON 응답 파서
import { XMLParser } from 'fast-xml-parser';

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
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch {
      return [];
    }
  }

  const container = root.PrecSearch || root.precSearch || root.prec || root;
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
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch {
      return [];
    }
  }

  const container = root.ExpcSearch || root.expcSearch || root.expc || root;
  const items = ensureArray(container.expc || container.item || []);

  return items.map(item => ({
    id: getText(item.해석례일련번호 || item.expcSeq || item.id),
    itemNo: getText(item.안건번호 || item.itemNo),
    title: getText(item.안건명 || item.title),
    orgName: getText(item.해석기관명 || item.orgName || '법제처'),
    replyDate: getText(item.회답일자 || item.replyDate),
    question: getText(item.질의요지 || item.question),
    answer: getText(item.회답요지 || item.answer),
    reason: getText(item.이유 || item.reason),
    detailUrl: getText(item.해석례상세링크 || item.detailUrl)
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
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch {
      return [];
    }
  }

  const container = root.AdmrulSearch || root.admrulSearch || root.admrul || root;
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
      root = raw.trim().startsWith('{') ? JSON.parse(raw) : xmlParser.parse(raw);
    } catch {
      return [];
    }
  }

  const container = root.OrdinSearch || root.ordinSearch || root.ordin || root;
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
