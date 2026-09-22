import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeDocumentContext } from '../server/parsers/contextOptimizer.js';
import { chunkLegalDocument } from '../server/parsers/legalDocChunker.js';
import { resolveBudget, readTokenUsage, estimatePromptTokens, resetCalibration, resolveTokenizerFamily, createTokenCounter } from '../server/law/llmBudget.js';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';
import { openAiStream, anthropicStream, providerStream } from './llmStreamStub.js';

const noNetwork = globalThis.fetch;
const keys = ['LLM_MODEL_BUDGETS', 'LLM_CONTEXT_TOKENS', 'LLM_OUTPUT_TOKENS'];
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => { globalThis.fetch = noNetwork; resetCalibration(); for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
const review = { summary: '검토', facts: '사실', legalOpinion: '근거 부족', draftOpinion: '검토 초안', coreIssues: [], legalBasis: [], risks: [], recommendations: [], redlineDiffs: [], furtherChecks: [] };
const context = { meta: { primaryLawName: '민법' }, officialEvidence: {} };
const run = (provider, config = {}, documentText = '', query = '면책 검토') => generateLegalReview({ query, preset: 'contract_risk', documentText, workbenchContext: context, llmConfig: { provider, model: 'fixture-model', apiKey: 'fixture', ...config } });

test('큰 조항의 말미와 여러 후반 조항을 함께 회수하고 발췌 위치를 추적한다', () => {
  const doc = `제1조(일반) ${'배경 '.repeat(3000)}책임을 일체 부담하지 않는다. TAIL_A 다만 고의는 제외한다.\n제2조(보관) ${'자료 '.repeat(2500)}영구 보관한다. TAIL_B\n제3조(해지) 최고 없이 해지한다. TAIL_C`;
  const result = optimizeDocumentContext({ documentText: doc, query: '일반 검토', maxChars: 4500 });
  for (const marker of ['TAIL_A', 'TAIL_B', 'TAIL_C', '고의는 제외']) assert.ok(result.optimizedText.includes(marker), marker);
  assert.ok(result.optimizedText.length <= 4500);
  assert.ok(result.truncatedCount >= 2);
  for (const c of result.selectedChunks) for (const span of c.excerptSpans) assert.ok(c.excerpt.includes(c.content.slice(span.start, span.end)));
});

test('같은 거대 조항의 떨어진 위험 문구와 가지 번호를 보존한다', () => {
  const doc = `제15조의2(특례) 동의 없이 FIRST_RISK ${'배경 '.repeat(2000)}영구 보관 SECOND_RISK`;
  const result = optimizeDocumentContext({ documentText: doc, query: '일반', maxChars: 1200 });
  assert.equal(chunkLegalDocument(doc)[0].articleNo, '제15조의2');
  assert.ok(result.optimizedText.includes('FIRST_RISK'));
  assert.ok(result.optimizedText.includes('SECOND_RISK'));
  assert.equal(result.selectedChunks[0].excerptSpans.length, 2);
});

test('모델별 운영 예산을 선택하고 잘못된 설정을 거부한다', () => {
  process.env.LLM_MODEL_BUDGETS = JSON.stringify({ 'openai:small': { contextTokens: 12000, outputTokens: 1000 } });
  const budget = resolveBudget('openai', { model: 'small' });
  assert.equal(budget.contextTokens, 12000);
  assert.equal(budget.inputLimit, 10488);
  assert.equal(budget.exact, false);
  for (const config of [{ contextTokens: 1000, outputTokens: 1000 }, { contextTokens: -1 }, { outputTokens: 1.5 }]) assert.throws(() => resolveBudget('openai', config));
});

test('전체 요청을 예산에 맞추고 출력 예약과 제공자 사용량을 구분한다', async () => {
  const text = '제1조(내용) ' + '한글 배경 문장 '.repeat(10000) + '\n제2조(면책) 책임을 일체 부담하지 않는다. FINAL_RISK';
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body);
    return openAiStream(JSON.stringify(review), { usage: { prompt_tokens: 1234, completion_tokens: 300, total_tokens: 1534 } }); };
  const result = await run('openai', { contextTokens: 9000, outputTokens: 1000 }, text);
  assert.ok(body.messages[1].content.includes('FINAL_RISK'));
  assert.equal(body.max_tokens, 1000);
  assert.ok(estimatePromptTokens(body.messages[0].content, body.messages[1].content) + 1000 + 512 <= 9000);
  assert.equal(result.inputBudget.exact, false);
  assert.equal(result.tokenUsage.inputTokens, 1234);
  assert.equal(result.inputBudget.reduced, true);
  assert.ok(result.inputCoverage.truncatedChunks || result.inputCoverage.omittedChunks);
});

