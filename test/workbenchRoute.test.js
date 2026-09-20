import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import router from '../server/law/lawApi.js';
import { sameOriginOnly } from '../server/requestOrigin.js';

test('워크벤치 HTTP 응답·이력·다운로드가 제한 상태를 유지한다', async () => {
  const app = express();
  app.use('/api', sameOriginOnly);
  app.use(express.json());
  app.use('/api/law', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body, origin) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: `/api/law${route}`, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const response = await request('/workbench', { query: '개인정보 보호법 제15조 검토', targetLaw: '개인정보 보호법', llmProvider: 'rule_based' });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.text);
    assert.equal(payload.reliability.isFallback, true);
    assert.equal(payload.reliability.reviewStatus, 'FAILED');
    assert.equal(payload.reliability.citationConfidence, null);
    assert.equal(payload.review.legalBasis.length, 0);
    assert.ok(payload.historyId);
    const stored = await request(`/history/${payload.historyId}`);
    assert.equal(stored.status, 200);
    assert.ok(stored.text.includes('RULE_BASED_FALLBACK'));
    const report = await request('/report', { format: 'md', content: '검토문', reviewData: payload });
    assert.ok(report.text.includes('법리 검토를 완료하지 못했습니다'));
    assert.equal((await request('/history', null, 'https://external.example')).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
