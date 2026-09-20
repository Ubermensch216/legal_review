// A conservative preflight estimate, not a model tokenizer or measured usage.
export const estimatePromptTokens = (system, user) => Buffer.byteLength(system + '\n\n' + user, 'utf8') + 256;

export function resolveBudget(provider, config = {}) {
  const local = provider === 'ollama';
  const profiles = JSON.parse(process.env.LLM_MODEL_BUDGETS || '{}');
  const profileKey = `${provider}:${config.model || ''}`;
  const profile = Object.hasOwn(profiles, profileKey) ? profiles[profileKey] : {};
  const positive = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('LLM 예산은 양의 정수여야 합니다.');
    return n;
  };
  const contextTokens = positive(config.contextTokens ?? profile.contextTokens ?? process.env.LLM_CONTEXT_TOKENS, local ? (process.env.OLLAMA_NUM_CTX ?? 16384) : 32768);
  const outputTokens = positive(config.outputTokens ?? profile.outputTokens ?? process.env.LLM_OUTPUT_TOKENS, local ? (process.env.OLLAMA_NUM_PREDICT ?? 8192) : 3500);
  const safetyTokens = 512;
  if (outputTokens + safetyTokens >= contextTokens) throw new Error('출력 예약 토큰이 컨텍스트 예산을 초과합니다.');
  return { provider, model: config.model || null, contextTokens, outputTokens, safetyTokens, inputLimit: contextTokens - outputTokens - safetyTokens, estimator: 'UTF8_BYTES_PLUS_256', exact: false };
}

export function readTokenUsage(provider, data) {
  const pair = provider === 'ollama' ? [data.prompt_eval_count, data.eval_count]
    : provider === 'openai' ? [data.usage?.prompt_tokens, data.usage?.completion_tokens]
    : provider === 'anthropic' ? [data.usage?.input_tokens, data.usage?.output_tokens]
    : [data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount];
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  return { source: 'PROVIDER_RESPONSE', inputTokens: count(pair[0]), outputTokens: count(pair[1]),
    totalTokens: count(data.usage?.total_tokens ?? data.usageMetadata?.totalTokenCount),
    reasoningTokens: count(data.usage?.completion_tokens_details?.reasoning_tokens ?? data.usageMetadata?.thoughtsTokenCount),
    cacheReadTokens: count(data.usage?.cache_read_input_tokens), cacheCreationTokens: count(data.usage?.cache_creation_input_tokens) };
}
