// server/reasoning/escalation.js - 로컬 모델이 풀지 못한 쟁점만 외부 LLM에 다시 묻는다 (내부+외부 병용 모드)
//
// 흐름: 로컬 파이프라인이 끝나면 어려운 쟁점을 골라 제안만 한다(전송 없음) → 사용자가 비식별된 전송 내용을 확인 →
// 승인하면 그 쟁점의 같은 판단 단계(S4)를 외부 모델로 다시 실행 → 답변을 원래 값으로 복원하고 로컬 모델로 근거 확인 →
// 코드가 결론을 다시 계산해 의견서에 반영한다. 외부 모델이 결론을 직접 정하지 않는다.
import { createHash } from 'node:crypto';
import { applyIssue, buildIssuePrefix } from './stages/application.js';
import { computeIssueConclusion } from './verify/conclusion.js';
import { verifyWarrants } from './verify/warrant.js';
import { mapRegistryText } from './evidenceRegistry.js';
import { conclusionTable, LEGAL_LABEL, renderReview } from './stages/synthesis.js';
import { createLlmSession } from './llmGateway.js';
import { resolveBudget } from '../law/llmBudget.js';
import { createDeidentifier, reidentifyDeep, remainingIdentifiers } from '../privacy/deidentify.js';
import { recordExternalTransmission } from '../privacy/auditLog.js';

const PRIORITY_WEIGHT = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const MAX_MATERIAL_CHARS = 60000;

export class EscalationError extends Error {
  constructor(message, statusCode = 400, code = 'ESCALATION_FAILED') { super(message); this.statusCode = statusCode; this.code = code; }
}

/**
 * 외부 LLM에 다시 물을 만한 쟁점. 로컬 모델이 실패했거나 결론 요건을 판단하지 못한 쟁점이며,
 * 연결된 공식 근거가 없어 더 큰 모델도 할 수 있는 일이 없는 쟁점은 뺀다.
 */
export function selectEscalationCandidates({ issues, issueResults, ledger = [], max = 3 }) {
  const candidates = [];
  for (const issue of issues) {
    const r = issueResults.find(x => x.issueId === issue.id);
    if (!r || r.reused || r.stageStatus === 'SKIPPED' || !(r.elements || []).length) continue;
    const decisive = new Set(r.conclusion?.decidingElementIds || []);
    const reasons = [];
    if (r.stageStatus === 'FAILED') reasons.push('로컬 모델의 판단이 실패함');
    if (r.stageStatus === 'PARTIAL') reasons.push('일부 요건 또는 근거를 검토하지 못함');
    const open = (r.assessments || []).filter(a => decisive.has(a.elementId) && ['UNKNOWN', 'DISPUTED', 'PARTIALLY_SATISFIED'].includes(a.status));
    if (r.conclusion?.legal === 'CONDITIONAL' && open.length) reasons.push(`결론 요건 ${open.length}개를 판단하지 못함`);
    if (ledger.some(w => w.issueId === issue.id && decisive.has(w.elementId) && w.overall !== 'SUPPORTED')) reasons.push('결론 요건의 근거 대응 확인이 끝나지 않음');
    if (r.elements.some(e => e.fallback && e.blocksConclusion === true)) reasons.push('조문을 요건으로 분해하지 못해 골격으로 대체됨');
    if (!reasons.length) continue;
    candidates.push({ issueId: issue.id, question: issue.question, priority: issue.priority, reasons,
      score: reasons.length * 2 + (PRIORITY_WEIGHT[issue.priority] || 1) });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, max).map(({ score, ...c }) => c);
}

/** 이 쟁점 판단에 쓰는 자료를 비식별화한 사본과, 사용자가 확인할 전송 내용·해시를 만든다. */
export function buildSanitizedRequest(ctx, issueId, { provider, terms = [] }) {
  const issue = ctx.caseIssues.issues.find(i => i.id === issueId);
  const result = ctx.issueResults.find(r => r.issueId === issueId);
  const research = ctx.research[issueId];
  if (!issue || !result || !research) throw new EscalationError('해당 쟁점을 이 검토에서 찾을 수 없습니다.', 404, 'ISSUE_NOT_FOUND');
  const sample = [...ctx.registry.list(e => e.kind.startsWith('DOCUMENT')).map(e => e.text),
    ...ctx.caseIssues.facts.map(f => `${f.text}\n${f.quote || ''}`)].join('\n');
  const deid = createDeidentifier({ terms, sample });
  const registry = mapRegistryText(ctx.registry, text => deid.redact(text));
  const facts = ctx.caseIssues.facts.filter(f => issue.factIds.includes(f.id))
    .map(f => ({ ...f, text: deid.redact(f.text), quote: deid.redact(f.quote || '') }));
  const issueView = deid.walk(issue);
  const elements = deid.walk(result.elements);
  const evidenceIds = [...research.evidenceIds, ...research.adverseCandidateIds, ...research.documentIds];
  const material = [
    `[쟁점 ${issueView.id}] ${issueView.question}`,
    buildIssuePrefix(registry, issueView, facts),
    `[판단할 요건]\n${elements.map(e => `[${e.id}] ${e.isException ? '(예외) ' : ''}${e.text}`).join('\n')}`,
    `[근거 원문]\n${registry.renderFull(evidenceIds, { maxChars: MAX_MATERIAL_CHARS }).text}`
  ].join('\n\n');
  const mapping = deid.mapping();
  const used = Object.keys(mapping).filter(token => material.includes(token));
  const counts = {};
  for (const token of used) { const kind = token.slice(1, token.lastIndexOf('_')); counts[kind] = (counts[kind] || 0) + 1; }
  const digest = createHash('sha256').update(`${provider}|${issueId}|${material}`).digest('hex');
  return { issue: issueView, elements, facts, registry, material, mapping, counts, digest, remaining: remainingIdentifiers(material),
    replacements: used.length };
}

