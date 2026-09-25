// server/reasoning/pipeline.js - 단계형 법률 추론 파이프라인 (S0~S7)
//
//   S0 근거 등록부 → S1 사건·쟁점 → S2 쟁점별 조사 → S3 요건 분해 → S4 요건별 포섭(쟁점마다)
//   → S6 근거 검증 → S7 공백 산출 → S5 종합·조립
//
// S1은 사건 입력을 보고, 이후 단계는 조문·쟁점·주장 단위의 작은 입력을 본다.
// num_ctx는 실행 내내 같은 값을 쓴다(바꾸면 모델이 다시 적재된다).
//
// 재검토(외부 전문가 답변 반영): 이전 검토와 공식 근거가 같으면 S1·S2를 재사용하고,
// 답변이 연결된 쟁점과 그 후속 쟁점만 S4를 다시 돌린다. 근거가 바뀌었으면 처음부터 다시 한다.
import { createTokenCounter, resolveBudget } from '../law/llmBudget.js';
import { NOOP_PROGRESS, countLabel } from '../law/progressReporter.js';
import { buildEvidenceRegistry } from './evidenceRegistry.js';
import { normalizedLawName } from '../law/evidence.js';
import { normalizeArticleNo } from '../law/lawArticleRef.js';
import { buildCommonPrefix, PROMPT_VERSION, REASONING_SYSTEM } from './prompts.js';
import { planCaseAndIssues } from './stages/caseIssues.js';
import { planResearchQueries, reapplyResearch, runResearchQueries, selectIssueEvidence } from './stages/issueResearch.js';
import { decomposeArticles, selectIssueElements } from './stages/elements.js';
import { applyIssue, buildIssuePrefix } from './stages/application.js';
import { computeIssueConclusion } from './verify/conclusion.js';
import { verifyWarrants, verifyDocumentFindings } from './verify/warrant.js';
import { attachVerifiedRules, exactAuthorityMatch } from './verifiedRules.js';
import { deriveGaps } from './stages/gaps.js';
import { draftRedlines, renderReview, synthesize } from './stages/synthesis.js';
import { attachContractInventory, buildContractInventory, contractAssessments, scoreContractRisk } from './contractReview.js';

export class PipelineError extends Error {
  constructor(message, cause) { super(message); this.name = 'PipelineError'; this.cause = cause; }
}

/** 단계별 출력 예약. num_predict만 바뀌고 num_ctx는 같으므로 모델 재적재가 없다. */
const OUTPUT_TOKENS = { s1: 3072, s3: 2048, s4: 3072, s4Think: 8192, s5: 1536, s6: 1024 };
// S1 지시문·형식·재시도 피드백을 위한 공간. 이후 단계는 이 접두부를 재사용하지 않는다.
const S1_TASK_RESERVE_CHARS = 2500;

export const pipelineEnabled = (llmConfig = {}) =>
  (llmConfig.pipeline || process.env.REVIEW_PIPELINE || 'monolithic') === 'staged';

const thinkStages = () => new Set(String(process.env.REVIEW_THINK_STAGES || '').split(',').map(s => s.trim()).filter(Boolean));
const maxIssues = preset => preset === 'contract_risk' ? Math.min(30, Math.max(15, parseInt(process.env.REVIEW_MAX_ISSUES || '15', 10) || 15))
  : Math.min(8, Math.max(1, parseInt(process.env.REVIEW_MAX_ISSUES || '5', 10) || 5));

/** 선결 쟁점이 먼저 오도록 정렬한다. 순환은 S1에서 이미 끊었다. */
export function orderByDependency(issues) {
  const ordered = [];
  const placed = new Set();
  const visit = issue => {
    if (placed.has(issue.id)) return;
    placed.add(issue.id);
    for (const dep of issue.dependsOn) { const d = issues.find(i => i.id === dep); if (d) visit(d); }
    ordered.push(issue);
  };
  issues.forEach(visit);
  return ordered;
}

/** 주어진 쟁점과 그것에 (간접적으로) 기대는 후속 쟁점 전부. */
export function withDependents(issues, ids) {
  const result = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const issue of issues) {
      if (!result.has(issue.id) && issue.dependsOn.some(d => result.has(d))) { result.add(issue.id); grew = true; }
    }
  }
  return result;
}

/** 등록부의 공식 근거 지문. 외부 참고 지식(K)은 재검토마다 달라지므로 뺀다. */
const evidenceFingerprint = entries => entries.filter(e => e.kind !== 'KNOWLEDGE').map(e => `${e.id}:${e.textHash}`).join('|');
const reusableWithSupplement = (current, previous, supplements) => {
  const old = new Map(previous.filter(e => e.kind !== 'KNOWLEDGE').map(e => [e.id, e]));
  const now = new Map(current.filter(e => e.kind !== 'KNOWLEDGE').map(e => [e.id, e]));
  if ([...old].some(([id, entry]) => now.get(id)?.textHash !== entry.textHash)) return false;
  const allowed = new Set((supplements || []).map(a =>
    `${normalizedLawName(a.lawName)}|${normalizeArticleNo(a.fullArticleNo || a.articleNo)}`));
  return [...now].filter(([id]) => !old.has(id)).every(([, entry]) => {
    const root = entry.parentId ? now.get(entry.parentId) : entry;
    return root?.kind === 'ARTICLE' && root.official
      && allowed.has(`${normalizedLawName(root.lawName)}|${normalizeArticleNo(root.articleNo)}`);
  });
};

