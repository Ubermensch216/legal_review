// 입력 토큰 계수. 우선순위는 (1) 외부 토크나이저 플러그인, (2) 제공자 사전 계수 API,
// (3) 관측값으로 보정한 문자군 휴리스틱이다. (1)(2)만 정확한 값이며 나머지는 추정이다.

/**
 * 문자군별 토큰/문자 계수. 측정값이 아니라 예산 편성을 위한 사전값이며,
 * 제공자가 돌려준 실제 입력 토큰으로 런타임에 보정한다(recordObservation).
 * `default`는 미상 모델용 보수값이므로 어떤 계열보다 작아서는 안 된다.
 */
const FAMILIES = {
  claude: { hangul: 1.2, cjk: 1.0, latin: 0.28, digit: 0.45, space: 0.15, other: 0.55 },
  o200k: { hangul: 1.3, cjk: 1.1, latin: 0.27, digit: 0.45, space: 0.15, other: 0.55 },
  cl100k: { hangul: 2.4, cjk: 1.6, latin: 0.27, digit: 0.5, space: 0.15, other: 0.7 },
  gemini: { hangul: 1.2, cjk: 1.0, latin: 0.27, digit: 0.45, space: 0.15, other: 0.55 },
  local: { hangul: 1.9, cjk: 1.4, latin: 0.3, digit: 0.5, space: 0.18, other: 0.7 },
  default: { hangul: 2.6, cjk: 1.8, latin: 0.4, digit: 0.6, space: 0.25, other: 0.9 }
};

/** 채팅 요청의 역할·구분자 등 본문 외 고정 비용. */
const MESSAGE_OVERHEAD = 48;
const SAFETY_TOKENS = 512;

const readProfiles = () => {
  try { return JSON.parse(process.env.LLM_MODEL_BUDGETS || '{}'); }
  catch { throw new Error('LLM_MODEL_BUDGETS 값이 올바른 JSON이 아닙니다.'); }
};

const profileFor = (provider, model) => {
  const profiles = readProfiles();
  const key = `${provider}:${model || ''}`;
  return Object.hasOwn(profiles, key) ? profiles[key] : {};
};

/** 제공자와 모델명으로 토크나이저 계열을 고른다. 판별하지 못하면 보수값을 쓴다. */
export function resolveTokenizerFamily(provider, model = '') {
  const profile = profileFor(provider, model);
  if (profile.family && FAMILIES[profile.family]) return profile.family;
  const name = String(model || '').toLowerCase();
  if (provider === 'anthropic') return 'claude';
  if (provider === 'gemini') return 'gemini';
  if (provider === 'openai') {
    if (/gpt-4o|gpt-4\.1|gpt-5|^o[1345](-|$)|omni/.test(name)) return 'o200k';
    if (/gpt-4|gpt-3\.5|davinci|turbo/.test(name)) return 'cl100k';
    return 'default';
  }
  if (provider === 'ollama' && name) return 'local';
  return 'default';
}

const coefficientsFor = (provider, model) => {
  const family = resolveTokenizerFamily(provider, model);
  const override = profileFor(provider, model).tokensPerChar;
  return { family, coefficients: { ...FAMILIES[family], ...(override && typeof override === 'object' ? override : {}) } };
};

const classOf = code => {
  if (code === 32 || code === 9 || code === 10 || code === 13) return 'space';
  if (code >= 48 && code <= 57) return 'digit';
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return 'latin';
  if (code >= 0xac00 && code <= 0xd7a3) return 'hangul';
  if ((code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f)) return 'hangul';
  if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3040 && code <= 0x30ff)) return 'cjk';
  return 'other';
};

/** 문자군별 문자 수. 한글을 영문과 같은 비율로 세지 않기 위한 분류다. */
export function countScriptClasses(text) {
  const counts = { hangul: 0, cjk: 0, latin: 0, digit: 0, space: 0, other: 0 };
  const value = String(text || '');
  for (let i = 0; i < value.length; i++) counts[classOf(value.charCodeAt(i))]++;
  return counts;
}

