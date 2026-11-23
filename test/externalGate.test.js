import './setup.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../server/env.js';
import { callProvider, complete, createLlmSession } from '../server/reasoning/llmGateway.js';
import { resolveBudget, createTokenCounter } from '../server/law/llmBudget.js';
import { ExternalTransmissionBlockedError, canStartWithProvider, isTransmissionAllowed, payloadDigest,
  setExternalTransmissionPolicyForTests } from '../server/reasoning/externalGate.js';

const realFetch = globalThis.fetch;
const realKeys = { openai: ENV.OPENAI_API_KEY, exaone: ENV.EXAONE_API_KEY, anthropic: ENV.ANTHROPIC_API_KEY };
let sent;

// 시험 공통 설정(전송 허용)을 풀고, 운영과 같은 기본 차단 상태에서 확인한다.
beforeEach(() => {
  setExternalTransmissionPolicyForTests(null);
  sent = [];
  ENV.OPENAI_API_KEY = 'test-key'; ENV.EXAONE_API_KEY = 'test-key'; ENV.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async (url) => { sent.push(String(url)); throw new Error('네트워크 호출이 일어나면 안 됩니다'); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  ENV.OPENAI_API_KEY = realKeys.openai; ENV.EXAONE_API_KEY = realKeys.exaone; ENV.ANTHROPIC_API_KEY = realKeys.anthropic;
  setExternalTransmissionPolicyForTests(() => true);
});

const budget = resolveBudget('openai', { model: 'm', outputTokens: 512 });

test('승인이 없으면 모든 외부 제공자 호출을 네트워크에 닿기 전에 막는다', () => {
  for (const provider of ['openai', 'anthropic', 'gemini', 'exaone']) {
    ENV.GEMINI_API_KEY ||= 'test-key';
    assert.throws(() => callProvider(provider, 'sys', '문서 원문', { budget, apiKey: 'k' }), ExternalTransmissionBlockedError, provider);
  }
  assert.deepEqual(sent, []);
});

test('차단 오류는 사용자가 할 일을 알려 주고 원문은 담지 않는다', async () => {
  const session = createLlmSession();
  await assert.rejects(complete({ stage: 'x', provider: 'exaone', system: 's', user: '주민번호 900101-1234567', config: { budget }, session }),
    err => err.code === 'EXTERNAL_TRANSMISSION_BLOCKED' && err.statusCode === 409 && /Ollama/.test(err.message) && !/900101/.test(err.message));
  assert.equal(session.ledger.calls[0].ok, false);
  assert.ok(!JSON.stringify(session.ledger.calls).includes('900101'));
});

test('로컬 제공자는 게이트와 무관하다', () => {
  assert.equal(isTransmissionAllowed('ollama', 's', 'u'), true);
  assert.equal(isTransmissionAllowed('rule_based', 's', 'u'), true);
  assert.equal(canStartWithProvider('ollama'), true);
  assert.equal(canStartWithProvider('exaone'), false);
});

test('승인은 전송문 해시에 묶여, 내용이 바뀌면 다시 막힌다', () => {
  const approval = { approvedDigests: new Set([payloadDigest('s', '승인한 전송문')]) };
  assert.equal(isTransmissionAllowed('exaone', 's', '승인한 전송문', approval), true);
  assert.equal(isTransmissionAllowed('exaone', 's', '승인한 전송문 ', approval), false);
  assert.equal(isTransmissionAllowed('exaone', 's2', '승인한 전송문', approval), false);
  assert.equal(isTransmissionAllowed('openai', 's', '승인한 전송문'), false);
});

test('토큰 계수 API도 승인 없이는 프롬프트를 보내지 않고 추정치로 되돌아간다', async () => {
  const counter = createTokenCounter('anthropic', { model: 'claude-x', apiKey: 'k' });
  const result = await counter.measure('지시문', '문서 원문 '.repeat(50));
  assert.equal(result.exact, false);
  assert.match(result.countError || '', /차단/);
  assert.deepEqual(sent, []);
});