/** 이전 검토의 쟁점 기록을 S4 결과 형태로 되돌린다. */
const reusedResult = issue => ({ issueId: issue.id, elements: issue.elements, assessments: issue.assessments, precedents: issue.precedents,
  counter: issue.counter, narrative: issue.narrative, openQuestions: issue.openQuestions, conclusion: issue.conclusion,
  stageStatus: issue.stageStatus, omittedEvidence: issue.omittedEvidence || [], evidenceIds: issue.research?.evidenceIds || [],
  documentIds: issue.research?.documentIds || [],
  gateReasons: issue.gateReasons || [], warnings: issue.warnings || [], reused: true });

const PIPELINE_FIELDS = ['research', 'elements', 'assessments', 'precedents', 'counter', 'narrative', 'openQuestions', 'conclusion',
  'stageStatus', 'omittedEvidence', 'warnings', 'gateReasons'];
const bareIssue = issue => Object.fromEntries(Object.entries(issue).filter(([k]) => !PIPELINE_FIELDS.includes(k)));

/** 확정된 요건 판단은 유지하고, 답변이 연결된 요건의 새 판단만 끼워 넣는다. */
function patchIssue(prior, fresh, predecessors, registry) {
  const changed = new Map(fresh.assessments.map(a => [a.elementId, a]));
  const assessments = prior.assessments.map(a => changed.get(a.elementId) || a);
  let conclusion = computeIssueConclusion(prior.elements, assessments, predecessors);
  const omittedEvidence = [...new Set([...(prior.omittedEvidence || []), ...(fresh.omittedEvidence || [])])];
  const decisive = new Set(conclusion.decidingElementIds || []);
  if (fresh.stageStatus === 'FAILED' || prior.elements.some(e => decisive.has(e.id) && e.fallback && e.blocksConclusion === true)) {
    conclusion = { ...conclusion, legal: 'CONDITIONAL', reasons: [...(conclusion.reasons || []), '일부 요건 또는 근거를 검토하지 못함'] };
  }
  const counter = fresh.counter?.position ? fresh.counter : prior.counter;
  const gateReasons = [];
  if (fresh.stageStatus === 'FAILED') gateReasons.push('외부 답변으로 보충할 요건 판단 실패');
  if (omittedEvidence.length && conclusion.legal === 'CONDITIONAL')
    gateReasons.push(`결론 요건에서 처리하지 못한 근거: ${omittedEvidence.join(', ')}`);
  if (prior.elements.some(e => decisive.has(e.id) && e.fallback && e.blocksConclusion === true)) gateReasons.push('결론을 좌우한 요건이 골격으로 대체됨');
  if (!assessments.some(a => a.evidenceIds.some(id => registry.get(id)?.official))) gateReasons.push('공식 근거에 기댄 요건 판단이 없음');
  if (assessments.filter(a => conclusion.decidingElementIds.includes(a.elementId)).some(a => a.knowledgeOnly))
    gateReasons.push('결론을 좌우한 요건이 외부 참고 지식에만 기댐');
  if (counter?.position && !counter.response) gateReasons.push('가장 강한 반대 논리에 대한 응답 없음');
  return { ...fresh, elements: prior.elements, assessments, conclusion,
    precedents: [...(prior.precedents || []), ...(fresh.precedents || [])],
    counter, narrative: fresh.narrative || prior.narrative,
    openQuestions: assessments.filter(a => a.openQuestion).map(a => ({ elementId: a.elementId, question: a.openQuestion })),
    evidenceIds: [...new Set([...(prior.research?.evidenceIds || []), ...(fresh.evidenceIds || [])])],
    omittedEvidence, warnings: [...(fresh.warnings || [])], gateReasons };
}

/**
 * @param {object} args
 * @param {object} args.session createLlmSession 결과 (호출 원장 공유)
 * @param {object} [args.previous] 재검토: { reasoning: 이전 review.reasoning, rerunIssueIds: string[], knowledgeIssues: Map<knowledgeId, issueId[]> }
 * @param {object} [args.clients] 판례·해석례 검색 함수 주입(시험용)
 * @param {Function} [args.embed] 임베딩 함수 주입(시험용)
 * @param {object} [args.cache] 요건 분해 캐시 주입(시험용)
 */
