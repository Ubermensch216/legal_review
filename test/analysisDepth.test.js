import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { ENV } from '../server/env.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { createStageCache } from '../server/reasoning/stageCache.js';
import { runReasoningPipeline } from '../server/reasoning/pipeline.js';
import { depthProfile } from '../server/reasoning/analysisDepth.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { linkDocumentClauses } from '../server/reasoning/stages/statuteLinking.js';
import { compactApplicationSchema, selectJudgedElements } from '../server/reasoning/stages/application.js';
import { verifyWarrants } from '../server/reasoning/verify/warrant.js';
import { attachVerifiedRules } from '../server/reasoning/verifiedRules.js';
import { recallReview } from '../server/reasoning/reviewSessionStore.js';
import { computeIssueConclusion, resolveDocumentVerdict } from '../server/reasoning/verify/conclusion.js';
import { resolveBudget } from '../server/law/llmBudget.js';
import { screenEvidenceCandidates } from '../server/law/evidenceScreen.js';
import router from '../server/law/lawApi.js';

const noNetwork = globalThis.fetch;
afterEach(() => { globalThis.fetch = noNetwork; });

const OFFICIAL = { source: 'OFFICIAL_API' };
const law = '근로기준법';
const workbenchContext = () => ({
  meta: { primaryLawName: law, asOfDate: '20260923', preset: 'labor_hr', dataIntegrity: { hasOfficialArticles: true, warnings: [] } },
  officialEvidence: { lawDetail: { ...OFFICIAL, lawName: law }, articles: [
    { ...OFFICIAL, lawName: law, fullArticleNo: '94', title: '규칙의 작성, 변경 절차', enforceDate: '20200101', content: '',
      paragraphs: [{ paragraphNo: '①', content: '취업규칙을 변경하는 경우 과반수의 의견을 들어야 한다. 다만, 불리하게 변경하는 경우에는 그 동의를 받아야 한다.' }] }],
    precedents: [], interpretations: [] }
});
const documentText = '제41조(규칙 변경) 회사는 근로자 동의 없이 이 규칙을 변경할 수 있다.';

const assessment = (elementId, full) => {
  const satisfied = elementId === 'A1.E1';
  const base = { elementId, verdict: satisfied ? 'COMPLIES' : 'UNCLEAR', quote: satisfied ? '이 규칙을 변경할 수 있다' : '',
    evidenceIds: [satisfied ? 'A1.1' : 'A1.1x'], analysis: satisfied ? '변경 조항이 있다' : '불리한지 알 수 없다' };
  return full ? { ...base, factIds: satisfied ? ['F1'] : [], contraryFactIds: [], openQuestion: '' } : base;
};
const replies = {
  '[과제: 사건 사실과 법률 쟁점 정리]': () => ({
    facts: [{ id: 'F1', text: '동의 없이 변경할 수 있다는 조항', status: 'CONFIRMED', docRef: 'D1', quote: '근로자 동의 없이 이 규칙을 변경할 수 있다' }],
    issues: [{ id: 'I1', question: '불리한 변경에 근로자 동의가 필요한가?', type: 'PRIMARY', priority: 'CRITICAL', dependsOn: [], factIds: ['F1'], evidenceIds: ['A1.1', 'A1.1x'], searchTerms: ['불이익 변경'] }],
    unknownFacts: [] }),
  '[과제: 조문 요건 분해]': () => ({ articles: [{ articleId: 'A1', burden: '', elements: [
    { text: '취업규칙을 변경할 것', mandatory: true, isException: false, sourceIds: ['A1.1'] },
    { text: '근로자에게 불리한 변경일 것', mandatory: true, isException: false, sourceIds: ['A1.1x'] }] }] }),
  '[과제: 요건별 판단]': prompt => ({ assessments: ['A1.E1', 'A1.E2'].filter(id => prompt.includes(`[${id}]`)).map(id => assessment(id, false)) }),
  '[과제: 요건별 포섭]': prompt => ({ reasoning: '검토', narrative: '불리한 변경이면 동의가 필요하다 [A1.1x].',
    assessments: ['A1.E1', 'A1.E2'].filter(id => prompt.includes(`[${id}]`)).map(id => assessment(id, true)),
    precedents: [], counter: { position: '합리성이 있으면 유효하다', evidenceIds: [], response: '동의가 원칙이다' } }),
  '[과제: 근거-주장 대응 확인]': () => ({ label: 'SUPPORTS' }),
  '[과제: 수정 조문 작성]': () => ({ revisedText: '불리한 변경에는 근로자 과반수의 동의를 받는다.', reason: '동의 요건 [A1.1x]', evidenceIds: ['A1.1x'] }),
  '[과제: 종합]': () => ({ summary: '불리한 변경 여부가 확인되지 않았다.', risks: [{ issueId: 'I1', level: 'HIGH', title: '동의 없는 변경', description: '위험' }], recommendations: [] })
};
const reply = content => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop', prompt_eval_count: 2000, eval_count: 100 })}\n`);
})() });
const fakeOllama = () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    const marker = Object.keys(replies).find(m => prompt.includes(m));
    calls.push({ marker, prompt, body });
    return reply(JSON.stringify(replies[marker](prompt)));
  };
  return calls;
};
const clients = { searchPrecedents: async () => [], searchInterpretations: async () => [] };
const embed = async texts => ({ vectors: texts.map(() => [1, 0]), warning: null });
const cache = () => createStageCache(path.join(ENV.CACHE_DIR, `depth-${Date.now()}-${Math.random()}.db`));
const run = (extra = {}) => runReasoningPipeline({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText, workbenchContext: workbenchContext(),
  provider: 'ollama', model: ENV.OLLAMA_MODEL, session: createLlmSession(), clients, embed, cache: cache(), ...extra });

