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
    assert.equal(payload.meta.retrievalAvailability.precedents.status, 'UNAVAILABLE');
    assert.ok(payload.historyId);
    const stored = await request(`/history/${payload.historyId}`);
    assert.equal(stored.status, 200);
    assert.ok(stored.text.includes('RULE_BASED_FALLBACK'));
    const report = await request('/report', { format: 'md', content: '검토문', reviewData: payload });
    assert.ok(report.text.includes('법리 검토를 완료하지 못했습니다'));
    assert.equal((await request('/history', null, 'https://external.example')).status, 403);
    // 시점 검토 표식은 룰베이스 폴백 보고서에도 남는다.
    const dated = JSON.parse((await request('/workbench', { query: '검토', targetLaw: '개인정보 보호법', targetDate: '2021-01-01', llmProvider: 'rule_based' })).text);
    assert.equal(dated.meta.targetDate, '20210101');
    assert.ok(dated.reliability.warnings.some(w => w.includes('20210101 시점에 시행 중이던')));
    const datedReport = await request('/report', { format: 'md', content: '검토문', reviewData: dated });
    assert.ok(datedReport.text.includes('20210101 시점에 시행 중이던'));
    // 형식이 틀린 기준일을 조용히 오늘로 바꾸지 않고 거절한다.
    const badDate = await request('/workbench', { query: '검토', targetLaw: '개인정보 보호법', targetDate: '21-1-1', llmProvider: 'rule_based' });
    assert.equal(badDate.status, 400);
    assert.ok(JSON.parse(badDate.text).error.includes('검토 기준일'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
