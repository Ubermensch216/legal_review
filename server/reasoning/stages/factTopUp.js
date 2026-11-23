// server/reasoning/stages/factTopUp.js - S1 사실 보충 (긴 문서에서 사실이 너무 적게 뽑힌 경우에만)
//
// S1은 사실과 쟁점을 한 번에 뽑는다. 긴 문서(1만 자 이상)에서 소형 모델이 사실을 1개만 뽑은 사례가 있었다.
// 사실이 비면 쟁점마다 포섭할 근거가 없어 판단이 비게 된다. 그래서 사실 수가 문서 분량에 비해 현저히 적을 때만
// 문서 조각마다 "사실만" 뽑는 짧은 호출을 덧붙인다(출력이 작아 조각당 20~30초). 쟁점 구조는 건드리지 않는다.
import { runStage } from '../stageRunner.js';
import { FACT_STATUS } from '../schemas.js';
import { REASONING_SYSTEM } from '../prompts.js';
import { bigramSimilarity, locateQuote } from './caseIssues.js';
import { extractTerms } from './statuteLinking.js';

export const TOP_UP = Object.freeze({ minDocumentChars: 6000, charsPerFact: 3000, batchChars: 2800, maxFactsPerBatch: 6, maxBatches: 6 });

/** 사실을 보충해야 하는가. 문서 3,000자당 사실 1개에 못 미치면 부족하다고 본다. */
export function needsFactTopUp(factCount, documentChars, limits = TOP_UP) {
  return documentChars >= limits.minDocumentChars && factCount < Math.ceil(documentChars / limits.charsPerFact);
}

const factsOnlySchema = maxFacts => ({ type: 'object', additionalProperties: false, required: ['facts'], properties: {
  facts: { type: 'array', maxItems: maxFacts, items: { type: 'object', additionalProperties: false, required: ['text', 'status', 'docRef', 'quote'],
    properties: { text: { type: 'string', maxLength: 160 }, status: { type: 'string', enum: FACT_STATUS },
      docRef: { type: 'string', maxLength: 16 }, quote: { type: 'string', maxLength: 80 } } } } } });

const TASK = ({ parts, maxFacts }) => `[과제: 사실만 추가로 뽑기]
아래 첨부문서 조각에서 법률 판단에 필요한 사실(금액·일자·주체·행위·처분·근거 규정 인용)을 최대 ${maxFacts}개 뽑는다.
쟁점이나 결론은 쓰지 않는다. docRef에는 사실이 적힌 조각 ID를, quote에는 그 조각에서 사실을 뒷받침하는 원문을 80자 이내로 그대로 옮긴다.
원문에 없으면 status를 INFERRED로 두고 quote는 빈 문자열로 둔다. status: CONFIRMED / ALLEGED / DISPUTED / UNKNOWN / INFERRED.
[첨부문서 조각]
${parts.map(e => `[${e.id}] ${e.text}`).join('\n')}
출력은 JSON만. {"facts":[{"text":"","status":"CONFIRMED","docRef":"D1","quote":""}]}`;

/** 문서 조각을 batchChars 안에서 묶는다. */
export function batchDocumentParts(registry, limits = TOP_UP) {
  const ids = registry.ids(e => e.kind === 'DOCUMENT')
    .flatMap(id => { const parts = registry.children(id).filter(e => e.kind === 'DOCUMENT_PART'); return parts.length ? parts.map(e => e.id) : [id]; });
  const batches = [];
  let current = [];
  let chars = 0;
  for (const id of ids) {
    const entry = registry.get(id);
    if (!entry) continue;
    const length = Math.min(entry.text.length, limits.batchChars);
    if (current.length && chars + length > limits.batchChars) { batches.push(current); current = []; chars = 0; }
    current.push({ id, text: entry.text.slice(0, limits.batchChars) }); chars += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** 새 사실을 기존 사실과 합친다(중복 제거·원문 인용 대조·번호 이어 붙이기). 쟁점은 용어가 겹치는 곳에 연결한다. */
export function mergeTopUpFacts(caseIssues, extracted, { registry, query }) {
  const facts = [...caseIssues.facts];
  const added = [];
  for (const raw of extracted) {
    const text = String(raw.text || '').replace(/\s+/g, ' ').trim();
    if (!text || facts.some(f => bigramSimilarity(f.text, text) >= 0.7)) continue;
    const located = raw.status === 'UNKNOWN' ? { docRef: '', verified: false } : locateQuote(raw, registry, query);
    let status = raw.status;
    if (!located.verified && ['CONFIRMED', 'ALLEGED', 'DISPUTED'].includes(status)) status = 'INFERRED';
    const fact = { id: `F${facts.length + 1}`, text, status, docRef: located.docRef,
      quote: located.verified ? String(raw.quote).replace(/\s+/g, ' ').trim() : '', quoteVerified: located.verified, source: 'TOP_UP' };
    facts.push(fact);
    added.push(fact);
  }
  const issues = caseIssues.issues.map(issue => {
    const terms = extractTerms(issue.question, ...(issue.searchTerms || []));
    const linked = added.filter(f => terms.filter(t => f.text.includes(t)).length >= 2).map(f => f.id);
    return linked.length ? { ...issue, factIds: [...new Set([...issue.factIds, ...linked])].slice(0, 12) } : issue;
  });
  return { ...caseIssues, facts, issues, diagnostics: { ...caseIssues.diagnostics,
    factTopUp: { added: added.length, linked: issues.reduce((n, i, k) => n + i.factIds.length - caseIssues.issues[k].factIds.length, 0) } } };
}

/**
 * 부족하면 조각마다 사실만 뽑아 합친다. 호출이 실패해도 S1 결과는 그대로 둔다(보충은 선택 사항).
 */
export async function topUpFacts({ caseIssues, registry, query, documentChars, provider, config, session, limits = TOP_UP }) {
  if (!needsFactTopUp(caseIssues.facts.length, documentChars, limits)) return caseIssues;
  const extracted = [];
  const failures = [];
  for (const [index, parts] of batchDocumentParts(registry, limits).slice(0, limits.maxBatches).entries()) {
    try {
      const { value } = await runStage({ stage: `s1:facts:${index + 1}`, provider, system: REASONING_SYSTEM,
        prefix: `[질의]\n${String(query || '(질의 없음)').slice(0, 800)}`, task: TASK({ parts, maxFacts: limits.maxFactsPerBatch }),
        schema: factsOnlySchema(limits.maxFactsPerBatch), config: { ...config, think: false }, session });
      extracted.push(...(value.facts || []));
    } catch (err) { failures.push(err.message); }
  }
  const merged = mergeTopUpFacts(caseIssues, extracted, { registry, query });
  if (failures.length) merged.diagnostics.factTopUp.failures = failures.slice(0, 3);
  return merged;
}
