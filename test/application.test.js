import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../server/env.js';
import { resolveBudget } from '../server/law/llmBudget.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { applyFactProvenance, computeIssueConclusion, narrativeConflicts } from '../server/reasoning/verify/conclusion.js';
import { applyIssue, buildRunPrefix, cleanNarrative } from '../server/reasoning/stages/application.js';

const noNetwork = globalThis.fetch;
afterEach(() => { globalThis.fetch = noNetwork; });

const el = (id, { mandatory = true, isException = false } = {}) => ({ id, text: id, mandatory, isException, sourceIds: [id.replace(/\.E\d+$/, '')] });
const as = (elementId, status, proof = 'SUFFICIENT') => ({ elementId, status, proof, factIds: [], contraryFactIds: [], evidenceIds: [] });

test('필수 요건 하나라도 불충족이면 불충족, 미확정 요건이 있으면 판단 유보, 모두 충족이면 충족', () => {
  const elements = [el('A1.E1'), el('A1.E2')];
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A1.E2', 'NOT_SATISFIED')]).legal, 'NOT_APPLICABLE');
  const open = computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A1.E2', 'UNKNOWN')]);
  assert.deepEqual([open.legal, open.decidingElementIds], ['CONDITIONAL', ['A1.E2']]);
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A1.E2', 'SATISFIED')]).legal, 'APPLIES');
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED')]).legal, 'CONDITIONAL', '판단이 빠진 요건은 UNKNOWN이다');
  assert.equal(computeIssueConclusion([], []).legal, 'CONDITIONAL');
});

test('택일 요건은 조문별로 묶어 하나만 충족되면 충족으로 본다', () => {
  const elements = [el('A1.E1'), el('A2.E1', { mandatory: false }), el('A2.E2', { mandatory: false })];
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A2.E1', 'NOT_SATISFIED'), as('A2.E2', 'SATISFIED')]).legal, 'APPLIES');
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A2.E1', 'NOT_SATISFIED'), as('A2.E2', 'NOT_SATISFIED')]).legal, 'NOT_APPLICABLE');
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A2.E1', 'NOT_SATISFIED'), as('A2.E2', 'UNKNOWN')]).legal, 'CONDITIONAL');
});

test('원칙 요건이 충족돼도 예외 적용 여부를 모르면 확정하지 않고, 예외가 충족되면 예외 적용이다', () => {
  const elements = [el('A1.E1'), el('A1.E2', { isException: true })];
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A1.E2', 'SATISFIED')]).legal, 'EXCEPTION_APPLIES');
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A1.E2', 'DISPUTED')]).legal, 'CONDITIONAL');
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A1.E2', 'NOT_SATISFIED')]).legal, 'APPLIES');
});

