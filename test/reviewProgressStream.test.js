// realFetch는 setup.js가 전역 fetch를 막기 전에 원본을 붙잡아야 하므로 먼저 import한다.
import { realFetch } from './helpers/realFetch.js';
import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';
import { createProgressReporter } from '../server/law/progressReporter.js';

/**
 * Ollama 흉내를 내는 로컬 서버.
 * /api/tags로 모델 목록을 주고, /api/chat에서 NDJSON 청크를 천천히 흘린다.
 * 실제 로컬 모델은 응답이 느려 진행 계측을 확인할 수 없으므로 여기서 대신 확인한다.
 */
async function withFakeOllama(chunks, fn) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'fake-model', model: 'fake-model' }] }));
    }
    if (req.url === '/api/chat') {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let i = 0;
      const push = () => {
        if (i < chunks.length) {
          res.write(`${JSON.stringify({ message: { content: chunks[i++] }, done: false })}\n`);
          return setTimeout(push, 12);
        }
        res.write(`${JSON.stringify({
          message: { content: '' }, done: true, done_reason: 'stop',
          prompt_eval_count: 120, eval_count: 40
        })}\n`);
        res.end();
      };
      return push();
    }
    res.writeHead(404).end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // setup.js가 전역 fetch를 막아두므로, 이 테스트 서버로 가는 요청만 실제 fetch로 통과시킨다.
  const blocked = globalThis.fetch;
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (input, init) => (
    String(input).startsWith(origin) ? realFetch(input, init) : blocked(input, init)
  );
  try {
    return await fn(origin);
  } finally {
    globalThis.fetch = blocked;
    await new Promise(resolve => server.close(resolve));
  }
}

const workbenchContext = {
  meta: { primaryLawName: '개인정보 보호법', dataIntegrity: { warnings: [] } },
  reviewContext: { document: { optimizedText: '', selectedChunks: [], omittedCount: 0, truncatedCount: 0 } },
  officialEvidence: { articles: [], precedents: [], interpretations: [], ordinanceArticles: [], adminRuleDetails: [] },
  impactAndRevisions: { riskClauses: [] }
};

test('LLM 생성 중 누적 글자 수가 진행 이벤트로 흘러나온다', async () => {
  // 한 줄에 200자씩 20번 흘려보내, 400ms 솎아내기를 넘겨 여러 번 통지되게 한다.
  const body = JSON.stringify({ summary: '검토 요약', coreIssues: ['쟁점'], facts: '사실', legalOpinion: '의견',
    legalBasis: [], risks: [], recommendations: [], redlineDiffs: [], furtherChecks: [], draftOpinion: '초안' });
  const chunks = [...Array(20)].map((_, i) => (i === 19 ? body : `${' '.repeat(200)}`));

  await withFakeOllama(chunks, async (url) => {
    const events = [];
    const progress = createProgressReporter(e => events.push(e));

    await generateLegalReview({
      query: '검토', preset: 'compliance', documentText: '', workbenchContext,
      llmConfig: { provider: 'ollama', model: 'fake-model', url },
      progress
    });

    // 불완전 JSON이면 복구용 분할 호출의 tick도 생길 수 있다. 본 호출의
    // 누적 글자 수 계측은 기존처럼 llm 단계의 이벤트만 확인한다.
    const ticks = events.filter(e => e.kind === 'tick' && e.key === 'llm');
    assert.ok(ticks.length >= 1, '생성 중 tick 이벤트가 없습니다');
    assert.ok(/생성 중 · [\d,]+자/.test(ticks[0].detail), `예상과 다른 tick 내용: ${ticks[0].detail}`);
    // 누적 글자 수는 증가만 한다.
    const counts = ticks.map(e => Number(e.detail.replace(/[^\d]/g, '')));
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b));

    // 생성 단계는 실제 출력 길이와 토큰 사용량으로 마감된다.
    const llmDone = events.find(e => e.kind === 'step' && e.key === 'llm' && e.state === 'DONE');
    assert.ok(llmDone, 'llm 단계 완료 이벤트가 없습니다');
    assert.ok(/자 생성/.test(llmDone.detail));

    // 무엇을 기다리는지 알리는 안내가 생성 시작 시점에 남는다.
    const waitNote = events.find(e => e.kind === 'note' && e.key === 'llm');
    assert.ok(waitNote && waitNote.detail.includes('먼저 처리'));

    // JSON 파싱과 인용 검증까지 이어진다.
    assert.ok(events.some(e => e.key === 'json' && e.state === 'DONE'));
    assert.ok(events.some(e => e.key === 'verify' && e.state === 'DONE'));
  });
});

test('LLM 호출이 실패하면 생성 단계를 FAILED로 닫고 폴백 검증까지 보고한다', async () => {
  const events = [];
  const progress = createProgressReporter(e => events.push(e));

  // 떠 있지 않은 주소를 주어 연결 실패를 만든다. (룰베이스 폴백 경로)
  const review = await generateLegalReview({
    query: '검토', preset: 'compliance', documentText: '', workbenchContext,
    llmConfig: { provider: 'ollama', model: 'fake-model', url: 'http://127.0.0.1:1' },
    progress
  });

  const llmFailed = events.find(e => e.kind === 'step' && e.key === 'llm' && e.state === 'FAILED');
  assert.ok(llmFailed, 'LLM 실패가 보고되지 않았습니다');
  assert.ok(llmFailed.detail.includes('규칙 기반 점검으로 대체'));
  assert.ok(events.some(e => e.key === 'verify' && e.state === 'DONE'));
  assert.ok(review.fallbackReason);
});
