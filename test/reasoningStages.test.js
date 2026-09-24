import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../server/env.js';
import { resolveBudget } from '../server/law/llmBudget.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { caseIssuesSchema, parseModelJson, validateSchema } from '../server/reasoning/schemas.js';
import { runStage, StageError } from '../server/reasoning/stageRunner.js';
import { buildCommonPrefix, REASONING_SYSTEM } from '../server/reasoning/prompts.js';
import { bigramSimilarity, normalizeCaseIssues, planCaseAndIssues } from '../server/reasoning/stages/caseIssues.js';

const noNetwork = globalThis.fetch;
afterEach(() => { globalThis.fetch = noNetwork; });

const budget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 16384, outputTokens: 2048 });
const ndjson = content => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop', prompt_eval_count: 1000, eval_count: 50 })}\n`);
})() });
/** 호출 순서대로 준비한 응답을 돌려주고 요청 본문을 모은다. */
const scriptedOllama = replies => {
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    bodies.push(JSON.parse(options.body));
    return ndjson(replies[bodies.length - 1]);
  };
  return bodies;
};

const OFFICIAL = { source: 'OFFICIAL_API' };
const law = '근로기준법';
const context = () => ({
  meta: { primaryLawName: law, asOfDate: '20260923' },
  officialEvidence: { lawDetail: { ...OFFICIAL, lawName: law }, articles: [
    { ...OFFICIAL, lawName: law, fullArticleNo: '56', title: '연장·야간 및 휴일 근로', enforceDate: '20200101', content: '',
      paragraphs: [{ paragraphNo: '①', content: '사용자는 연장근로에 대하여 통상임금의 100분의 50 이상을 가산하여 지급하여야 한다.' }] },
    { ...OFFICIAL, lawName: law, fullArticleNo: '94', title: '규칙의 작성, 변경 절차', enforceDate: '20200101', content: '',
      paragraphs: [{ paragraphNo: '①', content: '취업규칙을 변경하는 경우 과반수의 의견을 들어야 한다. 다만, 불리하게 변경하는 경우에는 그 동의를 받아야 한다.' }] }
  ] }
});
const documentText = '제18조(포괄임금) 기본급에 모든 연장근로수당이 포함된 것으로 본다.\n제41조(변경) 회사는 근로자 동의 없이 이 규칙을 변경할 수 있다.';
const registry = () => buildEvidenceRegistry(context(), { documentText });

test('스키마 검증기는 형식·필수·허용값·길이·항목 수·정의 밖 항목을 잡는다', () => {
  const schema = caseIssuesSchema({ maxIssues: 1 });
  assert.deepEqual(validateSchema(schema, { facts: [], issues: [{ id: 'I1', question: 'q', type: 'PRIMARY', priority: 'HIGH',
    dependsOn: [], factIds: [], evidenceIds: [], searchTerms: [] }], unknownFacts: [] }), []);
  const errors = validateSchema(schema, { facts: [{ id: 'F1', text: 'x'.repeat(201), status: 'MAYBE', docRef: '', quote: '' }],
    issues: [], unknownFacts: 'none', extra: 1 });
  assert.ok(errors.some(e => /facts\[0\]\.text: 200자 초과/.test(e)));
  assert.ok(errors.some(e => /facts\[0\]\.status: 허용값/.test(e)));
  assert.ok(errors.some(e => /issues: 항목이 1개 이상/.test(e)));
  assert.ok(errors.some(e => /unknownFacts: array 형식/.test(e)));
  assert.ok(errors.some(e => /\$\.extra: 정의되지 않은 항목/.test(e)));
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseModelJson('not json'), null);
});

test('단계 실행은 형식 오류를 알려 한 번만 다시 묻고, 공통 접두부는 바꾸지 않는다', async () => {
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
  const bodies = scriptedOllama(['{"n":"x"}', '{"n":3}']);
  const session = createLlmSession();
  const result = await runStage({ stage: 't', provider: 'ollama', system: 'S', prefix: 'PREFIX', task: 'TASK', schema,
    config: { budget, think: false }, session });
  assert.deepEqual(result, { value: { n: 3 }, attempts: 2 });
  assert.ok(bodies[1].messages[1].content.startsWith('PREFIX\n\nTASK'), '재시도도 같은 접두부로 시작해야 캐시가 유지된다');
  assert.match(bodies[1].messages[1].content, /\$\.n: integer 형식이어야 합니다/);
  assert.deepEqual(bodies[0].format, schema);
  assert.deepEqual(session.ledger.calls.map(c => c.stage), ['t', 't:retry']);

  scriptedOllama(['nope', '{"n":"still"}']);
  await assert.rejects(runStage({ stage: 't', provider: 'ollama', system: 'S', prefix: 'P', task: 'T', schema,
    config: { budget }, session: createLlmSession() }), err => err instanceof StageError && err.attempts === 2);
});

