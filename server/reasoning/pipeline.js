// server/reasoning/pipeline.js - 단계형 법률 추론 파이프라인 (S0~S7)
//
//   S0 근거 등록부 → S1 사건·쟁점 → S2 쟁점별 조사 → S3 요건 분해 → S4 요건별 포섭(쟁점마다)
//   → S6 근거 검증 → S7 공백 산출 → S5 종합·조립
//
// 호출 순서는 로컬 모델의 KV 캐시에 맞춘다. S1·S3은 공통 접두부 P0로, S4·S5·S6은 P0 뒤에 사실·쟁점
// 목록을 붙인 실행 접두부로 시작한다. 쟁점은 직렬로 돌린다(병렬로 보내면 캐시가 흩어진다).
// num_ctx는 실행 내내 같은 값을 쓴다(바꾸면 모델이 다시 적재된다).
//
// 재검토(외부 전문가 답변 반영): 이전 검토와 공식 근거가 같으면 S1·S2를 재사용하고,
// 답변이 연결된 쟁점과 그 후속 쟁점만 S4를 다시 돌린다. 근거가 바뀌었으면 처음부터 다시 한다.
import { createTokenCounter, resolveBudget } from '../law/llmBudget.js';
import { NOOP_PROGRESS, countLabel } from '../law/progressReporter.js';
import { buildEvidenceRegistry } from './evidenceRegistry.js';
import { buildCommonPrefix, PROMPT_VERSION, REASONING_SYSTEM } from './prompts.js';
import { planCaseAndIssues } from './stages/caseIssues.js';
import { planResearchQueries, reapplyResearch, runResearchQueries, selectIssueEvidence } from './stages/issueResearch.js';
import { decomposeArticles, selectIssueElements } from './stages/elements.js';
import { applyIssue, buildRunPrefix } from './stages/application.js';
import { verifyWarrants } from './verify/warrant.js';
import { deriveGaps } from './stages/gaps.js';
import { draftRedlines, renderReview, synthesize } from './stages/synthesis.js';

export class PipelineError extends Error {
  constructor(message, cause) { super(message); this.name = 'PipelineError'; this.cause = cause; }
}

/** 단계별 출력 예약. num_predict만 바뀌고 num_ctx는 같으므로 모델 재적재가 없다. */
const OUTPUT_TOKENS = { s1: 3072, s3: 2048, s4: 3072, s4Think: 8192, s5: 1536, s6: 1024 };
// S4 입력의 최대 추가분(쟁점 근거 원문 9,000자 + 사실·쟁점 목록·요건·과제). P0 예산을 이만큼 비워 둔다.
const RESERVED_SUFFIX_CHARS = 14000;

export const pipelineEnabled = (llmConfig = {}) =>
  (llmConfig.pipeline || process.env.REVIEW_PIPELINE || 'monolithic') === 'staged';

const thinkStages = () => new Set(String(process.env.REVIEW_THINK_STAGES || '').split(',').map(s => s.trim()).filter(Boolean));
const maxIssues = () => Math.min(8, Math.max(1, parseInt(process.env.REVIEW_MAX_ISSUES || '5', 10) || 5));

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

/** 이전 검토의 쟁점 기록을 S4 결과 형태로 되돌린다. */
const reusedResult = issue => ({ issueId: issue.id, elements: issue.elements, assessments: issue.assessments, precedents: issue.precedents,
  counter: issue.counter, narrative: issue.narrative, openQuestions: issue.openQuestions, conclusion: issue.conclusion,
  stageStatus: issue.stageStatus, omittedEvidence: issue.omittedEvidence || [], evidenceIds: issue.research?.evidenceIds || [],
  documentIds: issue.research?.documentIds || [],
  gateReasons: issue.gateReasons || [], warnings: issue.warnings || [], reused: true });

const PIPELINE_FIELDS = ['research', 'elements', 'assessments', 'precedents', 'counter', 'narrative', 'openQuestions', 'conclusion',
  'stageStatus', 'omittedEvidence', 'warnings', 'gateReasons'];
