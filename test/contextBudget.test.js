import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeDocumentContext } from '../server/parsers/contextOptimizer.js';
import { chunkLegalDocument } from '../server/parsers/legalDocChunker.js';
import { resolveBudget, readTokenUsage, estimatePromptTokens } from '../server/law/llmBudget.js';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';

const noNetwork = globalThis.fetch;
const keys = ['LLM_MODEL_BUDGETS', 'LLM_CONTEXT_TOKENS', 'LLM_OUTPUT_TOKENS'];
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => { globalThis.fetch = noNetwork; for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
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
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(review) } }], usage: { prompt_tokens: 1234, completion_tokens: 300, total_tokens: 1534 } }) }; };
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
      const text = JSON.stringify(review);
      const data = provider === 'ollama' ? { message: { content: text }, prompt_eval_count: 111, eval_count: 222 }
        : provider === 'anthropic' ? { content: [{ text }], usage: { input_tokens: 111, output_tokens: 222 } }
        : { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 222, thoughtsTokenCount: 50 } };
      return { ok: true, json: async () => data };
    };
    const result = await run(provider, { contextTokens: 32000, outputTokens: 900 });
    assert.equal(body.options?.num_predict ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens, 900);
    if (provider === 'ollama') assert.equal(body.options.num_ctx, 32000);
    assert.equal(result.tokenUsage.inputTokens, 111);
    assert.equal(result.tokenUsage.outputTokens, 222);
  }
  assert.equal(readTokenUsage('openai', {}).inputTokens, null);
  assert.equal(readTokenUsage('openai', { usage: { prompt_tokens: 0 } }).inputTokens, 0);
});

test('출력이 잘려도 제공자의 사용량과 입력 제한을 보존한다', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }) });
  const result = await run('openai');
  assert.equal(result.reviewStatus, 'FAILED');
  assert.equal(result.tokenUsage.outputTokens, 500);
  assert.ok(result.inputBudget.inputLimit > 0);
});