test('선결 쟁점이 미해결이면 후속 쟁점은 확정하지 않되, 선결이 풀렸을 때의 결론은 남긴다', () => {
  const elements = [el('A1.E1')];
  const result = computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED')], [{ issueId: 'I1', legal: 'CONDITIONAL' }]);
  assert.deepEqual([result.legal, result.ifResolved], ['CONDITIONAL', 'APPLIES']);
  assert.match(result.reasons[0], /선결 쟁점 미해결: I1/);
  assert.equal(computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED')], [{ issueId: 'I1', legal: 'APPLIES' }]).legal, 'APPLIES');
});

test('법리상 판단과 입증 상태를 분리하고, 원문 미확인 사실만으로는 입증 충분으로 보지 않는다', () => {
  const elements = [el('A1.E1'), el('A1.E2')];
  const result = computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED', 'SUFFICIENT'), as('A1.E2', 'SATISFIED', 'INSUFFICIENT')]);
  assert.deepEqual([result.legal, result.proof], ['APPLIES', 'INSUFFICIENT']);

  const facts = new Map([['F1', { id: 'F1', status: 'INFERRED', quoteVerified: false }], ['F2', { id: 'F2', status: 'CONFIRMED', quoteVerified: true }]]);
  assert.equal(applyFactProvenance({ ...as('A1.E1', 'SATISFIED'), factIds: ['F1'] }, facts).proof, 'INSUFFICIENT');
  assert.equal(applyFactProvenance({ ...as('A1.E1', 'SATISFIED'), factIds: ['F1', 'F2'] }, facts).proof, 'SUFFICIENT');
});

test('판단 유보 결론에서 단정하는 서술만 잡고, 가능성 표현은 잡지 않는다', () => {
  const conditional = { legal: 'CONDITIONAL' };
  assert.equal(narrativeConflicts('이 조항은 무효이다. 추가 확인이 필요하다.', conditional).length, 1);
  assert.equal(narrativeConflicts('이 조항은 무효일 가능성이 있다. 위법하다고 볼 여지가 있다.', conditional).length, 0);
  assert.equal(narrativeConflicts('이 조항은 무효이다.', { legal: 'APPLIES' }).length, 0);
  assert.deepEqual(cleanNarrative('근거는 [A1.2]와 [P9]이다 [F1].', new Set(['A1.2', 'F1'])), { text: '근거는 [A1.2]와 이다 [F1].', removed: ['P9'] });
});

// ── S4 호출 ──────────────────────────────────────────────
const budget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 16384, outputTokens: 2048 });
const OFFICIAL = { source: 'OFFICIAL_API' };
const law = '근로기준법';
const registry = () => buildEvidenceRegistry({
  meta: { primaryLawName: law, asOfDate: '20260923' },
  officialEvidence: { lawDetail: { ...OFFICIAL, lawName: law }, articles: [
    { ...OFFICIAL, lawName: law, fullArticleNo: '94', title: '변경 절차', enforceDate: '20200101', content: '',
      paragraphs: [{ paragraphNo: '①', content: '과반수의 의견을 들어야 한다. 다만, 불리하게 변경하는 경우에는 그 동의를 받아야 한다.' }] }],
    precedents: [{ ...OFFICIAL, id: '1', contentStatus: 'FULL_TEXT', courtName: '대법원', caseNo: '2019다1', summary: '[1] 동의 없는 불리한 변경은 효력이 없다. [2] 사회통념상 합리성이 있으면 예외' }] },
  learningKnowledge: [{ id: 'k', title: '카드', card: { issue: 'x' } }]
}, { documentText: '제41조(변경) 회사는 근로자 동의 없이 이 규칙을 변경할 수 있다.' });
const facts = [{ id: 'F1', text: '동의 없이 변경 가능 조항', status: 'CONFIRMED', docRef: 'D1', quoteVerified: true }];
const issue = { id: 'I1', question: '동의 없는 불리한 변경 조항은 효력이 있는가?', dependsOn: [], factIds: ['F1'], evidenceIds: ['A1.1'] };
const elements = [{ id: 'A1.E1', text: '불리한 변경일 것', mandatory: true, isException: false, sourceIds: ['A1.1x'] },
  { id: 'A1.E2', text: '사회통념상 합리성', mandatory: true, isException: true, sourceIds: ['A1.1x'] }];
const research = { evidenceIds: ['A1.1', 'P1'], adverseCandidateIds: ['A1.1x'], documentIds: ['D1'] };

const reply = content => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop', prompt_eval_count: 3000, eval_count: 400 })}\n`);
})() });
const fakeOllama = handler => {
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    bodies.push(JSON.parse(options.body));
    return handler(bodies.length);
  };
  return bodies;
};
const run = (overrides = {}) => applyIssue({ issue, elements, research, registry: registry(), facts,
  runPrefix: buildRunPrefix('P0', { facts, issues: [issue] }), provider: 'ollama', config: { budget, think: false }, session: createLlmSession(), ...overrides });