const rawEstimate = (text, coefficients) => {
  const counts = countScriptClasses(text);
  let total = MESSAGE_OVERHEAD;
  for (const [key, n] of Object.entries(counts)) total += n * coefficients[key];
  return total;
};

const margin = () => {
  const value = Number(process.env.LLM_ESTIMATE_MARGIN ?? 0.15);
  return Number.isFinite(value) && value >= 0 ? value : 0.15;
};

// provider:model -> 관측 기반 보정 계수. 프로세스 수명 동안만 유지한다.
const observations = new Map();

/** 테스트와 운영 재설정을 위해 보정 상태를 비운다. */
export function resetCalibration() { observations.clear(); }

/** 보정 계수. 표본이 적을 때 과소 추정하지 않도록 최대 관측치를 함께 고려한다. */
export function getCalibration(provider, model) {
  const record = observations.get(`${provider}:${model || ''}`);
  if (!record) return { ratio: 1, samples: 0, mean: null, peak: null };
  return { ratio: Math.max(record.mean, record.peak * 0.9), samples: record.samples, mean: record.mean, peak: record.peak };
}

/**
 * 제공자가 보고한 실제 입력 토큰으로 휴리스틱을 보정한다.
 * 프롬프트와 무관해 보이는 값(0.15배 미만, 6배 초과)은 다른 요청의 사용량일 수 있어 버린다.
 */
export function recordObservation(provider, model, rawTokens, actualTokens) {
  if (!Number.isFinite(rawTokens) || rawTokens <= 0 || !Number.isSafeInteger(actualTokens) || actualTokens <= 0) return null;
  const ratio = actualTokens / rawTokens;
  if (ratio < 0.15 || ratio > 6) return null;
  const key = `${provider}:${model || ''}`;
  const previous = observations.get(key);
  const mean = previous ? previous.mean * 0.6 + ratio * 0.4 : ratio;
  observations.set(key, { samples: (previous?.samples || 0) + 1, mean, peak: Math.max(previous?.peak || 0, ratio) });
  return ratio;
}

/**
 * 보수적 사전 추정이며 모델 토크나이저의 정확한 계수가 아니다.
 * 제공자·모델을 넘기면 해당 계열 계수와 관측 보정을 함께 적용한다.
 */
export const estimatePromptTokens = (system, user, { provider, model } = {}) =>
  Math.ceil(rawEstimate(`${system}\n\n${user}`, coefficientsFor(provider, model).coefficients)
    * getCalibration(provider, model).ratio * (1 + margin()));

export function resolveBudget(provider, config = {}) {
  const local = provider === 'ollama';
  const profile = profileFor(provider, config.model);
  const positive = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('LLM 예산은 양의 정수여야 합니다.');
    return n;
  };
  const contextTokens = positive(config.contextTokens ?? profile.contextTokens ?? process.env.LLM_CONTEXT_TOKENS, local ? (process.env.OLLAMA_NUM_CTX ?? 16384) : 32768);
  const outputTokens = positive(config.outputTokens ?? profile.outputTokens ?? process.env.LLM_OUTPUT_TOKENS, local ? (process.env.OLLAMA_NUM_PREDICT ?? 8192) : 3500);
  if (outputTokens + SAFETY_TOKENS >= contextTokens) throw new Error('출력 예약 토큰이 컨텍스트 예산을 초과합니다.');
  // exact:false는 이 예산값이 운영자 설정일 뿐 모델이 보장한 한도가 아니라는 표시다.
  // 실제 입력 토큰을 정확히 셌는지는 호출 시점의 계수 결과(tokenCount.exact)가 가른다.
  return { provider, model: config.model || null, contextTokens, outputTokens, safetyTokens: SAFETY_TOKENS,
    inputLimit: contextTokens - outputTokens - SAFETY_TOKENS, tokenizerFamily: resolveTokenizerFamily(provider, config.model),
    estimator: 'SCRIPT_AWARE_HEURISTIC', exact: false };
}

const countTimeout = () => parseInt(process.env.LLM_COUNT_TIMEOUT || '10000', 10);