const bareIssue = issue => Object.fromEntries(Object.entries(issue).filter(([k]) => !PIPELINE_FIELDS.includes(k)));

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
  const s4Limit = budgetFor(thinkStages().has('s4') ? OUTPUT_TOKENS.s4Think : OUTPUT_TOKENS.s4).inputLimit;
  let budgets = { document: 14000, index: 6000 };
  let common = buildCommonPrefix({ registry: registry0, query, preset, budgets });
  for (let i = 0; i < 12 && counter.estimate(REASONING_SYSTEM, common.text + 'x'.repeat(RESERVED_SUFFIX_CHARS)).tokens > s4Limit; i++) {
    budgets = { document: Math.floor(budgets.document * 0.75), index: Math.floor(budgets.index * 0.75) };
    common = buildCommonPrefix({ registry: registry0, query, preset, budgets });
  }
  if (common.documentOmitted.length) warnings.push(`입력 한도 때문에 첨부문서 조항 ${common.documentOmitted.length}개(${common.documentOmitted.join(', ')})를 쟁점 추출에서 제외했습니다.`);
  progress.done('s0', `근거 ${countLabel(registry0.size, '개')} 등록 · 문서 조항 ${countLabel(common.documentIncluded.length, '개')}`);

  // ── 재검토: 이전 검토와 공식 근거가 같은지 ──
  let reuse = null;
  if (previous?.reasoning?.version && previous.reasoning.promptVersion === PROMPT_VERSION) {
    const addedItems = previous.reasoning.diagnostics?.research?.addedItems || {};
    const candidate = buildEvidenceRegistry(reapplyResearch(workbenchContext, addedItems), { documentText });
    if (evidenceFingerprint(candidate.list()) === evidenceFingerprint(previous.reasoning.evidence || [])) {
      reuse = { registry: candidate, addedItems };
    } else {
      warnings.push('이전 검토 이후 공식 근거가 달라져 쟁점 정리부터 다시 수행했습니다.');
    }
  }

  let caseIssues;
  let plan;
  let research;
  let registry;
  const perIssue = new Map();
  if (reuse) {
    const prior = previous.reasoning;
    caseIssues = { facts: prior.facts, issues: prior.issues.map(bareIssue), unknownFacts: prior.unknownFacts || [],
      diagnostics: { ...(prior.diagnostics?.s1 || {}), reused: true } };
    registry = reuse.registry;
    plan = { queries: prior.diagnostics?.research?.queries || [], skipped: prior.diagnostics?.research?.skippedQueries || [],
      byIssue: Object.fromEntries(prior.issues.map(i => [i.id, i.research?.queries || []])) };
    research = { added: prior.diagnostics?.research?.added || {}, addedItems: reuse.addedItems, warnings: [] };
    for (const issue of prior.issues) perIssue.set(issue.id, { ...issue.research });
    progress.mark('s1', '사건 사실·쟁점 정리', `이전 검토 재사용 — 쟁점 ${countLabel(caseIssues.issues.length, '개')}`, '분석');
    progress.mark('s2', '쟁점별 판례·해석례 조사', '이전 검토 재사용 (공식 근거 동일)', '수집');
  } else {
    // ── S1 사건·쟁점 ──
    progress.start('s1', '사건 사실·쟁점 정리', '쟁점을 먼저 확정하고 근거 후보를 ID로 지정', '분석');
    try {
      caseIssues = await planCaseAndIssues({ registry: registry0, query, prefix: common.text, provider, config: configFor('s1'), session, maxIssues: maxIssues() });
    } catch (err) {
      progress.fail('s1', `쟁점 정리 실패: ${err.message}`);
      throw new PipelineError(`쟁점 정리(S1) 실패: ${err.message}`, err);
    }
    if (!caseIssues.issues.length) {
      progress.fail('s1', '쟁점을 세우지 못했습니다');
      throw new PipelineError('쟁점을 세우지 못했습니다.');
    }
    const d1 = caseIssues.diagnostics;
    progress.done('s1', `쟁점 ${countLabel(caseIssues.issues.length, '개')} · 사실 ${countLabel(caseIssues.facts.length, '개')}`
      + `${d1.downgradedFacts.length ? ` · 원문 미확인 사실 ${d1.downgradedFacts.length}` : ''}${d1.rejectedIds.length ? ` · 없는 근거 ID 제거 ${d1.rejectedIds.length}` : ''}`);

    // ── S2 쟁점별 조사 ──
    progress.start('s2', '쟁점별 판례·해석례 조사', '', '수집');
    plan = planResearchQueries(caseIssues.issues, registry0);
    research = await runResearchQueries(workbenchContext, plan, clients ? { clients } : {});
    warnings.push(...research.warnings);
    registry = buildEvidenceRegistry(research.context, { documentText });
    for (const issue of caseIssues.issues) {
      const selected = await selectIssueEvidence({ issue, registry, facts: caseIssues.facts, plan, hits: research.hits, ...embedOption });
      if (selected.warning && !warnings.includes(selected.warning)) warnings.push(selected.warning);
      perIssue.set(issue.id, selected);
    }
    progress.done('s2', `검색어 ${countLabel(plan.queries.length, '개')} · 새 판례 ${countLabel(research.added.precedents)} · 새 해석례 ${countLabel(research.added.interpretations)}`);
  }

  // 재검토에서 다시 판단할 쟁점. 연결된 답변이 없으면(예전 카드) 모든 쟁점을 다시 판단한다.
  const allIds = caseIssues.issues.map(i => i.id);
  const anchored = (previous?.rerunIssueIds || []).filter(id => allIds.includes(id));
  const rerun = reuse ? withDependents(caseIssues.issues, anchored.length ? anchored : allIds) : new Set(allIds);
  // 외부 참고 지식(K)은 연결된 쟁점의 입력에 싣는다. 연결 정보가 없으면 다시 판단하는 모든 쟁점에 싣는다.
  const knowledgeFor = issueId => registry.list(e => e.kind === 'KNOWLEDGE').filter(k => {
    const linked = previous?.knowledgeIssues?.get(k.knowledgeId);
    return linked?.length ? linked.includes(issueId) : true;
  }).map(k => k.id);

  // ── S3 요건 분해 ──
  progress.start('s3', '조문 요건 분해', '같은 조문은 저장된 결과를 재사용', '분석');
  const articleIds = [...new Set(caseIssues.issues.filter(i => rerun.has(i.id)).flatMap(i => perIssue.get(i.id).evidenceIds)
    .map(id => registry.get(id)).filter(Boolean).map(e => e.parentId || e.id).filter(id => /^[AO]\d+$/.test(id)))];
  const decomposed = await decomposeArticles({ articleIds, registry, prefix: common.text, provider, config: configFor('s3'), session, ...(cache !== undefined ? { cache } : {}) });
  warnings.push(...decomposed.warnings);
  const sources = [...decomposed.byArticle.values()].map(v => v.source);
  progress.done('s3', `조문 ${countLabel(articleIds.length, '개')} · 재사용 ${sources.filter(s => s === 'CACHE').length} · 새로 분해 ${sources.filter(s => s === 'LLM').length}`
    + `${sources.includes('SKELETON') ? ` · 골격 대체 ${sources.filter(s => s === 'SKELETON').length}` : ''}`);

  // ── S4 요건별 포섭 ──
  const runPrefix = buildRunPrefix(common.text, caseIssues);
  const think = thinkStages().has('s4');
  const issueResults = [];
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
    const research = knowledgeIds.length ? { ...selected, evidenceIds: [...selected.evidenceIds, ...knowledgeIds] } : selected;
    const elements = selectIssueElements({ evidenceIds: selected.evidenceIds }, decomposed.byArticle, registry);
    const predecessors = issue.dependsOn.map(id => issueResults.find(r => r.issueId === id))
      .filter(Boolean).map(r => ({ issueId: r.issueId, legal: r.conclusion.legal, stageStatus: r.stageStatus }));
    const result = await applyIssue({ issue, elements, research, registry, facts: caseIssues.facts, runPrefix, predecessors,
      provider, config: configFor('s4', think), session });
    issueResults.push(result);
    if (result.stageStatus === 'FAILED') progress.fail(key, `판단 실패 — 판단 유보로 처리 (${result.error})`);
    else progress.done(key, `${result.conclusion.legal} · 요건 ${countLabel(elements.length, '개')}${knowledgeIds.length ? ` · 외부 답변 ${knowledgeIds.length}건 반영` : ''}`,
      result.stageStatus === 'SKIPPED' ? 'SKIPPED' : 'DONE');
    for (const w of result.warnings) progress.warn(key, w);
  }
  // 결과는 원래 쟁점 순서로 둔다.
  issueResults.sort((a, b) => a.issueId.localeCompare(b.issueId, 'en', { numeric: true }));

  // ── S6 근거 검증 (다시 판단한 쟁점만; 나머지는 이전 원장을 쓴다) ──
  progress.start('s6', '근거-주장 대응 검증', '존재·공식성·시점 → 의미 정렬 → 필요한 쌍만 함의 확인', '검증');
  const fresh = await verifyWarrants({ issueResults: issueResults.filter(r => !r.reused), registry, prefix: runPrefix, provider,
    config: configFor('s6'), session, ...embedOption, entailment: process.env.REVIEW_ENTAILMENT !== 'off' });
  warnings.push(...fresh.warnings);
  const ledger = [...(previous?.reasoning?.warrants || []).filter(w => reuse && !rerun.has(w.issueId)), ...fresh.ledger];
  const tally = status => ledger.filter(w => w.overall === status).length;
  progress.done('s6', `주장 ${countLabel(ledger.length, '개')} · 뒷받침 ${tally('SUPPORTED')} · 미확인 ${tally('UNCONFIRMED')} · 불일치 ${tally('NOT_SUPPORTED')}`);

  // ── S7 공백 ──
  const gaps = deriveGaps({ issues: caseIssues.issues, issueResults, warrants: ledger, unknownFacts: caseIssues.unknownFacts,
    collectionWarnings: research.warnings });
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
  const synthesis = await synthesize({ issues: caseIssues.issues, issueResults, registry, preset, runPrefix, provider, config: configFor('s5'), session });
  if (synthesis.warning) warnings.push(synthesis.warning);
  // 수정 조문은 첨부문서가 있고, 견해 비교가 산출물인 사전 컨설팅감사가 아닐 때만 만든다.
  const redline = documentText && preset !== 'pre_consulting_audit'
    ? await draftRedlines({ issues: caseIssues.issues, issueResults, synthesis, registry, runPrefix, provider, config: configFor('s5'), session })
    : { redlines: [], warnings: [] };
  warnings.push(...redline.warnings);
  const review = renderReview({ caseIssues, issueResults, synthesis, gaps, registry, preset, redlines: redline.redlines });
  progress.done('s5', synthesis.source === 'LLM' ? '요약 생성' : '요약 생성 실패 — 결론 표로 대체', synthesis.source === 'LLM' ? 'DONE' : 'FAILED');

  const gateReasons = [...new Set(issueResults.flatMap(r => (r.gateReasons || []).map(g => `${r.issueId}: ${g}`)))];
  for (const result of issueResults.filter(r => r.stageStatus === 'SKIPPED')) {
    gateReasons.push(`${result.issueId}: 적용할 공식 근거 또는 판단 요건이 없어 쟁점을 검토하지 못함`);
  }
  if (tally('NOT_SUPPORTED')) gateReasons.push(`근거가 뒷받침하지 않는 주장 ${tally('NOT_SUPPORTED')}개`);
  const complete = issueResults.every(r => r.stageStatus === 'OK') && !gateReasons.length && !inquiry.length;
  review.reviewStatus = complete ? 'COMPLETE' : 'PARTIAL';
  review.reasoning = {
    version: 1, promptVersion: PROMPT_VERSION, asOfDate: registry.asOf,
    facts: caseIssues.facts, unknownFacts: caseIssues.unknownFacts,
    issues: caseIssues.issues.map(issue => {
      const r = issueResults.find(x => x.issueId === issue.id);
      const s = perIssue.get(issue.id);
      return { ...issue, research: { queries: plan.byIssue[issue.id] || [], evidenceIds: s.evidenceIds, adverseCandidateIds: s.adverseCandidateIds,
        documentIds: s.documentIds, candidates: s.candidates }, elements: r.elements, assessments: r.assessments, precedents: r.precedents,
        counter: r.counter, narrative: r.narrative, openQuestions: r.openQuestions, conclusion: r.conclusion, stageStatus: r.stageStatus,
        omittedEvidence: r.omittedEvidence, warnings: r.warnings, gateReasons: r.gateReasons || [], ...(r.reused ? { reused: true } : {}) };
    }),
    warrants: ledger, gaps,
    gate: gateReasons.length ? 'HUMAN_REVIEW_REQUIRED' : 'OK', gateReasons,
    reuse: reuse ? { fromHistoryId: previous.historyId || null, evidenceMatched: true, rerunIssueIds: [...rerun], reusedStages: ['S1', 'S2'],
      gapTransitions: transitions } : null,
    diagnostics: { s1: caseIssues.diagnostics,
      // 조사로 덧붙인 자료 원문을 남겨 둔다. 재검토에서 등록부를 똑같이 다시 만들려면 필요하다.
      research: { queries: plan.queries, skippedQueries: plan.skipped, added: research.added, addedItems: research.addedItems || {} },
      elements: Object.fromEntries([...decomposed.byArticle].map(([id, v]) => [id, v.source])), prefixBudgets: budgets },
    evidence: registry.toJSON()
  };
  review.warnings = warnings;
  return review;
}