test('분석 수준을 지정하지 않거나 알 수 없는 값이면 검증을 줄이지 않고 심화분석으로 본다', () => {
  assert.equal(depthProfile().depth, 'DEEP');
  assert.equal(depthProfile('이상한 값').depth, 'DEEP');
  assert.equal(depthProfile('basic').depth, 'BASIC');
});

test('기본분석은 짧은 판단만 받고, 판단을 내린 요건만 대조하며, 수정 조문을 만들지 않고, 완료로 표시하지 않는다', async () => {
  const calls = fakeOllama();
  const review = await run({ analysisDepth: 'BASIC' });
  const count = marker => calls.filter(c => c.marker === marker).length;
  assert.equal(count('[과제: 요건별 판단]'), 1, '요건을 한 호출에 묶는다');
  assert.equal(count('[과제: 요건별 포섭]'), 0);
  assert.equal(count('[과제: 수정 조문 작성]'), 0);
  assert.equal(count('[과제: 근거-주장 대응 확인]'), 1, 'UNKNOWN 요건은 주장한 것이 없으므로 대조하지 않는다');
  assert.equal(review.analysisDepth, 'BASIC');
  assert.equal(review.reviewStatus, 'PARTIAL', '기본분석은 완료로 표시하지 않는다');
  assert.ok(review.reasoning.gateReasons.some(r => r.startsWith('기본분석:')));
  assert.match(review.draftOpinion, /^# 법률 검토의견서 \(기본분석\)/);
  assert.match(review.draftOpinion, /\[분석 수준\].*심화분석을 실행/);
  assert.deepEqual(review.reasoning.warrants.map(w => w.overall).sort(), ['NOT_CHECKED', 'SUPPORTED']);
  assert.equal(review.analysisCoverage.checkedPairs, 1);
  const [issue] = review.reasoning.issues;
  assert.equal(issue.conclusion.legal, 'CONDITIONAL');
  assert.deepEqual(issue.conclusion.scenarios.pendingElementIds, ['A1.E2'], '결론 계산 규칙은 심화분석과 같다');
  assert.ok(recallReview(review.analysisSession.reviewId), '심화분석으로 이어갈 수 있게 보관한다');
});

test('심화분석은 종전처럼 모든 주장을 대조하고 수정 조문을 만든다', async () => {
  const calls = fakeOllama();
  const review = await run({ analysisDepth: 'DEEP' });
  assert.ok(calls.some(c => c.marker === '[과제: 요건별 포섭]'));
  assert.ok(calls.some(c => c.marker === '[과제: 수정 조문 작성]'));
  assert.equal(calls.filter(c => c.marker === '[과제: 근거-주장 대응 확인]').length, 2);
  assert.equal(review.analysisDepth, 'DEEP');
  assert.equal(review.analysisSession, undefined);
  assert.doesNotMatch(review.draftOpinion, /기본분석/);
});

test('기본분석에 이어 심화분석을 실행하면 사실·쟁점 정리를 다시 하지 않고 판단과 검증만 전체로 한다', async () => {
  fakeOllama();
  const basic = await run({ analysisDepth: 'BASIC' });
  const ctx = recallReview(basic.analysisSession.reviewId);
  const calls = fakeOllama();
  const deep = await runReasoningPipeline({ query: ctx.query, preset: ctx.preset, documentText: ctx.documentText, workbenchContext: ctx.workbenchContext,
    provider: 'ollama', model: ENV.OLLAMA_MODEL, session: createLlmSession(), clients, embed, cache: cache(), analysisDepth: 'DEEP', resume: ctx });
  assert.equal(calls.filter(c => c.marker === '[과제: 사건 사실과 법률 쟁점 정리]').length, 0);
  assert.ok(calls.some(c => c.marker === '[과제: 요건별 포섭]'));
  assert.equal(deep.analysisDepth, 'DEEP');
  assert.deepEqual(deep.reasoning.issues.map(i => i.question), basic.reasoning.issues.map(i => i.question));
  assert.equal(deep.reasoning.warrants.filter(w => w.overall === 'NOT_CHECKED').length, 0);
});

test('결론에 영향이 없는 미검증 골격 요건은 기본분석에서 판단하지 않는다', () => {
  const real = { id: 'A.E1' }; const skeleton = { id: 'A.E2', fallback: true }; const blocking = { id: 'A.E3', fallback: true, blocksConclusion: true };
  assert.deepEqual(selectJudgedElements([real, skeleton, blocking]), [real, blocking]);
  assert.deepEqual(selectJudgedElements([skeleton, { ...skeleton, id: 'A.E4' }], 1).map(e => e.id), ['A.E2'], '전부 골격이면 일부라도 판단한다');
  const schema = compactApplicationSchema({ elementIds: ['A.E1'], evidenceIds: ['A1'], factIds: ['F1'] });
  assert.deepEqual(schema.required, ['assessments']);
  assert.equal(schema.properties.narrative, undefined);
});

test('쟁점에 첨부문서의 해당 조항을 연결하되, 법령 조문 번호는 문서 조항으로 오인하지 않는다', () => {
  const text = ['문서 서두 설명입니다. 이 문서는 개정안입니다.', '제18조(포괄임금제) 회사는 연장근로수당을 기본급에 포함하여 지급한다.',
    '제56조(휴가) 회사는 휴가를 부여하며 사용 절차는 별도로 정한다.', '제31조(징계해고) 회사는 청문 없이 구두로 해고를 통보할 수 있다.'].join('\n');
  const registry = buildEvidenceRegistry({ meta: { asOfDate: '20260923' }, officialEvidence: {} }, { documentText: text });
  const id = no => registry.list(e => e.kind === 'DOCUMENT').find(e => e.label.includes(no))?.id;
  const issues = [{ id: 'I1', question: '제18조 포괄임금제는 근로기준법 제56조를 위반하는가?', searchTerms: [] },
    { id: 'I2', question: '구두 해고 통보와 청문 생략이 적법한가?', searchTerms: ['징계해고'] }];
  const result = linkDocumentClauses({ issues, registry });
  assert.ok(issues[0].documentIds.includes(id('제18조')));
  assert.ok(!issues[0].documentIds.includes(id('제56조')), '근로기준법 제56조는 문서의 제56조가 아니다');
  assert.ok(issues[1].documentIds.includes(id('제31조')), '조 번호가 없어도 쟁점어로 연결한다');
  assert.equal(result.linkedIssues, 2);
});

test('제한 검증은 가까운 근거부터 대조하고 뒷받침되면 멈추며, 대조하지 않은 근거는 미확인과 구별한다', async () => {
  const entry = (id, text) => [id, { id, kind: 'ARTICLE', text, official: true, inForce: true, lawName: law, articleNo: id }];
  const entries = new Map([entry('A1', '먼 근거'), entry('A2', '가까운 근거'), entry('A3', '중간 근거'), entry('A4', '미확정 요건의 근거')]);
  const registry = { asOf: '20260923', get: id => entries.get(id) || null };
  const result = { issueId: 'I1', conclusion: { decidingElementIds: ['E2'] },
    elements: [{ id: 'E1', text: '허가를 받을 것' }, { id: 'E2', text: '신고할 것' }],
    assessments: [{ elementId: 'E1', analysis: '허가', status: 'SATISFIED', evidenceIds: ['A1', 'A2', 'A3'], factIds: [] },
      { elementId: 'E2', analysis: '모름', status: 'UNKNOWN', evidenceIds: ['A4'], factIds: [] }] };
  const score = { '먼 근거': 0.1, '가까운 근거': 0.9, '중간 근거': 0.5 };
  const scored = async texts => ({ warning: null, vectors: texts.map((t, i) => (i === 0 ? [1, 0] : [score[t] ?? 0.2, 0.4])) });
  const prompts = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    prompts.push(JSON.parse(options.body).messages[1].content);
    return reply(JSON.stringify({ label: 'SUPPORTS' }));
  };
  const budget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 16384, outputTokens: 1024 });
  const out = await verifyWarrants({ issueResults: [result], registry, embed: scored, provider: 'ollama', config: { model: ENV.OLLAMA_MODEL, budget },
    session: createLlmSession(), policy: depthProfile('BASIC').verification });
  assert.equal(prompts.length, 1, '가장 가까운 근거가 뒷받침하면 나머지는 대조하지 않는다');
  assert.match(prompts[0], /가까운 근거/);
  assert.deepEqual(out.ledger.map(w => w.overall), ['SUPPORTED', 'NOT_CHECKED']);
  assert.deepEqual(out.unreviewedPairs, [], '일부러 생략한 쌍은 실패로 세지 않는다');
  assert.deepEqual([out.coverage.pairs, out.coverage.checkedPairs], [4, 1]);

  attachVerifiedRules([result], out.ledger, registry, []);
  const [first, second] = result.rulePropositions;
  assert.equal(first.verificationStatus, 'VERIFIED');
  assert.equal(second.verificationStatus, 'SOURCE_ONLY');
  assert.equal(second.verified, false, '출처만 확인한 근거를 검증됨으로 올리지 않는다');
  assert.ok(!result.appliedAuthorities.includes('A4'));
});

