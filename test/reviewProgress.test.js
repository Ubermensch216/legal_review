import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import router from '../server/law/lawApi.js';
import { createProgressReporter, NOOP_PROGRESS } from '../server/law/progressReporter.js';

/** 진행 스트림을 NDJSON 한 줄씩 읽어 메시지 배열로 돌려준다. */
function postNdjson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/law/workbench', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; });
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || '',
        messages: text.split('\n').filter(Boolean).map(line => JSON.parse(line))
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/law', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('stream=1이면 진행 이벤트를 NDJSON으로 흘리고 마지막 줄에 결과를 준다', async () => {
  await withServer(async (port) => {
    const res = await postNdjson(port, {
      query: '개인정보 보호법 제15조 검토', targetLaw: '개인정보 보호법',
      llmProvider: 'rule_based', stream: '1'
    });

    assert.equal(res.status, 200);
    assert.ok(res.contentType.includes('application/x-ndjson'));

    const progress = res.messages.filter(m => m.type === 'progress').map(m => m.event);
    const last = res.messages[res.messages.length - 1];

    // 마지막 줄은 최종 결과이며, 비스트리밍 응답과 같은 페이로드를 담는다.
    assert.equal(last.type, 'result');
    assert.equal(last.payload.ok, true);
    assert.ok(last.payload.historyId);
    assert.ok(last.payload.review);

    // 파이프라인 주요 단계가 모두 보고된다.
    const keys = new Set(progress.map(e => e.key));
    for (const key of ['doc', 'keywords', 'law', 'articles', 'search', 'integrity', 'llm', 'verify', 'save']) {
      assert.ok(keys.has(key), `${key} 단계 이벤트가 없습니다`);
    }

    // 순번은 단조 증가하고, 시작된 단계는 모두 종료 상태를 받는다.
    assert.deepEqual(progress.map(e => e.seq), progress.map((_, i) => i + 1));
    const running = progress.filter(e => e.kind === 'step' && e.state === 'RUNNING').map(e => e.key);
    const closed = new Set(progress.filter(e => e.kind === 'step' && e.state !== 'RUNNING').map(e => e.key));
    for (const key of running) assert.ok(closed.has(key), `${key} 단계가 종료 보고 없이 남았습니다`);

    // 추론 과정은 결과에도 동봉되어 이력에서 되살릴 수 있다. tick은 남기지 않는다.
    assert.ok(last.payload.progressTrace.events.length > 0);
    assert.ok(last.payload.progressTrace.stepCount > 0);
    assert.equal(last.payload.progressTrace.events.some(e => e.kind === 'tick'), false);
    assert.equal(typeof last.payload.progressTrace.totalMs, 'number');

    // 제한 사항은 경고 이벤트로도 드러난다. (공식 조문을 가져오지 못한 폴백 검토)
    assert.ok(progress.some(e => e.kind === 'warn'));
  });
});

test('stream 미지정 요청은 종전과 같은 단일 JSON 응답을 준다', async () => {
  await withServer(async (port) => {
    const res = await postNdjson(port, {
      query: '개인정보 보호법 제15조 검토', targetLaw: '개인정보 보호법', llmProvider: 'rule_based'
    });
    assert.equal(res.status, 200);
    assert.ok(res.contentType.includes('application/json'));
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0].ok, true);
    // 계측 결과가 비스트리밍 응답에 섞이지 않는다.
    assert.equal(res.messages[0].progressTrace, undefined);
  });
});

test('스트리밍 요청의 입력 검증 실패는 error 줄로 전달된다', async () => {
  await withServer(async (port) => {
    const res = await postNdjson(port, { query: '검토', targetDate: '21-1-1', stream: '1' });
    const last = res.messages[res.messages.length - 1];
    assert.equal(last.type, 'error');
    assert.ok(last.error.includes('검토 기준일'));
  });
});

test('리포터는 emit이 없으면 무동작이고, emit이 던져도 검토를 막지 않는다', () => {
  // 무동작 리포터는 예외 없이 모든 메서드를 받아넘긴다.
  assert.equal(NOOP_PROGRESS.enabled, false);
  NOOP_PROGRESS.start('k', 'l', 'd', 'g');
  NOOP_PROGRESS.note('k', 'n');
  NOOP_PROGRESS.done('k', 'd');
  NOOP_PROGRESS.finish('f');

  const reporter = createProgressReporter(() => { throw new Error('수신자 오류'); });
  assert.doesNotThrow(() => {
    reporter.start('k', 'l');
    reporter.warn('k', 'w');
    reporter.done('k', 'd');
  });

  // tick은 기본 간격 안에서 솎아낸다. (LLM 스트림이 초당 수십 회 들어온다)
  const seen = [];
  const throttled = createProgressReporter(e => seen.push(e));
  throttled.tick('llm', '1자');
  throttled.tick('llm', '2자');
  throttled.tick('llm', '3자');
  assert.equal(seen.filter(e => e.kind === 'tick').length, 1);

  // 단계 소요 시간과 상태는 done에서 채워진다.
  const events = [];
  const timed = createProgressReporter(e => events.push(e));
  timed.start('law', '기준 법령 확정', '후보 2건', '수집');
  timed.done('law', '지방재정법 확정');
  timed.fail('llm', 'LLM 호출 실패');
  const [started, finished, failed] = events;
  assert.equal(started.state, 'RUNNING');
  assert.equal(finished.state, 'DONE');
  assert.equal(finished.label, '기준 법령 확정');
  assert.equal(finished.group, '수집');
  assert.equal(typeof finished.ms, 'number');
  assert.equal(failed.state, 'FAILED');
});
