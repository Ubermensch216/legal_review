import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENV } from '../server/env.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { createStageCache } from '../server/reasoning/stageCache.js';
import { orderByDependency, runReasoningPipeline } from '../server/reasoning/pipeline.js';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';

const noNetwork = globalThis.fetch;
const savedPipeline = process.env.REVIEW_PIPELINE;
afterEach(() => { globalThis.fetch = noNetwork; if (savedPipeline === undefined) delete process.env.REVIEW_PIPELINE; else process.env.REVIEW_PIPELINE = savedPipeline; });

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

/** 과제 머리말로 단계를 알아보고 그 단계의 모범 응답을 돌려준다. */
const STAGE_REPLIES = {
  '[과제: 사건 사실과 법률 쟁점 정리]': () => ({
    facts: [{ id: 'F1', text: '동의 없이 변경할 수 있다는 조항', status: 'CONFIRMED', docRef: 'D1', quote: '근로자 동의 없이 이 규칙을 변경할 수 있다' }],
    issues: [
      { id: 'I1', question: '불리한 변경에 근로자 동의가 필요한가?', type: 'THRESHOLD', priority: 'CRITICAL', dependsOn: [], factIds: ['F1'], evidenceIds: ['A1.1', 'A1.1x'], searchTerms: ['불이익 변경'] },
      { id: 'I2', question: '제41조는 효력이 있는가?', type: 'DEPENDENT', priority: 'HIGH', dependsOn: ['I1'], factIds: ['F1'], evidenceIds: ['A1.1x', 'ZZ9'], searchTerms: [] }
    ], unknownFacts: ['변경 내용이 실제로 불리한지']
  }),
  '[과제: 조문 요건 분해]': () => ({ articles: [{ articleId: 'A1', burden: '', elements: [
    { text: '취업규칙을 변경할 것', mandatory: true, isException: false, sourceIds: ['A1.1'] },
    { text: '근로자에게 불리한 변경일 것', mandatory: true, isException: false, sourceIds: ['A1.1x'] }] }] }),
  '[과제: 요건별 포섭]': prompt => {
    const I2 = prompt.includes('[검토 쟁점 I2]');
    // 프롬프트에 실린 요건에만 답한다(쟁점마다 고른 요건이 다르다).
    return { reasoning: '검토', narrative: I2 ? '선결 쟁점에 따른다 [A1.1x].' : '불리한 변경이면 동의가 필요하다 [A1.1x] [P9].',
      assessments: [
        { elementId: 'A1.E1', status: 'SATISFIED', proof: 'SUFFICIENT', factIds: ['F1'], contraryFactIds: [], evidenceIds: ['A1.1'], analysis: '변경 조항이 있다', openQuestion: '' },
        { elementId: 'A1.E2', status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [], contraryFactIds: [], evidenceIds: ['A1.1x'], analysis: '불리한지 알 수 없다',
          openQuestion: I2 ? '' : '임금 체계 변경이 불리한 변경인지 판단하는 기준은 무엇인가?' }]
        .filter(a => prompt.includes(`[${a.elementId}]`)),
      precedents: [], counter: { position: '사회통념상 합리성이 있으면 동의가 없어도 유효하다', evidenceIds: [], response: '' } };
  },
  '[과제: 근거-주장 대응 확인]': () => ({ results: [{ pair: 1, label: 'SUPPORTS' }] }),
  '[과제: 수정 조문 작성]': () => ({ revisedText: '회사는 근로자에게 불리하게 이 규칙을 변경하려면 근로자 과반수의 동의를 받아야 한다.', reason: '동의 요건 [A1.1x]', evidenceIds: ['A1.1x'] }),
  '[과제: 종합]': () => ({ summary: '불리한 변경 여부가 확인되지 않아 판단을 유보한다.', risks: [{ issueId: 'I1', level: 'HIGH', title: '동의 없는 변경', description: '무효 위험' }], recommendations: ['변경 내용 비교표 확보'] })
};
const reply = content => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop', prompt_eval_count: 2000, eval_count: 100 })}\n`);
})() });
const fakeOllama = ({ failS1 = false } = {}) => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    const marker = Object.keys(STAGE_REPLIES).find(m => prompt.includes(m));
    calls.push({ marker, prompt, body });
    if (!marker) return reply(JSON.stringify({ summary: '단일 호출', facts: '', legalOpinion: '의견', draftOpinion: '초안', coreIssues: [], legalBasis: [], risks: [], recommendations: [], redlineDiffs: [], furtherChecks: [] }));
    if (failS1 && marker.includes('사건 사실')) return reply('깨진 출력');
    return reply(JSON.stringify(STAGE_REPLIES[marker](prompt)));
  };
  return calls;
};
const clients = { searchPrecedents: async () => [], searchInterpretations: async () => [] };
const embed = async texts => ({ vectors: texts.map(() => [1, 0]), warning: null });
const cache = () => createStageCache(path.join(ENV.CACHE_DIR, `pipeline-${Date.now()}-${Math.random()}.db`));

