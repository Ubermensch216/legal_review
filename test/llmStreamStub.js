// test/llmStreamStub.js
// LLM 제공자 스트리밍 응답 스텁.
// 모든 제공자를 스트리밍으로 호출하므로(비스트리밍은 Node fetch의 300초 헤더
// 타임아웃에 걸린다) 테스트도 같은 계약으로 응답해야 한다.
// 바이트를 일부러 쪼개서 흘려, 한 줄이 청크 경계에 걸쳐도 조립되는지 함께 검증한다.

const toStream = (text) => {
  const bytes = new TextEncoder().encode(text);
  const cut = Math.max(1, Math.floor(bytes.length / 3));
  return (async function* () {
    yield bytes.slice(0, cut);
    yield bytes.slice(cut, cut * 2);
    yield bytes.slice(cut * 2);
  })();
};

const sse = (chunks) => ({
  ok: true,
  body: toStream(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n')
});

const ndjson = (chunks) => ({ ok: true, body: toStream(chunks.map(c => `${JSON.stringify(c)}\n`).join('')) });

export const openAiStream = (content, { finishReason = 'stop', usage } = {}) => sse([
  { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
  { choices: [{ delta: { content }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: finishReason }] },
  ...(usage ? [{ choices: [], usage }] : [])
]);

export const anthropicStream = (text, { stopReason = 'end_turn', inputTokens, outputTokens } = {}) => sse([
  { type: 'message_start', message: { usage: { input_tokens: inputTokens } } },
  { type: 'content_block_delta', delta: { text } },
  { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
  { type: 'message_stop' }
]);

export const geminiStream = (text, { finishReason = 'STOP', usageMetadata } = {}) => sse([
  { candidates: [{ content: { parts: [{ text }] }, finishReason }], ...(usageMetadata ? { usageMetadata } : {}) }
]);

export const ollamaStream = (content, { doneReason = 'stop', promptEvalCount, evalCount } = {}) => ndjson([
  { message: { content }, done: true, done_reason: doneReason, prompt_eval_count: promptEvalCount, eval_count: evalCount }
]);

/** 제공자 이름으로 알맞은 스트림을 고른다. */
export const providerStream = (provider, text, options = {}) => ({
  openai: () => openAiStream(text, { usage: { prompt_tokens: options.inputTokens, completion_tokens: options.outputTokens } }),
  anthropic: () => anthropicStream(text, options),
  gemini: () => geminiStream(text, { usageMetadata: { promptTokenCount: options.inputTokens, candidatesTokenCount: options.outputTokens, thoughtsTokenCount: options.reasoningTokens } }),
  ollama: () => ollamaStream(text, { promptEvalCount: options.inputTokens, evalCount: options.outputTokens })
}[provider]());