export function previewEscalation(ctx, issueId, { provider, terms = [] }) {
  const request = buildSanitizedRequest(ctx, issueId, { provider, terms });
  const research = ctx.research[issueId];
  return { issueId, provider, digest: request.digest, text: request.material, counts: request.counts,
    replacements: request.replacements, remaining: request.remaining,
    evidence: [...research.evidenceIds, ...research.documentIds].map(id => ctx.registry.get(id)?.label).filter(Boolean) };
}

const recomputeDependents = (ctx, changedIds) => {
  const changed = new Set(changedIds);
  for (const issue of ctx.caseIssues.issues) {
    if (!issue.dependsOn.some(d => changed.has(d))) continue;
    const r = ctx.issueResults.find(x => x.issueId === issue.id);
    if (!r || !(r.elements || []).length) continue;
    const predecessors = issue.dependsOn.map(id => ctx.issueResults.find(x => x.issueId === id)).filter(Boolean)
      .map(p => ({ issueId: p.issueId, legal: p.conclusion.legal, stageStatus: p.stageStatus }));
    r.conclusion = computeIssueConclusion(r.elements, r.assessments, predecessors);
    changed.add(issue.id);
  }
};

const issueRecord = (ctx, issue) => {
  const r = ctx.issueResults.find(x => x.issueId === issue.id);
  return { ...issue, research: ctx.research[issue.id], elements: r.elements, assessments: r.assessments, precedents: r.precedents,
    counter: r.counter, narrative: r.narrative, openQuestions: r.openQuestions, conclusion: r.conclusion, stageStatus: r.stageStatus,
    rulePropositions: r.rulePropositions || [], appliedAuthorities: r.appliedAuthorities || [],
    omittedEvidence: r.omittedEvidence, warnings: r.warnings, gateReasons: r.gateReasons || [],
    ...(r.source ? { source: r.source, externalProvider: r.externalProvider, externalModel: r.externalModel } : {}) };
};

/**
 * 승인된 쟁점을 외부 모델로 다시 판단하고 의견서를 갱신한다.
 * @returns {Promise<{ issueId, before, after, reviewPatch, reasoningPatch, warnings, externalNote }>}
 */