test('단계형 파이프라인은 캐시를 살리는 순서로 호출하고 결론은 코드가 계산하며 기존 검토 형식으로 조립한다', async () => {
  const calls = fakeOllama();
  const session = createLlmSession();
  const review = await runReasoningPipeline({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText, workbenchContext: workbenchContext(),
    provider: 'ollama', model: ENV.OLLAMA_MODEL, session, clients, embed, cache: cache() });

  assert.deepEqual(session.ledger.calls.map(c => c.stage), ['s1', 's3', 's4:I1', 's4:I2', 's5', 's5r:D1']);
  // S1·S3는 같은 공통 접두부, S4·S5는 그 뒤에 사실·쟁점 목록을 붙인 같은 실행 접두부로 시작한다.
  const p0 = calls[0].prompt.split('\n\n[과제:')[0];
  assert.ok(calls[1].prompt.startsWith(p0));
  const runPrefix = calls[2].prompt.split('\n\n[검토 쟁점')[0];
  assert.ok(runPrefix.startsWith(p0) && runPrefix.includes('[쟁점 목록]'));
  assert.ok(calls[3].prompt.startsWith(runPrefix) && calls[4].prompt.startsWith(runPrefix));
  assert.ok(calls.every(c => c.body.options.num_ctx === calls[0].body.options.num_ctx), '실행 내내 같은 num_ctx');
  assert.ok(calls.every(c => c.body.think === false));

  const [i1, i2] = review.reasoning.issues;
  assert.equal(i1.conclusion.legal, 'CONDITIONAL', '불리한 변경 여부(필수 요건)가 미확정이면 판단 유보');
  assert.equal(i2.conclusion.legal, 'CONDITIONAL');
  assert.deepEqual(review.reasoning.diagnostics.s1.rejectedIds, [{ owner: 'I2', id: 'ZZ9' }]);
  assert.match(i1.warnings.join(' '), /P9/, '서술 속 허용되지 않은 인용 표기는 제거된다');
  assert.doesNotMatch(i1.narrative, /\[P9\]/);

  // 공백: 법리 공백은 외부 질의로, 입증 부족·자료 밖 사실은 사용자 확인으로.
  const routes = review.reasoning.gaps.map(g => [g.type, g.route]);
  assert.ok(routes.some(([t, r]) => t === 'LEGAL_INTERPRETATION' && r === 'EXTERNAL_INQUIRY'));
  assert.ok(routes.some(([t, r]) => t === 'AUTHORITY_CONFLICT' && r === 'EXTERNAL_INQUIRY'), '응답하지 못한 반대 논리');
  assert.ok(routes.some(([t, r]) => t === 'FACT_UNKNOWN' && r === 'USER'));
  assert.ok(review.reasoning.gaps.find(g => g.type === 'LEGAL_INTERPRETATION').question.includes('불리한 변경인지'));

  // 기존 형식
  assert.equal(review.reviewEngine, 'LLM_STAGED');
  assert.equal(review.reviewStatus, 'PARTIAL');
  assert.deepEqual(review.coreIssues, ['불리한 변경에 근로자 동의가 필요한가?', '제41조는 효력이 있는가?']);
  assert.deepEqual(review.legalBasis.map(b => [b.lawName, b.articleNo, b.evidenceIds, b.includesProviso]), [[law, '제94조 제1항', ['A1.1', 'A1.1x'], true]],
    '원칙(A1.1)과 단서(A1.1x)는 같은 조·항 인용 하나로 합친다');
  assert.match(review.legalOpinion, /\[쟁점 1\][\s\S]*결론: 판단 유보/);
  assert.match(review.legalOpinion, /\(근로기준법 제94조 제1항 단서\)/, '[ID] 표기를 읽을 수 있는 인용으로 바꾼다');
  assert.ok(review.furtherChecks.some(x => x.startsWith('[외부 전문가 질의 필요]')));
  assert.match(review.draftOpinion, /## 4\. 결론 표/);
  // 수정 조문: 위험(HIGH)으로 정리된 쟁점에 연결된 조항만, 원문은 문서에서 그대로 가져온다.
  assert.equal(review.redlineDiffs.length, 1);
  assert.equal(review.redlineDiffs[0].originalText, documentText);
  assert.match(review.redlineDiffs[0].reason, /근로기준법 제94조 제1항 단서/);
  assert.deepEqual(review.redlineDiffs[0].issueIds, ['I1']);
  assert.equal(review.reasoning.gate, 'HUMAN_REVIEW_REQUIRED');
});

test('선결 쟁점은 뒤에 적혀 있어도 먼저 판단한다', () => {
  const order = orderByDependency([{ id: 'I1', dependsOn: ['I2'] }, { id: 'I2', dependsOn: [] }, { id: 'I3', dependsOn: ['I1'] }]);
  assert.deepEqual(order.map(i => i.id), ['I2', 'I1', 'I3']);
});

test('공식 요건이 없어 모든 쟁점을 생략하면 검토 필요 게이트와 근거 공백을 남긴다', async () => {
  fakeOllama();
  const context = workbenchContext();
  context.officialEvidence.articles = [];
  context.meta.dataIntegrity.hasOfficialArticles = false;
  const review = await runReasoningPipeline({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText,
    workbenchContext: context, provider: 'ollama', model: ENV.OLLAMA_MODEL,
    session: createLlmSession(), clients, embed, cache: cache() });
  assert.ok(review.reasoning.issues.every(i => i.stageStatus === 'SKIPPED'));
  assert.equal(review.reasoning.gate, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(review.reviewStatus, 'PARTIAL');
  assert.equal(review.reasoning.gaps.filter(g => g.type === 'MISSING_AUTHORITY').length, review.reasoning.issues.length);
});

test('REVIEW_PIPELINE=staged이면 검토가 단계형으로 돌고 인용 검증을 거치며, 쟁점 정리에 실패하면 단일 호출 검토로 넘어간다', async () => {
  process.env.REVIEW_PIPELINE = 'staged';
  const run = () => generateLegalReview({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText, workbenchContext: workbenchContext(),
    llmConfig: { provider: 'ollama' } });

  // 등록부·요건 캐시·검색을 주입할 수 없는 경로이므로, 검색은 네트워크가 막힌 상태에서 '조회 미완료'로 끝난다.
  fakeOllama();
  const staged = await run();
  assert.equal(staged.reviewEngine, 'LLM_STAGED');
  assert.ok(staged.factualityVerification, '단계형 결과도 기존 인용 검증을 거친다');
  assert.ok(staged.llmLedger.calls.some(c => c.stage === 's1'));

  const calls = fakeOllama({ failS1: true });
  const fallback = await run();
  assert.equal(fallback.reviewEngine, 'LLM');
  assert.deepEqual(fallback.llmLedger.calls.map(c => c.stage), ['s1', 's1:retry', 'review'], '실패한 단계 호출도 원장에 남는다');
  assert.equal(calls.at(-1).marker, undefined, '마지막 호출은 기존 단일 호출 프롬프트');
});

test('재검토: 공식 근거가 같으면 S1·S2를 건너뛰고, 외부 답변이 연결된 쟁점과 후속 쟁점만 다시 판단하며, 이전 공백의 해소 여부를 남긴다', async () => {
  const stageCache = cache();
  fakeOllama();
  const first = await runReasoningPipeline({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText, workbenchContext: workbenchContext(),
    provider: 'ollama', model: ENV.OLLAMA_MODEL, session: createLlmSession(), clients, embed, cache: stageCache });
  const openGap = first.reasoning.gaps.find(g => g.issueId === 'I1' && g.type === 'LEGAL_INTERPRETATION');
  assert.ok(openGap);

  // 외부 전문가 답변(K1)이 I1의 공백을 메운다. 답을 받은 뒤의 모델은 해당 요건을 충족으로 판단한다.
  const withKnowledge = { ...workbenchContext(), learningKnowledge: [{ id: 'k-1', title: '불이익 변경 판단 기준', source: 'USER_APPROVED_HUMAN_EXPERT',
    card: { issue: '불이익 변경' }, answers: [{ questionNo: 1, position: '임금 총액이 줄면 불리한 변경이다' }] }] };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    const body = JSON.parse(options.body);
    const prompt = body.messages[1].content;
    calls.push(prompt);
    if (prompt.includes('[과제: 요건별 포섭]')) {
      const answered = prompt.includes('[K1]');
      return reply(JSON.stringify({ reasoning: '', narrative: '답변을 반영했다 [A1.1x].', precedents: [], counter: { position: '', evidenceIds: [], response: '' },
        assessments: [{ elementId: 'A1.E1', status: 'SATISFIED', proof: 'SUFFICIENT', factIds: ['F1'], contraryFactIds: [], evidenceIds: ['A1.1'], analysis: '', openQuestion: '' },
          { elementId: 'A1.E2', status: answered ? 'SATISFIED' : 'UNKNOWN', proof: 'SUFFICIENT', factIds: ['F1'], contraryFactIds: [], evidenceIds: ['A1.1x'], analysis: '', openQuestion: '' }]
          .filter(a => prompt.includes(`[${a.elementId}]`)) }));
    }
    const marker = prompt.includes('[과제: 수정 조문 작성]') ? '[과제: 수정 조문 작성]' : '[과제: 종합]';
    return reply(JSON.stringify(STAGE_REPLIES[marker]()));
  };
  const session = createLlmSession();
  const second = await runReasoningPipeline({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText, workbenchContext: withKnowledge,
    provider: 'ollama', model: ENV.OLLAMA_MODEL, session, clients, embed, cache: stageCache,
    previous: { historyId: 'rev_1', reasoning: first.reasoning, rerunIssueIds: ['I1'], knowledgeIssues: new Map([['k-1', ['I1']]]) } });

  assert.deepEqual(session.ledger.calls.map(c => c.stage), ['s4:I1', 's4:I2', 's5', 's5r:D1'], 'S1·S2는 재사용, S3는 저장된 요건, I2는 I1의 후속이라 함께 다시 판단');
  assert.ok(calls[0].includes('[K1]') && calls[0].includes('임금 총액이 줄면'), '연결된 쟁점 입력에 질문별 답변이 실린다');
  assert.deepEqual(second.reasoning.reuse.rerunIssueIds.sort(), ['I1', 'I2']);
  assert.equal(second.reasoning.issues[0].conclusion.legal, 'APPLIES');
  const transition = second.reasoning.reuse.gapTransitions.find(t => t.previousGapId === openGap.id);
  assert.equal(transition.state, 'RESOLVED');
});

test('재검토: 이전 검토 이후 공식 근거가 바뀌었으면 처음부터 다시 하고 그 사실을 알린다', async () => {
  fakeOllama();
  const first = await runReasoningPipeline({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText, workbenchContext: workbenchContext(),
    provider: 'ollama', model: ENV.OLLAMA_MODEL, session: createLlmSession(), clients, embed, cache: cache() });
  const changed = workbenchContext();
  changed.officialEvidence.articles[0].paragraphs[0].content += ' (개정)';
  const session = createLlmSession();
  const second = await runReasoningPipeline({ query: '취업규칙 변경 검토', preset: 'labor_hr', documentText, workbenchContext: changed,
    provider: 'ollama', model: ENV.OLLAMA_MODEL, session, clients, embed, cache: cache(),
    previous: { reasoning: first.reasoning, rerunIssueIds: ['I1'], knowledgeIssues: new Map() } });
  assert.equal(session.ledger.calls[0].stage, 's1');
  assert.equal(second.reasoning.reuse, null);
  assert.ok(second.warnings.some(w => /공식 근거가 달라져/.test(w)));
});