test('포섭 요청은 요건·근거 ID를 스키마 허용값으로 묶고, 쟁점 원문과 반대 후보를 접두부에 싣는다', async () => {
  const bodies = fakeOllama(() => reply(JSON.stringify({ reasoning: '검토', narrative: '불리한 변경이다 [A1.1x] [F1].',
    assessments: [{ elementId: 'A1.E1', status: 'SATISFIED', proof: 'SUFFICIENT', factIds: ['F1'], contraryFactIds: [], evidenceIds: ['A1.1x'], analysis: '', openQuestion: '' },
      { elementId: 'A1.E2', status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [], contraryFactIds: [], evidenceIds: ['P1.y2'], analysis: '', openQuestion: '합리성 판단 기준은 무엇인가?' }],
    precedents: [{ id: 'P1', relation: 'ANALOGOUS', stance: 'OPPOSES', decisiveFactor: '동의 부재' }],
    counter: { position: '합리성이 있으면 유효', evidenceIds: ['P1.y2'], response: '' } })));
  const result = await run();
  const [body] = bodies;
  assert.equal(body.think, false);
  assert.deepEqual(Object.keys(body.format.properties)[0], 'reasoning', 'think를 끄면 판단 과정을 먼저 쓰게 한다');
  assert.deepEqual(body.format.properties.assessments.items.properties.elementId.enum, ['A1.E1', 'A1.E2']);
  const evidenceEnum = body.format.properties.assessments.items.properties.evidenceIds.items.enum;
  assert.ok(evidenceEnum.includes('P1.y2') && evidenceEnum.includes('A1.1x'));
  assert.ok(!evidenceEnum.includes('D1') && !evidenceEnum.includes('K1'), '문서와 등록부 밖 지식은 근거 허용값이 아니다');
  assert.match(body.messages[1].content, /^P0\n\n\[정리된 사실/);
  assert.match(body.messages[1].content, /\[반대 근거 후보 — 결론을 뒤집을 수 있는 단서·예외\]: A1\.1x/);

  assert.equal(result.stageStatus, 'OK');
  assert.equal(result.conclusion.legal, 'CONDITIONAL', '예외 요건이 미확정이면 확정하지 않는다');
  assert.deepEqual(result.openQuestions, [{ elementId: 'A1.E2', question: '합리성 판단 기준은 무엇인가?' }]);
  assert.deepEqual(result.gateReasons, ['가장 강한 반대 논리에 대한 응답 없음']);
});

test('포섭이 실패하면 예외를 올리지 않고 그 쟁점만 FAILED·판단 유보로 돌려준다', async () => {
  fakeOllama(() => reply('형식이 깨진 출력'));
  const result = await run();
  assert.equal(result.stageStatus, 'FAILED');
  assert.equal(result.conclusion.legal, 'CONDITIONAL');
  assert.ok(result.assessments.every(a => a.status === 'UNKNOWN'));
});

test('요건이 없으면 모델을 부르지 않는다', async () => {
  const bodies = fakeOllama(() => reply('{}'));
  const result = await run({ elements: [] });
  assert.equal(bodies.length, 0);
  assert.equal(result.stageStatus, 'SKIPPED');
});

test('명시적 논리 그룹은 A AND B AND (C OR D)를 계산하고 미승격 골격은 차단하지 않는다', () => {
  const elements = [
    { ...el('A1.E1'), logicGroup: 'G1', operator: 'ALL_OF' },
    { ...el('A1.E2'), logicGroup: 'G1', operator: 'ALL_OF' },
    { ...el('A1.E3'), logicGroup: 'G2', operator: 'ANY_OF' },
    { ...el('A1.E4'), logicGroup: 'G2', operator: 'ANY_OF' },
    { ...el('A1.E5'), fallback: true, relevance: 'UNASSESSED', blocksConclusion: false }
  ];
  const result = computeIssueConclusion(elements, [as('A1.E1', 'SATISFIED'), as('A1.E2', 'SATISFIED'),
    as('A1.E3', 'NOT_SATISFIED'), as('A1.E4', 'SATISFIED')]);
  assert.equal(result.legal, 'APPLIES');
  assert.ok(!result.decidingElementIds.includes('A1.E5'));
});

test('한 호출에 안 들어가는 근거는 여러 묶음으로 판단하고 누락 없이 합친다', async () => {
  const largeRegistry = buildEvidenceRegistry({ meta: { primaryLawName: law, asOfDate: '20260923' },
    officialEvidence: { lawDetail: { ...OFFICIAL, lawName: law }, articles: [{ ...OFFICIAL, lawName: law,
      fullArticleNo: '94', title: '변경 절차', enforceDate: '20200101', content: '불리한 변경에는 동의가 필요하다.', paragraphs: [] }],
    precedents: ['1', '2'].map(id => ({ ...OFFICIAL, id, contentStatus: 'FULL_TEXT', courtName: '대법원',
      caseNo: `2020다${id}`, summary: `변경 절차 ${'설명 '.repeat(1300)}` })) } });
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    bodies.push(JSON.parse(options.body));
    return reply(JSON.stringify({ reasoning: '', narrative: '', assessments: [{ elementId: 'A1.E1', status: 'SATISFIED',
      proof: 'SUFFICIENT', factIds: [], contraryFactIds: [], evidenceIds: [], analysis: '', openQuestion: '' }],
    precedents: [], counter: { position: '', evidenceIds: [], response: '' } }));
  };
  const result = await run({ registry: largeRegistry, elements: [el('A1.E1')], facts: [],
    research: { evidenceIds: ['A1', 'P1', 'P2'], adverseCandidateIds: [], documentIds: [] } });
  assert.ok(bodies.length >= 2);
  assert.deepEqual(result.omittedEvidence, []);
  assert.deepEqual(result.evidenceIds, ['A1', 'P1', 'P2']);
  assert.equal(result.stageStatus, 'OK');
});

