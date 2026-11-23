import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { ENV } from '../server/env.js';
import router from '../server/law/lawApi.js';
import { setExternalTransmissionPolicyForTests } from '../server/reasoning/externalGate.js';

const realFetch = globalThis.fetch;
const realKey = ENV.EXAONE_API_KEY;
afterEach(() => { globalThis.fetch = realFetch; ENV.EXAONE_API_KEY = realKey; setExternalTransmissionPolicyForTests(() => true); });

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/law', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await fn(server.address().port); } finally { await new Promise(resolve => server.close(resolve)); }
}
const call = (port, path, method, body) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = http.request({ host: '127.0.0.1', port, path: `/api/law/${path}`, method,
    headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
  });
  req.on('error', reject);
  req.end(payload);
});
const post = (port, path, body) => call(port, path, 'POST', body);

const input = { query: '홍길동 과장(010-1234-5678)에게 지급한 수당이 적법한가', documentText: '담당 홍길동 과장의 계좌 110-123-456789로 지급', llmProvider: 'exaone' };

test('외부 LLM만 쓰는 모드는 비식별 미리보기의 해시를 승인해야 시작하고, 아무것도 보내기 전에 막는다', async () => {
  setExternalTransmissionPolicyForTests(null);
  ENV.EXAONE_API_KEY = 'test-key';
  let outbound = 0;
  globalThis.fetch = async (url, options) => { if (String(url).includes('exaone')) outbound++; return realFetch(url, options); };
  await withServer(async port => {
    const preview = await post(port, 'privacy/preview', input);
    assert.equal(preview.status, 200);
    assert.ok(preview.body.replacements >= 3);
    const shown = `${preview.body.query}\n${preview.body.documentText}`;
    assert.ok(!/홍길동|010-1234-5678|110-123-456789/.test(shown), '미리보기에는 식별정보가 없다');
    assert.deepEqual(preview.body.remaining, []);

    const blocked = await post(port, 'workbench', input);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'EXTERNAL_TRANSMISSION_BLOCKED');
    assert.equal(blocked.body.needsApproval, true);

    const wrong = await post(port, 'workbench', { ...input, externalApprovalDigest: 'f'.repeat(64) });
    assert.equal(wrong.status, 409, '다른 내용에 대한 승인은 통하지 않는다');

    const changed = await post(port, 'workbench', { ...input, query: `${input.query} 추가`, externalApprovalDigest: preview.body.digest });
    assert.equal(changed.status, 409, '승인 뒤 입력이 바뀌면 다시 막힌다');
  });
  assert.equal(outbound, 0, '승인 전에는 외부로 아무것도 나가지 않는다');
});

test('로컬 제공자에는 외부 미리보기를 만들지 않는다', async () => {
  await withServer(async port => {
    const res = await post(port, 'privacy/preview', { ...input, llmProvider: 'ollama' });
    assert.equal(res.status, 400);
  });
});

test('설정 조회는 외부 제공자별 키 설정 여부만 알려 주고 값은 알려 주지 않는다', async () => {
  ENV.EXAONE_API_KEY = 'secret-value-123';
  await withServer(async port => {
    const res = (await call(port, 'config', 'GET')).body;
    assert.equal(res.externalProviders.exaone, true);
    assert.ok(!JSON.stringify(res).includes('secret-value-123'));
  });
});
