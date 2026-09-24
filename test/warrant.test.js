import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../server/env.js';
import { resolveBudget } from '../server/law/llmBudget.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { evidenceFragments, verifyWarrants } from '../server/reasoning/verify/warrant.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const budget = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, contextTokens: 16384, outputTokens: 1024 });
const config = { model: ENV.OLLAMA_MODEL, budget };
const embed = async texts => ({ vectors: texts.map(() => [1, 0]), warning: null });
const issue = ids => ({ issueId: 'I1', elements: [{ id: 'A1.E1', text: '허가를 받을 것' }],
  assessments: [{ elementId: 'A1.E1', analysis: '허가 요건', evidenceIds: ids, status: 'SATISFIED' }] });
const registry = entries => ({ asOf: '20260923', get: id => entries.get(id) || null });
const response = label => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content: JSON.stringify({ results: [{ pair: 1, label }] }), done: true,
    done_reason: 'stop', prompt_eval_count: 300, eval_count: 40 } })}\n`);
})() });
const fakeOllama = handler => {
  const prompts = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    const prompt = JSON.parse(options.body).messages[1].content;
    prompts.push(prompt);
    return handler(prompt, prompts.length);
  };
  return prompts;
};

test('S6은 유사도가 높아도 모든 12쌍 초과 근거를 원문으로 확인한다', async () => {
  const ids = Array.from({ length: 13 }, (_, i) => `A${i + 1}`);
  const entries = new Map(ids.map(id => [id, { id, text: '허가를 받아야 한다.', official: true, inForce: true }]));
  const prompts = fakeOllama(() => response('SUPPORTS'));
  const result = await verifyWarrants({ issueResults: [issue(ids)], registry: registry(entries), provider: 'ollama', config,
    session: createLlmSession(), embed });
  assert.equal(prompts.length, 13);
  assert.equal(result.entailmentCalls, 13);
  assert.deepEqual(result.unreviewedPairs, []);
  assert.equal(result.ledger[0].checks.length, 13);
  assert.equal(result.ledger[0].overall, 'SUPPORTED');
  assert.ok(prompts.every(p => !p.includes('[쟁점 목록]') && p.startsWith('[검토 기준일]')));
});

test('유사도는 지지 판정을 대신하지 않고 함의 호출 실패는 미확인으로 남는다', async () => {
  const entries = new Map([['A1', { id: 'A1', text: '허가를 받아야 한다.', official: true, inForce: true }]]);
  fakeOllama(() => ({ ok: false, status: 500 }));
  const result = await verifyWarrants({ issueResults: [issue(['A1'])], registry: registry(entries), provider: 'ollama', config,
    session: createLlmSession(), embed });
  assert.equal(result.ledger[0].checks[0].alignment, 'ALIGNED');
  assert.equal(result.ledger[0].overall, 'UNCONFIRMED');
  assert.deepEqual(result.unreviewedPairs, [{ claimId: 'I1:A1.E1', evidenceId: 'A1' }]);
});

test('긴 근거는 누락 없이 나누어 각각 확인한다', async () => {
  const longText = '허가를 받아야 한다. '.repeat(170);
  const fragments = evidenceFragments(longText);
  assert.equal(fragments.map(f => f.text).join(''), longText);
  const entries = new Map([['A1', { id: 'A1', text: longText, official: true, inForce: true }]]);
  const prompts = fakeOllama(() => response('SUPPORTS'));
  const result = await verifyWarrants({ issueResults: [issue(['A1'])], registry: registry(entries), provider: 'ollama', config,
    session: createLlmSession(), embed });
  assert.equal(prompts.length, fragments.length);
  assert.equal(result.ledger[0].checks[0].segments.at(-1).end, longText.length);
  assert.equal(result.ledger[0].overall, 'SUPPORTED');
});

test('근거 ID가 없는 요건 판단도 검증 원장에 공식 근거 없음으로 남긴다', async () => {
  const result = await verifyWarrants({ issueResults: [issue([])], registry: registry(new Map()), provider: 'ollama', config,
    session: createLlmSession(), embed });
  assert.equal(result.entailmentCalls, 0);
  assert.equal(result.ledger[0].overall, 'NO_OFFICIAL_SUPPORT');
});