test('단계 실행은 입력 한도를 넘기기 전에 중단하고 분할 가능한 오류를 돌려준다', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('호출되면 안 됨'); };
  const small = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 1024, outputTokens: 256 });
  await assert.rejects(runStage({ stage: 'large', provider: 'ollama', system: 'S', prefix: '법'.repeat(1200), task: 'T',
    schema: { type: 'object' }, config: { budget: small, model: ENV.OLLAMA_MODEL }, session: createLlmSession() }),
  err => err instanceof StageError && err.budgetExceeded && err.code === 'INPUT_BUDGET_EXCEEDED');
  assert.equal(called, false);
});

test('긴 첨부문서의 쟁점 추출은 문서 조각별 호출로 이어가고 결과를 병합한다', async () => {
  const largeDocument = Array.from({ length: 9 }, (_, i) => `제${i + 1}조(절차) ${'동의 절차를 확인한다. '.repeat(55)}`).join('\n');
  const largeRegistry = buildEvidenceRegistry(context(), { documentText: largeDocument });
  const largePrefix = buildCommonPrefix({ registry: largeRegistry, query: '취업규칙 검토', preset: 'labor_hr',
    budgets: { document: 14000, index: 2000 } }).text;
  const smallBudget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 12288, outputTokens: 2048 });
  const response = JSON.stringify({ facts: [], issues: [{ id: 'I1', question: '취업규칙 변경에 동의가 필요한가?',
    type: 'PRIMARY', priority: 'HIGH', dependsOn: [], factIds: [], evidenceIds: ['A2'], searchTerms: ['취업규칙'] }], unknownFacts: [] });
  const bodies = scriptedOllama(Array(24).fill(response));
  const result = await planCaseAndIssues({ registry: largeRegistry, query: '취업규칙 검토', preset: 'labor_hr',
    prefix: largePrefix, provider: 'ollama', config: { budget: smallBudget, model: ENV.OLLAMA_MODEL },
    session: createLlmSession() });
  assert.ok(bodies.length > 1);
  assert.ok(result.diagnostics.splitCalls > 1);
  assert.deepEqual(result.diagnostics.skippedDocumentIds, []);
  assert.equal(result.issues.length, 1);
});

test('긴 질의는 뒷부분을 버리지 않고 구간별로 쟁점을 추출한다', async () => {
  const reg = registry();
  const query = '가'.repeat(2200) + 'SECOND_MARKER' + '나'.repeat(2200) + 'THIRD_MARKER' + '다'.repeat(2200);
  const prefix = buildCommonPrefix({ registry: reg, query, preset: 'labor_hr', budgets: { document: 1000, index: 1000 } }).text;
  const smallBudget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 12288, outputTokens: 2048 });
  const response = JSON.stringify({ facts: [], issues: [{ id: 'I1', question: '질의의 법적 요건은 무엇인가?', type: 'PRIMARY',
    priority: 'HIGH', dependsOn: [], factIds: [], evidenceIds: ['A1'], searchTerms: [] }], unknownFacts: [] });
  const bodies = scriptedOllama(Array(20).fill(response));
  const result = await planCaseAndIssues({ registry: reg, query, preset: 'labor_hr', prefix, provider: 'ollama',
    config: { budget: smallBudget, model: ENV.OLLAMA_MODEL }, session: createLlmSession() });
  const prompts = bodies.map(b => b.messages[1].content);
  assert.ok(prompts.some(p => p.includes('SECOND_MARKER')));
  assert.ok(prompts.some(p => p.includes('THIRD_MARKER')));
  assert.deepEqual(result.diagnostics.skippedQueryRanges, []);
  assert.equal(result.diagnostics.queryTruncated, false);
});