test('기본분석의 목록 선별은 경계 후보를 모델에 묻지 않고 본문 확인 대상으로 남긴다', async () => {
  const listed = [{ id: '1', source: 'OFFICIAL_API', contentStatus: 'LIST_ONLY', caseNo: '2024두1', caseName: '경계 후보' }];
  const embedBoundary = async texts => ({ warning: null, vectors: texts.map((_, i) => (i === 0 ? [1, 0] : [0.48, Math.sqrt(1 - 0.48 ** 2)])) });
  let modelCalled = false;
  globalThis.fetch = async () => { modelCalled = true; throw new Error('호출되면 안 된다'); };
  const screened = await screenEvidenceCandidates({ candidates: listed, kind: 'precedent', query: '허가', issue: '허가 취소가 적법한가',
    provider: 'ollama', model: ENV.OLLAMA_MODEL, embed: embedBoundary, boundary: 'KEEP' });
  assert.equal(modelCalled, false);
  assert.deepEqual(screened.selected.map(x => x.id), ['1']);
});

test('문서 판단은 문서 원문을 글자 그대로 인용해야 인정하고, 법 조문을 되풀이한 답은 사실 확인 필요로 낮춘다', () => {
  const doc = ['제31조 해고는 서면 통지를 갈음하여 구두 또는 사내 메신저 통보로 할 수 있다.'];
  const violates = resolveDocumentVerdict({ elementId: 'E', verdict: 'VIOLATES', quote: '구두 또는 사내 메신저 통보로 할 수 있다', evidenceIds: [], analysis: '' }, doc);
  assert.deepEqual([violates.status, violates.proof, violates.quoteVerified], ['NOT_SATISFIED', 'SUFFICIENT', true]);
  const restated = resolveDocumentVerdict({ elementId: 'E', verdict: 'COMPLIES', quote: '해고사유와 해고시기를 서면으로 통지하여야 한다', evidenceIds: [], analysis: '' }, doc);
  assert.deepEqual([restated.verdict, restated.status, restated.quote, restated.verdictDowngraded], ['UNCLEAR', 'UNKNOWN', '', 'COMPLIES']);
  const spaced = resolveDocumentVerdict({ elementId: 'E', verdict: 'VIOLATES', quote: '구두  또는 사내메신저 통보로', evidenceIds: [], analysis: '' }, doc);
  assert.equal(spaced.quoteVerified, true, '띄어쓰기 차이는 같은 문장으로 본다');
  assert.equal(resolveDocumentVerdict({ elementId: 'E', status: 'SATISFIED' }, doc).status, 'SATISFIED', '문서 판단이 아니면 그대로 둔다');
});

