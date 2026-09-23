import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../server/env.js';
import { resolveBudget } from '../server/law/llmBudget.js';
import { callOllama, callProvider, complete, createLlmSession, createRunLedger, prefixCacheLikely } from '../server/reasoning/llmGateway.js';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';

const noNetwork = globalThis.fetch;
afterEach(() => { globalThis.fetch = noNetwork; });

const budget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 16384, outputTokens: 2048 });

/** Ollama의 마지막 청크 형태. 시간 값은 나노초다. */
const ndjson = (content, extra = {}) => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content, thinking: extra.thinking || '' }, done: true,
    done_reason: extra.doneReason || 'stop', prompt_eval_count: extra.inputTokens, eval_count: extra.outputTokens,
    prompt_eval_duration: extra.prefillNs, eval_duration: extra.decodeNs, load_duration: extra.loadNs })}\n`);
})() });

/** /api/tags와 /api/chat을 흉내 내고 무엇이 몇 번 불렸는지 기록한다. */
const fakeOllama = (reply = () => ndjson('{"ok":true}')) => {
  const log = { tags: 0, chats: [] };
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) { log.tags++; return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) }; }
    log.chats.push(JSON.parse(options.body));
    return reply(log.chats.length);
  };
  return log;
};

test('스키마와 사고 모드를 지정할 때만 요청에 싣고, 모델이 보고한 시간을 밀리초로 돌려준다', async () => {
  const log = fakeOllama(() => ndjson('{"issues":[]}', { inputTokens: 5224, outputTokens: 49,
    prefillNs: 300e6, decodeNs: 2.8e9, loadNs: 0, thinking: '' }));
  const schema = { type: 'object', properties: { issues: { type: 'array' } }, required: ['issues'] };
  const result = await callOllama('sys', 'user', { budget, schema, think: false });
  assert.deepEqual(log.chats[0].format, schema);
  assert.equal(log.chats[0].think, false);
  assert.equal(log.chats[0].options.num_ctx, 16384);
  assert.deepEqual(result.timing, { loadMs: 0, prefillMs: 300, decodeMs: 2800, thinkingChars: 0 });

  // 지정하지 않으면 종전 요청과 같다: JSON 모드, 사고 모드는 모델 기본값.
  await callOllama('sys', 'user', { budget });
  assert.equal(log.chats[1].format, 'json');
  assert.equal(Object.hasOwn(log.chats[1], 'think'), false);
});

test('한 검토 안의 여러 호출은 설치 모델을 한 번만 확인하고, 실패한 확인은 기억하지 않는다', async () => {
  const log = fakeOllama();
  const session = createLlmSession();
  await complete({ stage: 'a', provider: 'ollama', system: 's', user: 'u', config: { budget }, session });
  await complete({ stage: 'b', provider: 'ollama', system: 's', user: 'u', config: { budget }, session });
  assert.equal(log.tags, 1);
  assert.equal(log.chats.length, 2);

  // 세션이 없으면 호출마다 확인한다(단독 호출의 종전 동작).
  await callOllama('s', 'u', { budget });
  assert.equal(log.tags, 2);

  const down = createLlmSession();
  globalThis.fetch = async () => { throw new TypeError('connect ECONNREFUSED'); };
  await assert.rejects(complete({ stage: 'a', provider: 'ollama', system: 's', user: 'u', config: { budget }, session: down }), /Ollama 서버에 연결할 수 없습니다/);
  assert.equal(down.verifiedModels.size, 0);
});

test('원장은 성공·실패·절단 호출을 모두 남기고 합계를 낸다', async () => {
  fakeOllama(n => n === 1
    ? ndjson('{"a":1}', { inputTokens: 5223, outputTokens: 23, prefillNs: 14.5e9, decodeNs: 1.3e9 })
    : n === 2 ? ndjson('{"b":1}', { inputTokens: 5224, outputTokens: 49, prefillNs: 0.3e9, decodeNs: 2.8e9 })
      : ndjson('{"c":', { inputTokens: 100, outputTokens: 2048, doneReason: 'length' }));
  const session = createLlmSession();
  const call = stage => complete({ stage, provider: 'ollama', system: 's', user: 'u', config: { budget, think: false }, session });
  await call('s1');
  await call('s2');
  await assert.rejects(call('s3'), /토큰 한도로 잘렸습니다/);

  const { calls, totals } = session.ledger.toJSON();
  assert.deepEqual(calls.map(c => [c.stage, c.ok, c.truncated, c.prefixCacheLikely]),
    [['s1', true, false, false], ['s2', true, false, true], ['s3', false, true, null]]);
  assert.equal(calls[0].think, false);
  assert.equal(calls[2].outputTokens, 2048, '잘린 호출도 제공자가 보고한 사용량을 남긴다');
  assert.match(calls[2].error, /잘렸습니다/);
  assert.equal(totals.calls, 3);
  assert.equal(totals.failed, 1);
  assert.equal(totals.outputTokens, 23 + 49 + 2048);
  assert.equal(totals.prefillMs, 14500 + 300);
  assert.equal(totals.prefixCacheHits, 1);
  // 원장에는 프롬프트·응답 원문을 싣지 않는다.
  assert.doesNotMatch(JSON.stringify(calls), /"a":1|"b":1/);
});

test('접두부 캐시 추정은 짧은 입력이나 시간 정보가 없으면 판단하지 않는다', () => {
  assert.equal(prefixCacheLikely({ inputTokens: 200, prefillMs: 1 }), null);
  assert.equal(prefixCacheLikely({ inputTokens: 5000, prefillMs: null }), null);
  assert.equal(prefixCacheLikely({ inputTokens: 5000, prefillMs: 20000 }), false);
  assert.equal(prefixCacheLikely({ inputTokens: 5000, prefillMs: 300 }), true);
  assert.deepEqual(createRunLedger().summary(), { calls: 0, failed: 0, inputTokens: null, outputTokens: null,
    prefillMs: null, decodeMs: null, wallMs: 0, prefixCacheHits: 0 });
});

test('키가 없는 클라우드 제공자는 네트워크를 쓰지 않고 이유를 알린다', () => {
  let touched = false;
  globalThis.fetch = async () => { touched = true; throw new Error('unexpected'); };
  const saved = ENV.ANTHROPIC_API_KEY;
  ENV.ANTHROPIC_API_KEY = '';
  try {
    assert.throws(() => callProvider('anthropic', 's', 'u', { budget }), /ANTHROPIC_API_KEY가 비어 있습니다/);
    assert.throws(() => callProvider('nope', 's', 'u', { budget }), /알 수 없는 LLM 제공자/);
  } finally { ENV.ANTHROPIC_API_KEY = saved; }
  assert.equal(touched, false);
});

const reviewJson = JSON.stringify({ summary: '요약', facts: '사실', legalOpinion: '의견', draftOpinion: '초안',
  coreIssues: [], legalBasis: [], risks: [], recommendations: [], redlineDiffs: [], furtherChecks: [] });
const context = { meta: { primaryLawName: '민법' }, officialEvidence: {} };

test('검토 결과에 호출 원장이 실리고, 폴백 결과에도 실패한 호출이 남는다', async () => {
  fakeOllama(() => ndjson(reviewJson, { inputTokens: 900, outputTokens: 120, prefillNs: 2e9, decodeNs: 7e9 }));
  const ok = await generateLegalReview({ query: '면책 검토', preset: 'contract_risk', documentText: '',
    workbenchContext: context, llmConfig: { provider: 'ollama' } });
  assert.deepEqual(ok.llmLedger.calls.map(c => [c.stage, c.ok]), [['review', true]]);
  assert.equal(ok.llmLedger.totals.outputTokens, 120);

  fakeOllama(() => ({ ok: false, status: 500 }));
  const failed = await generateLegalReview({ query: '면책 검토', preset: 'contract_risk', documentText: '',
    workbenchContext: context, llmConfig: { provider: 'ollama' } });
  assert.equal(failed.isFallback, true);
  assert.deepEqual(failed.llmLedger.calls.map(c => [c.stage, c.ok]), [['review', false]]);
  assert.match(failed.llmLedger.calls[0].error, /HTTP 500/);
});