test('요건이 열 개를 넘어도 요건별 묶음 호출을 합쳐 누락 없이 판단한다', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `A1.E${i + 1}`, text: `필수 요건 ${i + 1}`,
    mandatory: true, isException: false, sourceIds: ['A1.1'] }));
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    const body = JSON.parse(options.body);
    bodies.push(body);
    const ids = body.format.properties.assessments.items.properties.elementId.enum;
    return reply(JSON.stringify({ reasoning: '', narrative: '', assessments: ids.map(elementId => ({ elementId,
      status: 'SATISFIED', proof: 'SUFFICIENT', factIds: ['F1'], contraryFactIds: [], evidenceIds: ['A1.1'], analysis: '', openQuestion: '' })),
    precedents: [], counter: { position: '', evidenceIds: [], response: '' } }));
  };
  const result = await run({ elements: many, research: { evidenceIds: ['A1.1'], adverseCandidateIds: [], documentIds: [] } });
  assert.equal(bodies.length, 3);
  assert.equal(result.assessments.length, 12);
  assert.deepEqual(result.assessments.map(a => a.elementId), many.map(e => e.id));
  assert.equal(result.stageStatus, 'OK');
});

test('하위 항이 없는 긴 근거도 원문 조각으로 나누어 포섭한다', async () => {
  const longText = '동의를 받아야 한다. '.repeat(200);
  const reg = buildEvidenceRegistry({ meta: { primaryLawName: law, asOfDate: '20260923' },
    officialEvidence: { lawDetail: { ...OFFICIAL, lawName: law }, articles: [
      { ...OFFICIAL, lawName: law, fullArticleNo: '94', title: '변경 절차', enforceDate: '20200101', content: longText, paragraphs: [] }] } });
  const bodies = fakeOllama(() => reply(JSON.stringify({ reasoning: '', narrative: '', assessments: [
    { elementId: 'A1.E1', status: 'SATISFIED', proof: 'SUFFICIENT', factIds: [], contraryFactIds: [],
      evidenceIds: ['A1'], analysis: '', openQuestion: '' }], precedents: [], counter: { position: '', evidenceIds: [], response: '' } })));
  const result = await run({ registry: reg, elements: [el('A1.E1')], facts: [],
    research: { evidenceIds: ['A1'], adverseCandidateIds: [], documentIds: [] },
    config: { budget: { ...budget, inputLimit: 2800 }, think: false } });
  assert.ok(bodies.length > 1);
  assert.deepEqual(result.omittedEvidence, []);
  assert.equal(result.stageStatus, 'OK');
  assert.ok(bodies.some(b => /원문 \d+-\d+/.test(b.messages[1].content)));
});
