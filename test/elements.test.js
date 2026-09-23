import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENV } from '../server/env.js';
import { resolveBudget } from '../server/law/llmBudget.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { createStageCache } from '../server/reasoning/stageCache.js';
import { decomposeArticles, selectIssueElements, skeletonElements } from '../server/reasoning/stages/elements.js';

const noNetwork = globalThis.fetch;
afterEach(() => { globalThis.fetch = noNetwork; });

const budget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 16384, outputTokens: 2048 });
const config = { budget, model: ENV.OLLAMA_MODEL };
const OFFICIAL = { source: 'OFFICIAL_API' };
const law = '근로기준법';
const context = (text94 = '취업규칙을 변경하는 경우 과반수의 의견을 들어야 한다. 다만, 불리하게 변경하는 경우에는 그 동의를 받아야 한다.') => ({
  meta: { primaryLawName: law, asOfDate: '20260923' },
  officialEvidence: { lawDetail: { ...OFFICIAL, lawName: law }, articles: [
    { ...OFFICIAL, lawName: law, fullArticleNo: '56', title: '연장근로', enforceDate: '20200101', content: '',
      paragraphs: [{ paragraphNo: '①', content: '연장근로에 대하여 통상임금의 100분의 50 이상을 가산하여 지급하여야 한다.' },
        { paragraphNo: '②', content: '휴일근로에 대하여 가산하여 지급하여야 한다.' }] },
    { ...OFFICIAL, lawName: law, fullArticleNo: '94', title: '변경 절차', enforceDate: '20200101', content: '',
      paragraphs: [{ paragraphNo: '①', content: text94 }] }
  ] }
});

const reply = content => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 200 })}\n`);
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
const freshCache = name => { const c = createStageCache(path.join(ENV.CACHE_DIR, `${name}-${Date.now()}.db`)); return c; };

const llmAnswer = JSON.stringify({ articles: [
  { articleId: 'A2', burden: '사용자가 동의를 받았음을 입증', elements: [
    { text: '취업규칙을 작성·변경할 것', mandatory: true, isException: false, sourceIds: ['A2.1'] },
    { text: '근로자에게 불리한 변경이면 과반수 동의를 받을 것', mandatory: true, isException: true, sourceIds: ['A2.1x', 'A9.9'] }
  ] }
] });

test('캐시에 없는 조문만 한 번에 묻고, 결과를 조문 원문 해시로 저장해 다음 검토에서는 호출하지 않는다', async () => {
  const cache = freshCache('elements-a');
  const registry = buildEvidenceRegistry(context());
  const bodies = fakeOllama(() => reply(llmAnswer));
  const first = await decomposeArticles({ articleIds: ['A2'], registry, prefix: 'P0', provider: 'ollama', config, session: createLlmSession(), cache });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].think, false);
  assert.match(bodies[0].messages[1].content, /^P0\n\n\[과제: 조문 요건 분해\][\s\S]*\[A2\.1x\] \(단서\) 다만/);
  const a2 = first.byArticle.get('A2');
  assert.equal(a2.source, 'LLM');
  assert.deepEqual(a2.elements.map(e => [e.id, e.isException, e.sourceIds]), [['A2.E1', false, ['A2.1']], ['A2.E2', true, ['A2.1x']]],
    '조문 밖의 ID(A9.9)는 버린다');

  const second = await decomposeArticles({ articleIds: ['A2'], registry: buildEvidenceRegistry(context()), prefix: 'P0', provider: 'ollama', config, session: createLlmSession(), cache });
  assert.equal(bodies.length, 1, '같은 원문이면 LLM을 부르지 않는다');
  assert.equal(second.byArticle.get('A2').source, 'CACHE');

  // 조문이 개정되면 원문 해시가 바뀌어 다시 계산한다.
  await decomposeArticles({ articleIds: ['A2'], registry: buildEvidenceRegistry(context('개정된 변경 절차 조문.')), prefix: 'P0', provider: 'ollama', config, session: createLlmSession(), cache });
  assert.equal(bodies.length, 2);
  cache.close();
});

test('모델이 실패하거나 조문을 빠뜨리면 항·단서 골격으로 대체하고, 대체한 결과는 캐시하지 않는다', async () => {
  const cache = freshCache('elements-b');
  const registry = buildEvidenceRegistry(context());
  fakeOllama(() => ({ ok: false, status: 500 }));
  const failed = await decomposeArticles({ articleIds: ['A1', 'A2', 'P1', 'ZZ'], registry, prefix: 'P0', provider: 'ollama', config, session: createLlmSession(), cache });
  assert.deepEqual([...failed.byArticle.keys()], ['A1', 'A2'], '조문이 아닌 ID는 무시한다');
  assert.equal(failed.byArticle.get('A1').source, 'SKELETON');
  assert.deepEqual(failed.byArticle.get('A2').elements.map(e => [e.sourceIds[0], e.isException]), [['A2.1', false], ['A2.1x', true]]);
  assert.match(failed.warnings[0], /골격 요건으로 대체/);

  const bodies = fakeOllama(() => reply(llmAnswer)); // A2만 답한다
  const partial = await decomposeArticles({ articleIds: ['A1', 'A2'], registry, prefix: 'P0', provider: 'ollama', config, session: createLlmSession(), cache });
  assert.equal(bodies.length, 1, '실패한 대체 결과는 저장되지 않아 다시 묻는다');
  assert.equal(partial.byArticle.get('A1').source, 'SKELETON');
  assert.equal(partial.byArticle.get('A2').source, 'LLM');
  cache.close();
});

test('쟁점이 하위 단위를 가리키면 그 단위와 단서에서 나온 요건만, 조문 전체를 가리키면 전부를 고른다', () => {
  const registry = buildEvidenceRegistry(context());
  const decomposed = new Map([['A1', { elements: skeletonElements(registry, 'A1') }], ['A2', { elements: skeletonElements(registry, 'A2') }]]);
  const unitIssue = { evidenceIds: ['A1.1', 'A2.1', 'P1'] };
  assert.deepEqual(selectIssueElements(unitIssue, decomposed, registry).map(e => e.id), ['A1.E1', 'A2.E1', 'A2.E2'],
    'A1.2(휴일근로)는 빼고, A2.1을 가리키면 그 단서 A2.1x도 함께 본다');
  assert.deepEqual(selectIssueElements({ evidenceIds: ['A1'] }, decomposed, registry).map(e => e.id), ['A1.E1', 'A1.E2']);
});

test('요건이 상한을 넘으면 예외 요건은 모두 남긴다', () => {
  const registry = buildEvidenceRegistry(context());
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `A1.E${i + 1}`, text: `요건 ${i + 1}`, mandatory: true, isException: i >= 10, sourceIds: ['A1'] }));
  const selected = selectIssueElements({ evidenceIds: ['A1'] }, new Map([['A1', { elements: many }]]), registry);
  assert.equal(selected.length, 10);
  assert.deepEqual(selected.filter(e => e.isException).map(e => e.id), ['A1.E11', 'A1.E12']);
});
