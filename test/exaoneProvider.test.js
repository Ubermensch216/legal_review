import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../server/env.js';
import { readTokenUsage, resolveBudget } from '../server/law/llmBudget.js';
import { callExaone, callProvider, describeProviderMisconfiguration } from '../server/reasoning/llmGateway.js';

const realFetch = globalThis.fetch;
const realKey = ENV.EXAONE_API_KEY;
const TEST_KEY = 'test-exaone-key';
afterEach(() => { globalThis.fetch = realFetch; ENV.EXAONE_API_KEY = realKey; });

const budget = resolveBudget('exaone', { model: 'k-exaone_v2.5', outputTokens: 512 });

const sse = chunks => ({ ok: true, status: 200, body: (async function* () {
  const text = `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  // 청크 경계가 줄 중간에 걸려도 조립되는지 함께 확인한다.
  for (let i = 0; i < bytes.length; i += 17) yield bytes.slice(i, i + 17);
})() });

const delta = (fields, extra = {}) => ({ choices: [{ delta: fields, finish_reason: extra.finish ?? null }], ...extra.top });
const failure = (status, description, headers = {}) => ({ ok: false, status,
  headers: { get: name => headers[name] ?? null }, json: async () => ({ result_code: status, description }) });

test('문서의 엔드포인트·인증으로 호출하고 추론 토큰 몫을 max_tokens에 더한다', async () => {
  ENV.EXAONE_API_KEY = TEST_KEY;
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options, body: JSON.parse(options.body) };
    return sse([delta({ content: '{"ok":true}' }, { finish: 'stop' })]); };
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  await callExaone('sys', 'user', { budget, schema, think: false });

  assert.equal(request.url, 'https://api.exaone.ai/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.equal(request.body.model, 'k-exaone_v2.5');
  assert.equal(request.body.reasoning_effort, 'low');
  assert.equal(request.body.max_tokens, 512 + 4096);
  assert.equal(Object.hasOwn(request.body, 'response_format'), false);
  assert.match(request.body.messages[0].content, /JSON Schema/);
  assert.match(request.body.messages[0].content, /"ok"/);
});

test('추론 내용은 본문에서 빼고, 앞뒤 공백과 사용량을 정리한다', async () => {
  ENV.EXAONE_API_KEY = TEST_KEY;
  globalThis.fetch = async () => sse([
    delta({ reasoning_content: '먼저 생각한다 {not json}' }),
    delta({ content: '\n\n{"answer":' }),
    delta({ content: '"가"}' }, { finish: 'stop' }),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40, reasoning_tokens: 20 } }
  ]);
  const result = await callExaone('sys', 'user', { budget });
  assert.equal(result.content, '{"answer":"가"}');
  assert.equal(result.tokenUsage.inputTokens, 10);
  assert.equal(result.tokenUsage.reasoningTokens, 20);
  assert.ok(result.timing.thinkingChars > 0);
});

test('출력 한도 절단은 truncated로 알린다', async () => {
  ENV.EXAONE_API_KEY = TEST_KEY;
  globalThis.fetch = async () => sse([delta({ content: '{"a":' }, { finish: 'length' })]);
  await assert.rejects(callExaone('s', 'u', { budget }), err => err.truncated === true);
});

test('429는 retry-after를 따라 재시도하고, 401은 재시도하지 않는다', async () => {
  ENV.EXAONE_API_KEY = TEST_KEY;
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? failure(429, 'limit', { 'retry-after-ms': '1' })
    : sse([delta({ content: '{}' }, { finish: 'stop' })]));
  assert.equal((await callExaone('s', 'u', { budget })).content, '{}');
  assert.equal(calls, 2);

  calls = 0;
  globalThis.fetch = async () => { calls++; return failure(401, 'unauthorized'); };
  await assert.rejects(callExaone('s', 'u', { budget }), /HTTP 401.*EXAONE_API_KEY/);
  assert.equal(calls, 1);
});

test('키가 없으면 호출하지 않고 설정할 환경변수를 알려준다', () => {
  ENV.EXAONE_API_KEY = '';
  globalThis.fetch = async () => { throw new Error('호출되면 안 됩니다'); };
  assert.throws(() => callProvider('exaone', 's', 'u', { budget }), /EXAONE_API_KEY/);
  assert.match(describeProviderMisconfiguration('exaone'), /\.env에 EXAONE_API_KEY/);
});

test('기본 예산과 사용량 해석', () => {
  const base = resolveBudget('exaone', { model: 'k-exaone_v2.5' });
  assert.ok(base.contextTokens <= 524288);
  assert.equal(readTokenUsage('exaone', { usage: { prompt_tokens: 1, completion_tokens: 2 } }).outputTokens, 2);
});