export async function runReasoningPipeline({ query, preset, documentText = '', workbenchContext, provider, model, apiKey,
  session, progress = NOOP_PROGRESS, previous = null, clients, embed, cache }) {
  const base = resolveBudget(provider, { model });
  const budgetFor = outputTokens => resolveBudget(provider, { model, contextTokens: base.contextTokens, outputTokens: Math.min(outputTokens, base.outputTokens) });
  const configFor = (stage, think = false) => ({ model, apiKey, think,
    budget: budgetFor(stage === 's4' && think ? OUTPUT_TOKENS.s4Think : OUTPUT_TOKENS[stage]) });
  const counter = createTokenCounter(provider, { model });
  const warnings = [];
  const embedOption = embed ? { embed } : {};

  // ── S0 근거 등록부와 공통 접두부 ──
  progress.start('s0', '근거 등록부 구성', '조문·판례·해석례·첨부문서에 ID 부여', '분석');
  const registry0 = buildEvidenceRegistry(workbenchContext, { documentText });
  const contractInventory = preset === 'contract_risk' && documentText ? buildContractInventory(registry0, query) : null;
  const s1Limit = budgetFor(OUTPUT_TOKENS.s1).inputLimit;
  let budgets = { document: 14000, index: 6000 };
  let common = buildCommonPrefix({ registry: registry0, query, preset, budgets });
  for (let i = 0; i < 12 && counter.estimate(REASONING_SYSTEM, common.text + 'x'.repeat(S1_TASK_RESERVE_CHARS)).tokens > s1Limit; i++) {
    budgets = { document: Math.floor(budgets.document * 0.75), index: Math.floor(budgets.index * 0.75) };
    common = buildCommonPrefix({ registry: registry0, query, preset, budgets });
  }
  progress.done('s0', `근거 ${countLabel(registry0.size, '개')} 등록 · 문서 조항 ${countLabel(common.documentIncluded.length, '개')}`);

  // ── 재검토: 이전 검토와 공식 근거가 같은지 ──
  let reuse = null;
  if (previous?.reasoning?.version && previous.reasoning.promptVersion === PROMPT_VERSION) {
    const addedItems = previous.reasoning.diagnostics?.research?.addedItems || {};
    const candidate = buildEvidenceRegistry(reapplyResearch(workbenchContext, addedItems), { documentText });
    if (evidenceFingerprint(candidate.list()) === evidenceFingerprint(previous.reasoning.evidence || [])
      || reusableWithSupplement(candidate.list(), previous.reasoning.evidence || [],
        workbenchContext.officialEvidence?.supplementalArticles)) {
      reuse = { registry: candidate, addedItems };
    } else {
      throw new PipelineError('원 검토 이후 공식 근거가 달라졌습니다. 저장된 쟁점 구조에 외부 답변을 끼워 넣을 수 없으므로 최종 재검토를 중단했습니다.');
    }
  }
  if (previous && !reuse) throw new PipelineError('원 검토의 추론 구조를 재사용할 수 없어 최종 재검토를 중단했습니다.');

  let caseIssues;
  let plan;
  let research;
  let registry;
  const perIssue = new Map();
  if (reuse) {
    const prior = previous.reasoning;
    caseIssues = { facts: prior.facts, issues: prior.issues.map(bareIssue), unknownFacts: prior.unknownFacts || [],
      unreviewedCandidates: prior.unreviewedCandidates || [],
      diagnostics: { ...(prior.diagnostics?.s1 || {}), reused: true } };
    registry = reuse.registry;
    plan = { queries: prior.diagnostics?.research?.queries || [], skipped: prior.diagnostics?.research?.skippedQueries || [],
      byIssue: Object.fromEntries(prior.issues.map(i => [i.id, i.research?.queries || []])) };
    research = { added: prior.diagnostics?.research?.added || {}, addedItems: reuse.addedItems, warnings: [] };
    for (const issue of prior.issues) perIssue.set(issue.id, { ...issue.research });
    progress.mark('s1', '사건 사실·쟁점 정리', `이전 검토 재사용 — 쟁점 ${countLabel(caseIssues.issues.length, '개')}`,
      '분석', 'DONE', { totalIssues: caseIssues.issues.length });
    progress.mark('s2', '쟁점별 판례·해석례 조사', '이전 검토 재사용 (공식 근거 동일)', '수집');
  } else {
    // ── S1 사건·쟁점 ──
    progress.start('s1', '사건 사실·쟁점 정리', '쟁점을 먼저 확정하고 근거 후보를 ID로 지정', '분석');
    try {
      caseIssues = await planCaseAndIssues({ registry: registry0, query, preset, prefix: common.text, provider,
        config: configFor('s1'), session, maxIssues: maxIssues(preset), preserveIssues: preset === 'contract_risk',
        forceSplit: common.documentOmitted.length > 0 });
    } catch (err) {
      progress.fail('s1', `쟁점 정리 실패: ${err.message}`);
      throw new PipelineError(`쟁점 정리(S1) 실패: ${err.message}`, err);
    }
    if (contractInventory) caseIssues = attachContractInventory(caseIssues, contractInventory, registry0);
    if (!caseIssues.issues.length) {
      progress.fail('s1', '쟁점을 세우지 못했습니다');
      throw new PipelineError('쟁점을 세우지 못했습니다.');
    }
    const d1 = caseIssues.diagnostics;
    if (d1.skippedDocumentIds?.length) warnings.push(`쟁점 추출에서 문서 조각 ${d1.skippedDocumentIds.join(', ')}를 처리하지 못했습니다.`);
    if (d1.queryTruncated) warnings.push(`쟁점 추출에서 질의 구간 ${(d1.skippedQueryRanges || []).map(([start, end]) => `${start}-${end}`).join(', ')}을 처리하지 못했습니다.`);
    progress.done('s1', `쟁점 ${countLabel(caseIssues.issues.length, '개')} · 사실 ${countLabel(caseIssues.facts.length, '개')}`
      + `${d1.downgradedFacts.length ? ` · 원문 미확인 사실 ${d1.downgradedFacts.length}` : ''}${d1.rejectedIds.length ? ` · 없는 근거 ID 제거 ${d1.rejectedIds.length}` : ''}`,
    'DONE', { totalIssues: caseIssues.issues.length });

    // ── S2 쟁점별 조사 ──
    progress.start('s2', '쟁점별 판례·해석례 조사', '', '수집');
    plan = planResearchQueries(caseIssues.issues, registry0, preset === 'contract_risk'
      ? { termsPerIssue: 2, articleQueries: 1, totalQueries: 30, perQuery: 3 }
      : undefined);
    if (plan.skipped.length) warnings.push(`검색어 상한으로 추가 조사를 수행하지 못한 검색어 ${plan.skipped.length}개가 있습니다.`);
    research = await runResearchQueries(workbenchContext, plan, { ...(clients ? { clients } : {}), issues: caseIssues.issues,
      provider, model, apiKey, session });
    warnings.push(...research.warnings);
    registry = buildEvidenceRegistry(research.context, { documentText });
    for (const issue of caseIssues.issues) {
      const selected = await selectIssueEvidence({ issue, registry, facts: caseIssues.facts, plan, hits: research.hits, ...embedOption });
      if (selected.warning && !warnings.includes(selected.warning)) warnings.push(selected.warning);
      perIssue.set(issue.id, selected);
    }
    progress.done('s2', `검색어 ${countLabel(plan.queries.length, '개')} · 새 판례 ${countLabel(research.added.precedents)} · 새 해석례 ${countLabel(research.added.interpretations)}`);
  }

  // 재검토에서는 연결된 공백과 그 결론에 의존하는 쟁점만 갱신한다.
  const allIds = caseIssues.issues.map(i => i.id);
  const unknownTargets = [...(previous?.knowledgeTargets?.values() || [])].flat()
    .filter(target => !allIds.includes(target.issueId));
  if (unknownTargets.length) throw new PipelineError('외부 답변의 쟁점 연결을 원 검토에서 찾을 수 없어 재검토를 중단했습니다.');
  const anchored = (previous?.rerunIssueIds || []).filter(id => allIds.includes(id));
  const rerun = reuse ? withDependents(caseIssues.issues, anchored.length ? anchored : allIds) : new Set(allIds);
  // 외부 참고 지식(K)은 연결된 쟁점의 입력에 싣는다. 연결 정보가 없으면 다시 판단하는 모든 쟁점에 싣는다.
  const knowledgeFor = issueId => registry.list(e => e.kind === 'KNOWLEDGE').filter(k => {
    const linked = previous?.knowledgeIssues?.get(k.knowledgeId);
    return linked?.length ? linked.includes(issueId) : true;
  }).map(k => k.id);

  // ── S3 요건 분해 ──
  let decomposed;
  if (reuse) {
    decomposed = { byArticle: new Map(), warnings: [] };
    progress.mark('s3', '조문 요건 분해', '원 검토의 요건 구조 재사용', '분석');
  } else {
    progress.start('s3', '조문 요건 분해', '조문에서 요건 추출', '분석');
    const articleIds = [...new Set(caseIssues.issues.filter(i => rerun.has(i.id)).flatMap(i => perIssue.get(i.id).evidenceIds)
      .map(id => registry.get(id)).filter(Boolean).map(e => e.parentId || e.id).filter(id => /^[AO]\d+$/.test(id)))];
    decomposed = await decomposeArticles({ articleIds, registry, provider, config: configFor('s3'), session, ...(cache !== undefined ? { cache } : {}) });
    warnings.push(...decomposed.warnings);
    for (const warning of decomposed.warnings) progress.warn('s3', warning);
    const sources = [...decomposed.byArticle.values()].map(v => v.source);
    progress.done('s3', `조문 ${countLabel(articleIds.length, '개')} · 재사용 ${sources.filter(s => s === 'CACHE').length} · 새로 분해 ${sources.filter(s => s === 'LLM').length}`
      + `${sources.some(s => s === 'SKELETON' || s === 'PARTIAL') ? ` · 미검증 요건 ${sources.filter(s => s === 'SKELETON' || s === 'PARTIAL').length}` : ''}`);
  }

  // ── S4 요건별 포섭 ──
  const think = thinkStages().has('s4');
  const issueResults = [];
  const directlyUpdated = new Set();
  for (const issue of orderByDependency(caseIssues.issues)) {
    const key = `s4:${issue.id}`;
    if (!rerun.has(issue.id)) {
      issueResults.push(reusedResult(previous.reasoning.issues.find(i => i.id === issue.id)));
      progress.mark(key, `쟁점 ${issue.id} 요건별 포섭`, '이전 판단 재사용 (연결된 외부 답변 없음)', '작성');
      continue;
    }
    progress.start(key, `쟁점 ${issue.id} 요건별 포섭`, issue.question.slice(0, 60), '작성');
    const selected = perIssue.get(issue.id);
    const knowledgeIds = knowledgeFor(issue.id);
    const prior = reuse ? previous.reasoning.issues.find(i => i.id === issue.id) : null;
    const predecessors = issue.dependsOn.map(id => issueResults.find(r => r.issueId === id))
      .filter(Boolean).map(r => ({ issueId: r.issueId, legal: r.conclusion.legal, stageStatus: r.stageStatus }));
    if (prior && !knowledgeIds.length) {
      const result = reusedResult(prior);
      result.conclusion = computeIssueConclusion(result.elements, result.assessments, predecessors);
      issueResults.push(result);
      progress.done(key, '기존 요건 판단 유지 · 선결 쟁점 결론만 갱신');
      continue;
    }
    const research = knowledgeIds.length ? { ...selected, evidenceIds: [...selected.evidenceIds, ...knowledgeIds] } : selected;
    const targets = [...(previous?.knowledgeTargets?.values() || [])].flat().filter(t => t.issueId === issue.id);
    const targetedIds = new Set(targets.map(t => t.elementId).filter(Boolean));
    if (prior && [...targetedIds].some(id => !prior.elements.some(e => e.id === id))) {
      throw new PipelineError(`외부 답변이 연결된 ${issue.id} 요건을 원 검토에서 찾을 수 없어 재검토를 중단했습니다.`);
    }
    const narrow = prior && targets.length && targets.every(t => t.elementId) && targetedIds.size;
    const elements = prior ? (narrow ? prior.elements.filter(e => targetedIds.has(e.id)) : prior.elements)
      : selectIssueElements({ ...issue, evidenceIds: selected.evidenceIds }, decomposed.byArticle, registry);
    const issueFacts = caseIssues.facts.filter(f => issue.factIds.includes(f.id));
    const freshResult = await applyIssue({ issue, elements, research, registry, facts: issueFacts,
      runPrefix: buildIssuePrefix(registry, issue, issueFacts), predecessors,
      provider, config: configFor('s4', think), session, contractMode: preset === 'contract_risk' });
    const result = narrow ? patchIssue(prior, freshResult, predecessors, registry) : freshResult;
    directlyUpdated.add(issue.id);
    issueResults.push(result);
    if (result.stageStatus === 'FAILED') progress.fail(key, `판단 실패 — 판단 유보로 처리 (${result.error})`);
    else progress.done(key, `${result.conclusion.legal} · 요건 ${countLabel(elements.length, '개')}${knowledgeIds.length ? ` · 외부 답변 ${knowledgeIds.length}건 반영` : ''}`,
      result.stageStatus === 'SKIPPED' ? 'SKIPPED' : 'DONE');
    for (const w of result.warnings) progress.warn(key, w);
  }
  // 결과는 원래 쟁점 순서로 둔다.
  issueResults.sort((a, b) => a.issueId.localeCompare(b.issueId, 'en', { numeric: true }));
  const findings = contractInventory ? contractAssessments(caseIssues.issues, issueResults, contractInventory, registry) : [];
  const documentWarrants = verifyDocumentFindings(findings, registry);

  // ── S6 근거 검증 (다시 판단한 쟁점만; 나머지는 이전 원장을 쓴다) ──
  progress.start('s6', '근거-주장 대응 검증', '존재·공식성·시점 확인 후 모든 주장·근거 쌍의 함의 확인', '검증');
  const fresh = await verifyWarrants({ issueResults: issueResults.filter(r => !r.reused), registry, provider,
    config: configFor('s6'), session, ...embedOption, entailment: process.env.REVIEW_ENTAILMENT !== 'off',
    contractMode: preset === 'contract_risk' });
  warnings.push(...fresh.warnings);
  for (const warning of fresh.warnings) progress.warn('s6', warning);
  const ledger = [...(previous?.reasoning?.warrants || []).filter(w => reuse && !directlyUpdated.has(w.issueId)), ...fresh.ledger];
  attachVerifiedRules(issueResults, ledger, registry, caseIssues.facts);
  for (const result of issueResults) {
    const decisiveIds = new Set(result.conclusion?.decidingElementIds || []);
    const unresolved = ledger.filter(w => w.issueId === result.issueId && w.overall !== 'SUPPORTED');
    if (!unresolved.length) continue;
    const blockingUnresolved = unresolved.filter(w => decisiveIds.has(w.elementId));
    result.warnings = [...(result.warnings || []), `근거-주장 검증 미완료 ${unresolved.length}건`];
    if (!blockingUnresolved.length) {
      if (result.stageStatus === 'OK') result.stageStatus = 'OK_WITH_WARNINGS';
      continue;
    }
    result.stageStatus = result.stageStatus === 'FAILED' ? 'FAILED' : 'PARTIAL';
    result.gateReasons = [...(result.gateReasons || []), `결론 요건 근거-주장 검증 미완료 ${blockingUnresolved.length}건`];
    if (result.conclusion.legal !== 'CONDITIONAL') result.conclusion = { ...result.conclusion, legal: 'CONDITIONAL',
      reasons: [...(result.conclusion.reasons || []), '인용 근거가 주장을 충분히 뒷받침하는지 확인되지 않음'] };
  }
  for (const finding of findings) {
    const linked = issueResults.find(r => r.issueId === finding.issueId);
    const verifiedIds = linked?.appliedAuthorities || [];
    finding.authorityEvidenceIds = verifiedIds;
    finding.legalAssessment.authorityEvidenceIds = verifiedIds;
    const documentCheck = documentWarrants.find(w => w.issueId === finding.issueId && w.kind === finding.kind);
    const legalChecks = ledger.filter(w => w.issueId === finding.issueId);
    if (documentCheck?.overall !== 'SUPPORTED') {
      finding.facialRisk = 'NONE';
      finding.facialAssessment.risk = 'NONE';
      finding.documentConclusion.status = 'UNCONFIRMED';
      finding.facialRiskConclusion.status = 'UNCONFIRMED';
      finding.facialRiskConclusion.level = 'NONE';
    }
    const decisiveIds = new Set(linked?.conclusion?.decidingElementIds || []);
    const blockingChecks = legalChecks.filter(w => decisiveIds.has(w.elementId) && w.overall !== 'SUPPORTED');
    const decisiveVerified = decisiveIds.size > 0 && [...decisiveIds].every(id =>
      legalChecks.some(w => w.elementId === id && w.overall === 'SUPPORTED'));
    const missingDecisiveFact = [...decisiveIds].some(id => {
      const assessment = linked?.assessments?.find(a => a.elementId === id);
      const element = linked?.elements?.find(e => e.id === id);
      return (assessment?.status === 'UNKNOWN' || assessment?.factStatus === 'UNKNOWN')
        && element?.factRequirement === 'EXTERNAL';
    });
    const materialExternalFactsMissing = missingDecisiveFact
      || finding.additionalFactDetails.some(f => f.materiality === 'OUTCOME_DETERMINATIVE');
    finding.legalValidity = linked?.stageStatus === 'FAILED' ? 'FAILED'
      : blockingChecks.length || !decisiveVerified ? 'AUTHORITY_INCOMPLETE'
        : materialExternalFactsMissing ? 'CONDITIONAL_ON_MATERIAL_FACT'
          : legalChecks.some(w => !decisiveIds.has(w.elementId) && w.overall !== 'SUPPORTED')
            ? 'REVIEWED_WITH_WARNINGS' : 'REVIEWED';
    finding.legalAssessment.status = finding.legalValidity;
    finding.legalValidityConclusion.status = finding.legalValidity;
    finding.legalValidityConclusion.reason = finding.legalValidity === 'CONDITIONAL_ON_MATERIAL_FACT'
      ? finding.additionalFactDetails.filter(f => f.materiality === 'OUTCOME_DETERMINATIVE').map(f => f.text).join(' / ')
      : finding.legalValidity === 'AUTHORITY_INCOMPLETE' ? '결론 요건의 공식 근거 검증이 완료되지 않음' : '';
    finding.riskAxes = scoreContractRisk(finding,
      { institutionType: contractInventory?.regime?.publicProcurement?.institutionType });
  }
  const tally = status => ledger.filter(w => w.overall === status).length;
  progress.done('s6', `주장 ${countLabel(ledger.length, '개')} · 뒷받침 ${tally('SUPPORTED')} · 미확인 ${tally('UNCONFIRMED')} · 공식 근거 없음 ${tally('NO_OFFICIAL_SUPPORT')} · 불일치 ${tally('NOT_SUPPORTED')}`);

  // ── S7 공백 ──
  const gaps = deriveGaps({ issues: caseIssues.issues, issueResults, warrants: ledger, unknownFacts: caseIssues.unknownFacts,
    collectionWarnings: research.warnings, contractMode: preset === 'contract_risk', registry });
  // 이전 공백이 이번 판단에서 사라졌으면 해소, 남았으면 미해결로 표시한다. 답을 받았다는 것과 판단이 확정됐다는 것은 다르다.
  const transitions = [];
  if (reuse) {
    const key = g => `${g.issueId}|${g.elementId || ''}|${g.type}`;
    const now = new Map(gaps.map(g => [key(g), g]));
    for (const old of previous.reasoning.gaps || []) {
      if (old.route !== 'EXTERNAL_INQUIRY' || !rerun.has(old.issueId)) continue;
      const still = now.get(key(old));
      transitions.push({ previousGapId: old.id, question: old.question, state: still ? 'STILL_OPEN' : 'RESOLVED', currentGapId: still?.id || null });
      if (still) still.state = still.state === 'DEFERRED' ? still.state : 'STILL_OPEN';
    }
  }
  const inquiry = gaps.filter(g => g.route === 'EXTERNAL_INQUIRY' && ['OPEN', 'STILL_OPEN'].includes(g.state));
  progress.mark('s7', '판단 공백 정리', `외부 전문가 질의 ${countLabel(inquiry.length)} · 사용자 확인 ${countLabel(gaps.filter(g => g.route === 'USER').length)}`
    + `${transitions.length ? ` · 해소 ${transitions.filter(t => t.state === 'RESOLVED').length}/${transitions.length}` : ''}`, '검증');

  // ── S5 종합·조립 ──
  progress.start('s5', '종합 요약·검토의견서 조립', '', '작성');
  const finalReviewData = reuse ? {
    facts: caseIssues.facts.map(f => ({ id: f.id, text: f.text, status: f.status })),
    issues: caseIssues.issues.map(issue => {
      const result = issueResults.find(r => r.issueId === issue.id);
      return { id: issue.id, question: issue.question, dependsOn: issue.dependsOn,
        assessments: result.assessments.map(a => ({ elementId: a.elementId, status: a.status, proof: a.proof,
          analysis: a.analysis, evidenceIds: a.evidenceIds })),
        counter: result.counter, conclusion: result.conclusion };
    }),
    remainingGaps: gaps.map(g => ({ issueId: g.issueId, elementId: g.elementId, type: g.type, question: g.question }))
  } : null;
  const synthesis = await synthesize({ issues: caseIssues.issues, issueResults, registry, preset, provider,
    config: configFor('s5'), session, finalReviewData, contractFindings: findings });
  if (synthesis.warning) warnings.push(synthesis.warning);
  // 수정 조문은 첨부문서가 있고, 견해 비교가 산출물인 사전 컨설팅감사가 아닐 때만 만든다.
  const redline = documentText && preset !== 'pre_consulting_audit'
    ? await draftRedlines({ issues: caseIssues.issues, issueResults, synthesis, registry, provider, config: configFor('s5'), session,
      contractFindings: findings })
    : { redlines: [], warnings: [] };
  warnings.push(...redline.warnings);
  const review = renderReview({ caseIssues, issueResults, synthesis, gaps, registry, preset, redlines: redline.redlines,
    contractFindings: findings, missingClauseAdditions: contractInventory?.missingClauseAdditions || [],
    missingClauseAudit: contractInventory?.missingClauseAudit || [], contractRegime: contractInventory?.regime || null });
  progress.done('s5', synthesis.source === 'LLM' ? '요약 생성' : '요약 생성 실패 — 결론 표로 대체', synthesis.source === 'LLM' ? 'DONE' : 'FAILED');

  const gateReasons = [...new Set(issueResults.flatMap(r => (r.gateReasons || []).map(g => `${r.issueId}: ${g}`)))];
  if (synthesis.source !== 'LLM') gateReasons.push('종합 요약 호출 실패 — 결론 표로 대체됨');
  if (redline.warnings.length) gateReasons.push(`수정 조문 생성 미완료: ${redline.warnings.join(' / ')}`);
  const incompleteArticles = [...decomposed.byArticle].filter(([, v]) => v.source === 'SKELETON' || v.source === 'PARTIAL').map(([id]) => id);
  if (incompleteArticles.length) gateReasons.push(`요건 분해 미검증 조문: ${incompleteArticles.join(', ')}`);
  if (fresh.unreviewedPairs.length) gateReasons.push(`함의 확인 미완료 쌍: ${fresh.unreviewedPairs.map(p => `${p.claimId}/${p.evidenceId}`).join(', ')}`);
  if (caseIssues.diagnostics?.skippedDocumentIds?.length) gateReasons.push('첨부문서 일부를 토큰 한도로 분석하지 못함');
  if (caseIssues.diagnostics?.queryTruncated) gateReasons.push('긴 질의 일부를 분할 쟁점 추출에 포함하지 못함');
  if (common.indexOmitted || caseIssues.diagnostics?.indexOmitted) gateReasons.push('쟁점 추출에서 공식 근거 색인 일부를 보지 못함');
  if (plan.skipped.length) gateReasons.push(`추가 조사에서 처리하지 못한 검색어 ${plan.skipped.length}개`);
  if (caseIssues.diagnostics?.droppedIssues?.length) gateReasons.push(`쟁점 상한으로 제외된 쟁점 ${caseIssues.diagnostics.droppedIssues.length}개`);
  if (caseIssues.unreviewedCandidates?.length) gateReasons.push(`계약 조항과 연결되지 않은 쟁점 후보 ${caseIssues.unreviewedCandidates.length}개`);
  for (const result of issueResults.filter(r => r.stageStatus === 'SKIPPED')) {
    gateReasons.push(`${result.issueId}: 적용할 공식 근거 또는 판단 요건이 없어 쟁점을 검토하지 못함`);
  }
  if (tally('NOT_SUPPORTED')) gateReasons.push(`근거가 뒷받침하지 않는 주장 ${tally('NOT_SUPPORTED')}개`);
  if (tally('UNCONFIRMED')) gateReasons.push(`근거와 주장의 관계가 미확인된 주장 ${tally('UNCONFIRMED')}개`);
  if (tally('NO_OFFICIAL_SUPPORT')) gateReasons.push(`공식 근거가 없는 주장 ${tally('NO_OFFICIAL_SUPPORT')}개`);
  if (documentWarrants.some(w => w.overall !== 'SUPPORTED')) gateReasons.push('계약 문언과 출처 연결 검증 실패');
  const complete = issueResults.every(r => ['OK', 'OK_WITH_WARNINGS'].includes(r.stageStatus))
    && !gateReasons.length && !inquiry.length;
  review.reviewStatus = complete ? 'COMPLETE' : 'PARTIAL';
  review.reasoning = {
    version: 2, promptVersion: PROMPT_VERSION, asOfDate: registry.asOf,
    contractRegime: contractInventory?.regime || null, contractFindings: findings,
    missingClauseAudit: contractInventory?.missingClauseAudit || [],
    facts: caseIssues.facts, unknownFacts: caseIssues.unknownFacts,
    unreviewedCandidates: caseIssues.unreviewedCandidates || [],
    issues: caseIssues.issues.map(issue => {
      const r = issueResults.find(x => x.issueId === issue.id);
      const s = perIssue.get(issue.id);
      return { ...issue, research: { queries: plan.byIssue[issue.id] || [], evidenceIds: s.evidenceIds, adverseCandidateIds: s.adverseCandidateIds,
        documentIds: s.documentIds, candidates: s.candidates }, elements: r.elements, assessments: r.assessments, precedents: r.precedents,
        counter: r.counter, narrative: r.narrative, openQuestions: r.openQuestions, conclusion: r.conclusion, stageStatus: r.stageStatus,
        rulePropositions: r.rulePropositions || [], appliedAuthorities: r.appliedAuthorities || [],
        omittedEvidence: r.omittedEvidence, warnings: r.warnings, gateReasons: r.gateReasons || [], ...(r.reused ? { reused: true } : {}) };
    }),
    warrants: ledger, documentWarrants, gaps,
    gate: gateReasons.length ? 'HUMAN_REVIEW_REQUIRED' : 'OK', gateReasons,
    reuse: reuse ? { fromHistoryId: previous.historyId || null, evidenceMatched: true, rerunIssueIds: [...rerun], reusedStages: ['S1', 'S2', 'S3'],
      gapTransitions: transitions } : null,
    diagnostics: { s1: caseIssues.diagnostics,
      // 조사로 덧붙인 자료 원문을 남겨 둔다. 재검토에서 등록부를 똑같이 다시 만들려면 필요하다.
      research: { queries: plan.queries, skippedQueries: plan.skipped, added: research.added,
        screening: research.screening || [], addedItems: research.addedItems || {} },
      ...(contractInventory ? { contract: {
        detectedFindings: contractInventory.findings.length,
        linkedFindings: findings.filter(f => f.documentSupportIds.length).length,
        documentLinkRate: caseIssues.issues.length
          ? caseIssues.issues.filter(i => i.documentIds?.length).length / caseIssues.issues.length : 0,
        documentWarrantSupportRate: documentWarrants.length
          ? documentWarrants.filter(w => w.overall === 'SUPPORTED').length / documentWarrants.length : 0,
        missingClauses: contractInventory.missingClauseAdditions.length,
        redlineCoverage: new Set(redline.redlines.flatMap(d => d.issueIds || []).filter(id => findings.some(f => f.issueId === id))).size
          / Math.max(1, new Set(findings.map(f => f.issueId)).size),
        authorityPrecision: (() => {
          const applied = issueResults.flatMap(r => r.appliedAuthorities || []);
          return applied.length ? applied.filter(id => registry.get(id)?.official && registry.get(id)?.inForce).length / applied.length : null;
        })(),
        ruleAuthorityAccuracy: (() => {
          const checks = ledger.flatMap(w => (w.checks || []).map(c => ({ claim: w.text, check: c })));
          return checks.length ? checks.filter(({ claim, check }) => ['SUPPORTS', 'PARTIAL'].includes(check.entailment)
            && exactAuthorityMatch(claim, registry.get(check.evidenceId))).length / checks.length : null;
        })(),
        elementRelevance: (() => {
          const elements = issueResults.flatMap(r => r.elements || []);
          return elements.length ? elements.filter(e => e.relevance === 'DECISIVE' || e.relevance === 'SUPPORTING').length / elements.length : null;
        })(),
        synthesisSuccessRate: synthesis.source === 'LLM' ? 1 : 0,
        reportCompressionRatio: registry.list().reduce((n, e) => n + String(e.text || '').length, 0)
          ? review.draftOpinion.length / registry.list().reduce((n, e) => n + String(e.text || '').length, 0) : null
      } } : {}),
      elements: Object.fromEntries([...decomposed.byArticle].map(([id, v]) => [id, v.source])),
      warrantVerification: { entailmentCalls: fresh.entailmentCalls, unreviewedPairs: fresh.unreviewedPairs },
      prefixBudgets: budgets },
    evidence: registry.toJSON()
  };
  review.reasoning.knowledgeImpact = [...(previous?.knowledgeTargets || new Map())].flatMap(([knowledgeId, targets]) =>
    targets.map(target => {
      const result = issueResults.find(r => r.issueId === target.issueId);
      const element = result?.elements.find(e => e.id === target.elementId);
      const assessment = result?.assessments.find(a => a.elementId === target.elementId);
      return { knowledgeId, issueId: target.issueId, elementId: target.elementId,
        usedFor: element?.text || caseIssues.issues.find(i => i.id === target.issueId)?.question || '해당 쟁점의 판단',
        officiallyVerified: Boolean(assessment?.authorityEvidenceIds?.length) };
    }));
  if (review.appendix) review.appendix.knowledgeImpact = review.reasoning.knowledgeImpact;
  if (preset === 'contract_risk') review.appendix = {
    authorities: [...new Set(issueResults.flatMap(r => r.appliedAuthorities || []))],
    warrants: ledger.map(w => ({ claim: w.text, result: w.overall,
      authorityIds: (w.checks || []).filter(c => ['SUPPORTS', 'PARTIAL'].includes(c.entailment)).map(c => c.evidenceId) })),
    researchCandidates: caseIssues.issues.map(issue => ({ issue: issue.question,
      ids: (perIssue.get(issue.id)?.candidates || []).map(c => c.id) })),
    unconfirmed: ledger.filter(w => w.overall !== 'SUPPORTED').map(w => w.text),
    dispatchFactors: findings.filter(f => f.dispatchFactors?.length).flatMap(f => f.dispatchFactors),
    additionalChecks: review.furtherChecks
  };
  review.warnings = warnings;
  return review;
}