test('공통 접두부는 문서 조항과 근거 색인을 ID로 싣고 같은 입력에서 바이트 단위로 같다', () => {
  const build = () => buildCommonPrefix({ registry: registry(), query: '취업규칙 검토', preset: 'labor_hr', budgets: { document: 4000, index: 3000 } });
  const prefix = build();
  assert.equal(prefix.text, build().text);
  assert.match(prefix.text, /\[D1\] 첨부문서 제18조\(포괄임금\)/);
  assert.match(prefix.text, /\[A2\] 근로기준법 제94조\(규칙의 작성, 변경 절차\) — .*\{A2\.1, A2\.1x\}/);
  assert.match(prefix.text, /\[쟁점 설정 방향\] 조항별로 근로기준법/);
  const tight = buildCommonPrefix({ registry: registry(), query: 'q', preset: 'labor_hr', budgets: { document: 60, index: 3000 } });
  assert.match(tight.text, /분량 제한으로 \d개 조항 제외/);
});

test('사실의 인용문을 원문과 대조해 확인되지 않은 사실을 강등하고, 조항 ID가 틀려도 실제 위치로 바로잡는다', () => {
  const result = normalizeCaseIssues({
    facts: [
      { id: 'F1', text: '포괄임금 조항이 있다', status: 'CONFIRMED', docRef: 'D1', quote: '기본급에 모든 연장근로수당이 포함된 것으로 본다' },
      { id: 'F2', text: '동의 없이 변경 가능', status: 'CONFIRMED', docRef: 'D1', quote: '근로자 동의 없이 이 규칙을 변경할 수 있다' },
      { id: 'F3', text: '근로자 과반수가 반대했다', status: 'CONFIRMED', docRef: 'D2', quote: '과반수가 반대하였다' },
      { id: 'F4', text: '실제 연장근로 시간', status: 'UNKNOWN', docRef: '', quote: '' },
      { id: 'F5', text: '질의자의 설명', status: 'ALLEGED', docRef: 'QUERY', quote: '스타트업 취업규칙' }
    ], issues: [{ id: 'I1', question: '포괄임금 조항은 유효한가?', type: 'PRIMARY', priority: 'HIGH', dependsOn: [], factIds: ['F1'], evidenceIds: ['A1.1'], searchTerms: ['포괄임금'] }],
    unknownFacts: ['실제 근로시간']
  }, { registry: registry(), query: 'IT 스타트업 취업규칙 검토' });
  const byId = Object.fromEntries(result.facts.map(f => [f.id, f]));
  assert.deepEqual([byId.F1.status, byId.F1.docRef, byId.F1.quoteVerified], ['CONFIRMED', 'D1', true]);
  assert.deepEqual([byId.F2.status, byId.F2.docRef], ['CONFIRMED', 'D2'], '인용문이 다른 조항에 있으면 그 조항으로 바로잡는다');
  assert.deepEqual([byId.F3.status, byId.F3.quote, byId.F3.quoteVerified], ['INFERRED', '', false], '원문에 없는 인용은 추론으로 강등');
  assert.equal(byId.F4.status, 'UNKNOWN');
  assert.deepEqual([byId.F5.status, byId.F5.docRef], ['ALLEGED', 'QUERY']);
  assert.deepEqual(result.diagnostics.downgradedFacts, [{ id: 'F3', from: 'CONFIRMED' }]);
});

test('등록부에 없는 근거 ID와 첨부문서 ID는 쟁점 근거에서 빠지고, 없는 ID는 기록된다', () => {
  const result = normalizeCaseIssues({ facts: [], unknownFacts: [], issues: [
    { id: 'I1', question: '불이익 변경에 동의가 필요한가?', type: 'PRIMARY', priority: 'HIGH', dependsOn: [], factIds: ['F9'],
      evidenceIds: ['A2.1x', 'A9.9', 'D2', '근로기준법 제94조'], searchTerms: ['불이익 변경', 'x'],
      positions: [{ label: '갑설', claim: '동의 필요', evidenceIds: ['A2.1x', 'P7'] }] }
  ] }, { registry: registry(), query: '' });
  const [issue] = result.issues;
  assert.deepEqual(issue.evidenceIds, ['A2.1x']);
  assert.deepEqual(issue.factIds, [], '없는 사실 ID는 버린다');
  assert.deepEqual(issue.searchTerms, ['불이익 변경']);
  assert.deepEqual(issue.positions[0].evidenceIds, ['A2.1x']);
  assert.deepEqual(result.diagnostics.rejectedIds, [{ owner: 'I1', id: 'A9.9' }, { owner: 'I1', id: '근로기준법 제94조' }, { owner: 'I1:갑설', id: 'P7' }]);
});