test('문서 검토 결론: 어긋남이 하나면 위반 소지, 모두 지켜야 미발견, 다루지 않은 요건이 있으면 추가 확인', () => {
  const elements = [{ id: 'E1', mandatory: true }, { id: 'E2', mandatory: true, isException: true }, { id: 'E3', fallback: true }];
  const judged = (a, b) => [{ elementId: 'E1', verdict: a, status: 'x', proof: 'SUFFICIENT' }, { elementId: 'E2', verdict: b, status: 'x', proof: 'SUFFICIENT' }];
  const violated = computeIssueConclusion(elements, judged('COMPLIES', 'VIOLATES'));
  assert.deepEqual([violated.legal, violated.compliance, violated.decidingElementIds], ['NOT_APPLICABLE', 'VIOLATION_RISK', ['E2']], '단서의 의무를 어겨도 위반 소지다');
  const clean = computeIssueConclusion(elements, judged('COMPLIES', 'COMPLIES'));
  assert.deepEqual([clean.legal, clean.compliance], ['APPLIES', 'NO_VIOLATION_FOUND'], '골격 요건은 결론에 영향을 주지 않는다');
  const open = computeIssueConclusion(elements, judged('COMPLIES', 'NOT_ADDRESSED'));
  assert.deepEqual([open.legal, open.compliance, open.scenarios.pendingElementIds], ['CONDITIONAL', 'NEEDS_FACTS', ['E2']]);
  const pre = [{ issueId: 'I1', legal: 'CONDITIONAL' }];
  const kept = computeIssueConclusion(elements, judged('VIOLATES', 'COMPLIES'), pre);
  assert.deepEqual([kept.legal, kept.compliance], ['NOT_APPLICABLE', 'VIOLATION_RISK'], '원문 인용으로 확인된 위반 소지는 선결 쟁점이 풀리지 않아도 유지한다');
  assert.match(kept.reasons.join(' '), /선결 쟁점 미해결: I1/);
  const blocked = computeIssueConclusion(elements, judged('COMPLIES', 'COMPLIES'), pre);
  assert.deepEqual([blocked.legal, blocked.compliance, blocked.ifResolved], ['CONDITIONAL', 'NEEDS_FACTS', 'APPLIES'], '위반 없음은 선결 쟁점이 풀려야 확정한다');
});

test('만료된 기본분석에 이어가기를 요청하면 재실행을 안내한다', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/law', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const payload = JSON.stringify({ deepenReviewId: '없는-세션', llmProvider: 'ollama' });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/law/workbench', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, r => {
        let data = ''; r.on('data', c => { data += c; }); r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(res.status, 410);
    assert.equal(res.body.code, 'SESSION_EXPIRED');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