test('고정 지시문과 질의가 너무 크면 질의를 몰래 자르거나 API를 호출하지 않는다', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not call'); };
  const result = await run('openai', { contextTokens: 8000, outputTokens: 1000 }, '', '한글'.repeat(10000));
  assert.equal(called, false);
  assert.equal(result.reviewStatus, 'FAILED');
  assert.match(result.fallbackReason, /입력 예산/);
});

test('제공자별 실제 출력 제한과 사용량을 전달하고 누락값은 null로 남긴다', async () => {
  for (const provider of ['ollama', 'anthropic', 'gemini']) {
    let body;
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      body = JSON.parse(options.body);
      // 모든 제공자를 스트리밍으로 호출한다. 한 줄이 청크 경계에 걸쳐 쪼개져도 조립되어야 한다.
      return providerStream(provider, JSON.stringify(review), { inputTokens: 111, outputTokens: 222, reasoningTokens: 50 });
    };
    const result = await run(provider, { contextTokens: 32000, outputTokens: 900 });
    assert.equal(body.options?.num_predict ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens, 900);
    if (provider === 'ollama') {
      assert.equal(body.options.num_ctx, 32000);
      // stream:false로 되돌리면 생성이 끝나야 응답 헤더가 오고, Node fetch(undici)의
      // 300초 헤더 타임아웃에 걸려 'fetch failed'로 떨어진다. LLM_TIMEOUT은 무력해진다.
      assert.equal(body.stream, true, 'Ollama 호출은 스트리밍이어야 한다');
    }
    assert.equal(result.tokenUsage.inputTokens, 111);
    assert.equal(result.tokenUsage.outputTokens, 222);
  }
  assert.equal(readTokenUsage('openai', {}).inputTokens, null);
  assert.equal(readTokenUsage('openai', { usage: { prompt_tokens: 0 } }).inputTokens, 0);
});