test('중복 쟁점은 병합하고, 상한을 넘으면 우선순위가 낮은 쟁점을 빼며, ID를 다시 매기고 선결 순환을 끊는다', () => {
  const issue = (id, question, priority, dependsOn = []) => ({ id, question, type: 'PRIMARY', priority, dependsOn, factIds: [], evidenceIds: [], searchTerms: [] });
  const result = normalizeCaseIssues({ facts: [], unknownFacts: [], issues: [
    issue('a', '포괄임금 약정은 유효한가?', 'MEDIUM', ['c']),
    issue('b', '포괄임금 약정은 유효한가요?', 'CRITICAL'),
    issue('c', '취업규칙 불이익 변경 절차를 지켰는가?', 'HIGH', ['a']),
    issue('d', '위약벌 조항은 근로기준법 제20조에 반하는가?', 'LOW', ['a']),
    issue('e', '징계해고 절차는 적법한가?', 'HIGH')
  ] }, { registry: registry(), query: '', maxIssues: 3 });
  assert.deepEqual(result.issues.map(i => [i.id, i.question, i.priority]), [
    ['I1', '포괄임금 약정은 유효한가?', 'CRITICAL'],
    ['I2', '취업규칙 불이익 변경 절차를 지켰는가?', 'HIGH'],
    ['I3', '징계해고 절차는 적법한가?', 'HIGH']
  ]);
  assert.deepEqual(result.diagnostics.mergedIssues, [{ kept: 'a', merged: 'b' }]);
  assert.deepEqual(result.diagnostics.droppedIssues, ['위약벌 조항은 근로기준법 제20조에 반하는가?']);
  // I1 → I2, I2 → I1 순환 중 뒤에 들어온 간선을 끊는다.
  assert.deepEqual(result.issues.map(i => i.dependsOn), [['I2'], [], []]);
  assert.deepEqual(result.diagnostics.removedDependencies, ['I2→I1']);
  assert.ok(bigramSimilarity('포괄임금 약정은 유효한가?', '징계해고 절차는 적법한가?') < 0.3);
  // 같은 틀로 쓴 서로 다른 쟁점은 합치지 않는다(합치면 쟁점 하나가 사라진다).
  assert.ok(bigramSimilarity('포괄임금 조항은 근로기준법 제56조에 반하는가?', '연장근로 조항은 근로기준법 제53조에 반하는가?') < 0.8);
});

test('S1은 think를 끄고 스키마를 걸어 한 번 호출하며, 정리된 결과와 진단을 돌려준다', async () => {
  const bodies = scriptedOllama([JSON.stringify({
    facts: [{ id: 'F1', text: '포괄임금 조항', status: 'CONFIRMED', docRef: 'D1', quote: '기본급에 모든 연장근로수당이 포함된 것으로 본다' }],
    issues: [{ id: 'I1', question: '포괄임금 조항은 근로기준법 제56조에 반하는가?', type: 'PRIMARY', priority: 'HIGH', dependsOn: [], factIds: ['F1'], evidenceIds: ['A1.1'], searchTerms: ['포괄임금'] }],
    unknownFacts: []
  })]);
  const reg = registry();
  const prefix = buildCommonPrefix({ registry: reg, query: '취업규칙 검토', preset: 'labor_hr', budgets: { document: 4000, index: 3000 } }).text;
  const session = createLlmSession();
  const result = await planCaseAndIssues({ registry: reg, query: '취업규칙 검토', prefix, provider: 'ollama', config: { budget }, session });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].think, false);
  assert.equal(bodies[0].messages[0].content, REASONING_SYSTEM);
  assert.ok(bodies[0].messages[1].content.startsWith(prefix));
  assert.equal(bodies[0].format.properties.issues.maxItems, 7);
  assert.deepEqual(result.issues[0].evidenceIds, ['A1.1']);
  assert.equal(result.diagnostics.attempts, 1);
  assert.deepEqual(session.ledger.calls.map(c => [c.stage, c.ok, c.think, c.schema]), [['s1', true, false, true]]);
});
