import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createManualLearningRouter } from '../server/law/manualLearningApi.js';
import { createLearningStore } from '../server/law/manualLearningStore.js';
import { redactLearningText, redactLearningValue } from '../server/law/manualLearningPrivacy.js';
import { sameOriginOnly } from '../server/requestOrigin.js';
import lawRouter from '../server/law/lawApi.js';
import { getLearningStore } from '../server/law/manualLearningStore.js';
import { ENV } from '../server/env.js';
import { ollamaStream } from './llmStreamStub.js';

test('비식별 재편집에서 가명을 재사용하지 않고 JSON 구조와 법률 조건을 보존한다', () => {
  const first = redactLearningText('가상갑과 가상갑, 2026-09-22, 30일 이내, 100만원 초과', ['가상갑']);
  assert.equal(first.counts['비공개'], 2);
  const second = redactLearningText(`${first.text} 가상을`, ['가상을']);
  assert.match(second.text, /\[비공개_1\].*\[비공개_2\]/);
  assert.match(second.text, /2026-09-22, 30일 이내, 100만원 초과/);
  const card = redactLearningValue({ title: 'title 공개 프로젝트', issue: 'api_key: secret', conditions: ['title 적용'] }, ['title']);
  assert.equal(Object.keys(card.value)[0], 'title', '스키마 키를 비식별 단어로 오인하면 안 된다');
  assert.match(card.value.title, /\[비공개_1\]/);
  assert.match(card.value.conditions[0], /\[비공개_1\]/);
  assert.doesNotMatch(JSON.stringify(card.value), /secret/);
  assert.deepEqual(JSON.parse(JSON.stringify(card.value)), card.value);
});

test('수동 학습과 같은 사건 재검토는 클라우드 요청값을 무시하고 로컬 모델만 호출한다', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = ENV.OLLAMA_URL;
  ENV.OLLAMA_URL = 'http://127.0.0.1:11434';
  const called = [];
  globalThis.fetch = async (url, options) => {
    called.push(String(url));
    assert.ok(String(url).startsWith(ENV.OLLAMA_URL));
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    assert.equal(JSON.parse(options.body).model, ENV.OLLAMA_MODEL);
    return ollamaStream(JSON.stringify({ summary: '시험', legalOpinion: '제한', draftOpinion: '초안',
      coreIssues: [], legalBasis: [], risks: [], recommendations: [], redlineDiffs: [], furtherChecks: [] }));
  };
  const app = express(); app.use(express.json()); app.use('/api/law', lawRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const post = body => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/law/workbench', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    const input = { query: '절차 검토', targetLaw: '행정기본법', llmProvider: 'openai', llmModel: 'must-not-call', llmApiKey: 'test-only' };
    const initial = await post({ ...input, learningMode: 'manual' });
    assert.equal(initial.status, 200); assert.equal(initial.data.meta.learningMode, 'manual');
    assert.ok(called.some(url => url.endsWith('/api/chat')));
    const store = getLearningStore();
    store.create('inquiry', initial.data.historyId, { text: '', questions: [{ no: 1, text: '미해결 쟁점' }] });
    const rerun = await post({ ...input, sourceHistoryId: initial.data.historyId });
    assert.equal(rerun.status, 200); assert.equal(rerun.data.meta.learningMode, 'manual');
    assert.ok(rerun.data.reliability.warnings.some(w => w.includes('승인된 답변이 연결되지 않은')));
    assert.notEqual(rerun.data.review.reviewStatus, 'COMPLETE');
  } finally {
    globalThis.fetch = originalFetch; ENV.OLLAMA_URL = originalUrl;
    await new Promise(r => server.close(r));
  }
});

test('HTTP 질의서 수정·확정·반출·답변 반입·승인·회수와 출처 삭제', async () => {
  process.env.LLM_MODEL_BUDGETS = '{}';
  const store = createLearningStore(':memory:');
  const ctx = { meta: { query: '공공시설 사용료', preset: 'compliance', primaryLawName: '가상법' },
    review: { facts: '가상 사실', coreIssues: [], furtherChecks: [] }, officialEvidence: {} };
  let calls = 0;
  const router = createManualLearningRouter({ store, history: () => ({ data: ctx }), local: async () => ++calls === 1
    ? { needsHelp: true, abstractFacts: ['가상 시설을 위탁한다'], preservedLogic: ['사용료 징수의 명시적 근거가 없다'],
      questions: ['징수권의 요건은 무엇인가?'], missingFacts: [], sensitiveTerms: [] }
    : { card: { title: '징수권 확인', issue: '사용료 징수권', conditions: ['법적 근거 확인'], exceptions: [],
      principles: ['권한을 별도 확인'], checklist: ['명시적 근거 확인'], keywords: ['시설', '사용료'], citations: [] }, answeredQuestions: [1] } });
  const app = express(); app.use('/api', sameOriginOnly); app.use(express.json()); app.use('/api/learning', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const request = (method, route, body, origin) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: `/api/learning${route}`, method,
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } }, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => {
        let data; try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    assert.equal((await request('POST', '/inquiries', { historyId: 'test' }, 'https://outside.example')).status, 403);
    const created = await request('POST', '/inquiries', { historyId: 'test' });
    assert.equal(created.status, 200);
    let item = created.data.item;
    assert.equal((await request('GET', `/inquiries/${item.id}/export`)).status, 409);
    item = (await request('PATCH', `/inquiries/${item.id}`, { revision: item.revision, text: `${item.text}\n담당 전화 010-1234-5678` })).data.item;
    assert.doesNotMatch(item.text, /010-1234-5678/);
    assert.equal((await request('POST', `/inquiries/${item.id}/confirm`, { revision: 1, privacyConfirmed: true, logicConfirmed: true })).status, 409);
    item = (await request('POST', `/inquiries/${item.id}/confirm`, { revision: item.revision, privacyConfirmed: true, logicConfirmed: true })).data.item;
    const exported = await request('GET', `/inquiries/${item.id}/export`);
    assert.equal(exported.status, 200); assert.equal(exported.data, item.text);
    const imported = await request('POST', `/inquiries/${item.id}/answers`, { answer: '가상의 외부 답변' });
    assert.equal(imported.status, 200);
    let card = imported.data.item;
    assert.equal(card.state, 'DRAFT');
    assert.equal((await request('POST', `/knowledge/${card.id}/approve`, { revision: card.revision })).status, 400);
    card = (await request('POST', `/knowledge/${card.id}/approve`, { revision: card.revision, privacyConfirmed: true, knowledgeConfirmed: true })).data.item;
    assert.equal(card.state, 'APPROVED'); assert.equal(card.legalValidity, 'NOT_CERTIFIED');
    assert.equal((await request('GET', '/')).data.inquiries[0].coverage.approved, 1);
    await request('DELETE', `/${item.id}`);
    assert.deepEqual((await request('GET', '/')).data.knowledge, []);
  } finally { await new Promise(r => server.close(r)); store.close(); }
});