test('출력이 잘려도 제공자의 사용량과 입력 제한을 보존한다', async () => {
  globalThis.fetch = async () => openAiStream('', { finishReason: 'length', usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  const result = await run('openai');
  assert.equal(result.reviewStatus, 'FAILED');
  assert.equal(result.tokenUsage.outputTokens, 500);
  assert.ok(result.inputBudget.inputLimit > 0);
});

test('위험 키워드도 질의어도 없는 조항 말미의 조건을 회수한다', () => {
  const filler = '일반 업무 배경과 처리 절차를 설명한다. '.repeat(600);
  const marked = optimizeDocumentContext({ documentText: `제1조(일반) ${filler}별도 부속 문서의 조건이 우선한다. UNMATCHED_TAIL`, query: '검토', maxChars: 1500 });
  assert.ok(marked.optimizedText.includes('UNMATCHED_TAIL'), '구조 표지 기반 회수');
  // 표지조차 없는 문장도 꼬리 구간 발췌로 덮는다. 앞부분만 잘라 보내지 않는다.
  const plain = optimizeDocumentContext({ documentText: `제1조(현황) ${filler}접수 창구는 본관에 둔다. PLAIN_TAIL`, query: '검토', maxChars: 1500 });
  assert.ok(plain.optimizedText.includes('PLAIN_TAIL'), '구조적 꼬리 발췌');
  assert.ok(plain.selectedChunks[0].excerptSpans.length >= 2);
  for (const span of plain.selectedChunks[0].excerptSpans) assert.ok(plain.selectedChunks[0].excerpt.includes(plain.selectedChunks[0].content.slice(span.start, span.end)));
});

test('모델 계열별 토큰 계수를 구분하고 미상 모델은 보수적으로 센다', () => {
  assert.equal(resolveTokenizerFamily('anthropic', 'claude-3-5-sonnet-latest'), 'claude');
  assert.equal(resolveTokenizerFamily('openai', 'gpt-4o-mini'), 'o200k');
  assert.equal(resolveTokenizerFamily('openai', 'gpt-4-turbo'), 'cl100k');
  assert.equal(resolveTokenizerFamily('openai', 'unknown-model'), 'default');
  process.env.LLM_MODEL_BUDGETS = JSON.stringify({ 'ollama:my-model': { family: 'o200k' } });
  assert.equal(resolveTokenizerFamily('ollama', 'my-model'), 'o200k');
  const korean = '개인정보를 제3자에게 제공한다. '.repeat(200);
  const claude = estimatePromptTokens('', korean, { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' });
  const legacy = estimatePromptTokens('', korean, { provider: 'openai', model: 'gpt-4-turbo' });
  const unknown = estimatePromptTokens('', korean);
  assert.ok(claude < legacy && legacy <= unknown, `${claude} < ${legacy} <= ${unknown}`);
});

test('제공자 사전 계수 API의 정확한 입력 토큰을 사용한다', async () => {
  let counted = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/count_tokens')) {
      counted = true;
      assert.equal(JSON.parse(options.body).model, 'fixture-model');
      return { ok: true, json: async () => ({ input_tokens: 4321 }) };
    }
    return anthropicStream(JSON.stringify(review), { inputTokens: 4400, outputTokens: 120 });
  };
  const result = await run('anthropic', { contextTokens: 32000, outputTokens: 900 });
  assert.equal(counted, true);
  assert.equal(result.inputBudget.exact, true);
  assert.equal(result.inputBudget.tokenCountSource, 'PROVIDER_COUNT_API');
  assert.equal(result.inputBudget.estimatedInputTokens, 4321);
  assert.equal(result.inputBudget.accuracy.reportedInputTokens, 4400);
  assert.equal(result.inputBudget.accuracy.errorPct, -1.8);
});

test('사전 계수 실패를 드러내고 추정으로 대체한다', async () => {
  globalThis.fetch = async url => {
    if (String(url).endsWith('/count_tokens')) return { ok: false, status: 429 };
    return anthropicStream(JSON.stringify(review), { inputTokens: 900, outputTokens: 10 });
  };
  const result = await run('anthropic', { contextTokens: 32000, outputTokens: 900 });
  assert.equal(result.inputBudget.exact, false);
  assert.match(result.inputBudget.tokenCountError, /429/);
  assert.equal(result.inputBudget.tokenizerFamily, 'claude');
});

test('실제 사용량으로 추정 오차를 보정하고 엉뚱한 값은 버린다', () => {
  const counter = createTokenCounter('openai', { model: 'calib-model' });
  const before = counter.estimate('지시문', '한글 본문 '.repeat(200));
  assert.equal(before.source, 'HEURISTIC');
  assert.equal(counter.observe(before, { inputTokens: 1 }).appliedToCalibration, false);
  const accuracy = counter.observe(before, { inputTokens: Math.round(before.raw * 0.5) });
  assert.equal(accuracy.appliedToCalibration, true);
  const after = counter.estimate('지시문', '한글 본문 '.repeat(200));
  assert.equal(after.source, 'CALIBRATED_HEURISTIC');
  assert.equal(after.calibrationSamples, 1);
  assert.ok(after.tokens < before.tokens, `${after.tokens} < ${before.tokens}`);
  // 보정은 다른 모델로 번지지 않는다.
  assert.equal(createTokenCounter('openai', { model: 'other-model' }).estimate('지시문', '한글 본문 '.repeat(200)).source, 'HEURISTIC');
});