export async function runEscalation({ ctx, issueId, provider, model, apiKey, digest, terms = [], local = null }) {
  const request = buildSanitizedRequest(ctx, issueId, { provider, terms });
  if (request.digest !== digest) throw new EscalationError('승인한 전송 내용과 지금 전송할 내용이 달라 중단했습니다. 전송 내용을 다시 확인하십시오.', 409, 'DIGEST_MISMATCH');
  if (request.remaining.length) throw new EscalationError(`비식별 후 ${request.remaining.join(', ')}이(가) 남아 있어 전송하지 않았습니다. 가릴 단어를 추가해 다시 확인하십시오.`, 422, 'IDENTIFIERS_REMAIN');
  const result = ctx.issueResults.find(r => r.issueId === issueId);
  const issue = ctx.caseIssues.issues.find(i => i.id === issueId);
  const before = { legal: result.conclusion.legal, stageStatus: result.stageStatus };
  const session = createLlmSession();
  session.externalApproval = { scope: { provider, inputDigest: digest, label: `escalation:${issueId}` } };
  recordExternalTransmission({ provider, model, purpose: 'ISSUE_ESCALATION', issueId, digest, counts: request.counts, replacements: request.replacements });
  const predecessors = issue.dependsOn.map(id => ctx.issueResults.find(x => x.issueId === id)).filter(Boolean)
    .map(p => ({ issueId: p.issueId, legal: p.conclusion.legal, stageStatus: p.stageStatus }));
  const config = { model, apiKey, think: true, budget: resolveBudget(provider, { model, outputTokens: 8192 }) };
  const ext = await applyIssue({ issue: request.issue, elements: request.elements, research: ctx.research[issueId], registry: request.registry,
    facts: request.facts, runPrefix: buildIssuePrefix(request.registry, request.issue, request.facts), predecessors, provider, config, session,
    contractMode: ctx.preset === 'contract_risk' });
  if (ext.stageStatus === 'FAILED') {
    throw new EscalationError(`외부 LLM 판단이 실패했습니다: ${ext.error || '원인 미상'}. 기존 로컬 판단은 그대로 둡니다.`, 502, 'EXTERNAL_FAILED');
  }

  // 답변 속 대체 표기를 원래 값으로 되돌린다. 요건은 원본을 그대로 쓰고, 판단 항목만 외부 답변으로 바꾼다.
  const restored = reidentifyDeep({ assessments: ext.assessments, precedents: ext.precedents, counter: ext.counter, narrative: ext.narrative,
    reasoning: ext.reasoning, openQuestions: ext.openQuestions, warnings: ext.warnings, gateReasons: ext.gateReasons }, request.mapping);
  const merged = { ...ext, ...restored, elements: result.elements,
    assessments: restored.assessments.map(a => ({ ...a, origin: 'EXTERNAL' })),
    source: 'EXTERNAL', externalProvider: provider, externalModel: model,
    gateReasons: [...new Set([...(restored.gateReasons || []), '외부 LLM 답변이 반영됨 — 비식별 입력 기준이므로 전문가 확인 필요'])] };
  const warnings = [];
  // 근거 확인은 이 PC의 로컬 모델로 한다. 외부 답변을 외부 모델 스스로 검증하게 두지 않는다.
  let verification = null;
  if (local?.provider && local?.model) {
    try {
      verification = await verifyWarrants({ issueResults: [merged], registry: ctx.registry, provider: local.provider,
        config: { model: local.model, apiKey: local.apiKey, budget: resolveBudget(local.provider, { model: local.model, outputTokens: 1024 }) },
        session: createLlmSession(), contractMode: ctx.preset === 'contract_risk' });
      warnings.push(...verification.warnings);
    } catch (err) { warnings.push(`외부 답변의 근거 확인을 실행하지 못했습니다: ${err.message}`); }
  } else warnings.push('로컬 모델이 지정되지 않아 외부 답변의 근거 확인을 건너뛰었습니다.');
  if (verification) {
    ctx.ledger = [...ctx.ledger.filter(w => w.issueId !== issueId), ...verification.ledger];
    const decisive = new Set(merged.conclusion?.decidingElementIds || []);
    const blocking = verification.ledger.filter(w => decisive.has(w.elementId) && w.overall !== 'SUPPORTED');
    if (blocking.length) {
      merged.gateReasons.push(`외부 답변의 결론 요건 근거 확인 미완료 ${blocking.length}건`);
      if (merged.conclusion.legal !== 'CONDITIONAL') {
        merged.conclusion = { ...merged.conclusion, legal: 'CONDITIONAL',
          reasons: [...(merged.conclusion.reasons || []), '외부 답변이 인용한 근거가 주장을 충분히 뒷받침하는지 확인되지 않음'] };
      }
    }
  } else merged.gateReasons.push('외부 답변의 근거 확인을 거치지 않음');
  merged.warnings = [...(merged.warnings || []), ...warnings];

  ctx.issueResults = ctx.issueResults.map(r => r.issueId === issueId ? merged : r);
  recomputeDependents(ctx, [issueId]);
  const after = { legal: merged.conclusion.legal, stageStatus: merged.stageStatus };
  const prefix = `[외부 LLM 재검토 반영] 쟁점 ${issueId.slice(1)}:`;
  const note = `${prefix} ${LEGAL_LABEL[before.legal] || '판단 유보'} → ${LEGAL_LABEL[after.legal] || '판단 유보'}`
    + ` (${provider} ${model}, 비식별 입력 · 결론은 코드가 요건 판단으로 다시 계산)`;
  ctx.escalationNotes = [...(ctx.escalationNotes || []).filter(n => !n.startsWith(prefix)), note];
  const synthesis = { ...ctx.synthesis, table: conclusionTable(ctx.caseIssues.issues, ctx.issueResults),
    summary: `${ctx.synthesis.summary || ''}\n\n${ctx.escalationNotes.join('\n')}`.trim() };
  const review = renderReview({ caseIssues: ctx.caseIssues, issueResults: ctx.issueResults, synthesis, gaps: ctx.gaps, registry: ctx.registry,
    preset: ctx.preset, redlines: ctx.redlines, contractFindings: ctx.contractFindings, missingClauseAdditions: ctx.missingClauseAdditions,
    missingClauseAudit: ctx.missingClauseAudit, contractRegime: ctx.contractRegime });
  const reasoningPatch = { issues: ctx.caseIssues.issues.map(i => issueRecord(ctx, i)), warrants: ctx.ledger };
  return { issueId, before, after, reviewPatch: review, reasoningPatch, warnings, externalNote: note };
}