/** 외부 토크나이저 플러그인. countTokens(text, { provider, model }) => number 를 내보내야 한다. */
async function pluginCount(text, provider, model) {
  const spec = process.env.LLM_TOKENIZER_MODULE;
  if (!spec) return null;
  const module = await import(spec);
  const fn = module.countTokens || module.default?.countTokens || module.default;
  const tokens = typeof fn === 'function' ? await fn(text, { provider, model }) : null;
  return Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null;
}

/** 제공자의 사전 계수 API. 생성 과금 없이 해당 모델의 실제 입력 토큰을 돌려준다. */
async function providerCount(provider, { model, system, user, apiKey }) {
  const signal = AbortSignal.timeout(countTimeout());
  if (provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, system, messages: [{ role: 'user', content: user }] })
    });
    if (!response.ok) throw new Error(`count_tokens HTTP ${response.status}`);
    const data = await response.json();
    return Number.isSafeInteger(data.input_tokens) ? data.input_tokens : null;
  }
  if (provider === 'gemini') {
    // 생성 호출과 같은 형태로 세야 값이 일치한다(시스템 지시문을 본문에 합쳐 보낸다).
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${apiKey}`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }] })
    });
    if (!response.ok) throw new Error(`countTokens HTTP ${response.status}`);
    const data = await response.json();
    return Number.isSafeInteger(data.totalTokens) ? data.totalTokens : null;
  }
  return null; // OpenAI·Ollama는 사전 계수 엔드포인트가 없다.
}

/**
 * 프롬프트 토큰 계수기. estimate는 동기 추정, measure는 가능한 경우 정확한 계수를 시도한다.
 * 정확한 계수에 실패해도 예외를 올리지 않고 추정값으로 되돌아간다(사유는 countError에 남긴다).
 */
export function createTokenCounter(provider, { model, apiKey } = {}) {
  const { family, coefficients } = coefficientsFor(provider, model);
  const exactEnabled = (process.env.LLM_EXACT_TOKEN_COUNT || 'true') !== 'false';
  let countError = null;
  const estimate = (system, user) => {
    const raw = rawEstimate(`${system}\n\n${user}`, coefficients);
    const calibration = getCalibration(provider, model);
    return { tokens: Math.ceil(raw * calibration.ratio * (1 + margin())), raw, exact: false,
      source: calibration.samples ? 'CALIBRATED_HEURISTIC' : 'HEURISTIC',
      tokenizerFamily: family, calibrationSamples: calibration.samples, countError };
  };
  return {
    tokenizerFamily: family,
    estimate,
    /** 정확한 계수를 시도하고 실패하면 추정으로 대체한다. */
    async measure(system, user) {
      const fallback = estimate(system, user);
      if (!exactEnabled) return fallback;
      for (const [source, run] of [['TOKENIZER_PLUGIN', () => pluginCount(`${system}\n\n${user}`, provider, model)],
        ['PROVIDER_COUNT_API', () => apiKey ? providerCount(provider, { model, system, user, apiKey }) : null]]) {
        try {
          const tokens = await run();
          if (tokens === null) continue;
          // 정확한 값이 나왔으므로 같은 프롬프트의 휴리스틱 오차를 즉시 보정에 반영한다.
          recordObservation(provider, model, fallback.raw, tokens);
          return { tokens, raw: fallback.raw, exact: true, source, tokenizerFamily: family, countError: null };
        } catch (err) { countError = `${source}: ${err.message}`; }
      }
      return { ...estimate(system, user), countError };
    },
    /** 호출 뒤 제공자가 보고한 입력 토큰으로 추정 오차를 측정하고 보정에 반영한다. */
    observe(measured, usage) {
      const actual = usage?.inputTokens;
      if (!measured || !Number.isSafeInteger(actual) || actual <= 0) return null;
      const accepted = recordObservation(provider, model, measured.raw, actual);
      return { reportedInputTokens: actual, countedInputTokens: measured.tokens, exact: measured.exact,
        ratio: Number((actual / measured.tokens).toFixed(3)),
        errorPct: Number((((measured.tokens - actual) / actual) * 100).toFixed(1)),
        appliedToCalibration: accepted !== null };
    }
  };
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
