// server/reasoning/llmGateway.js - LLM 제공자 호출 단일 창구와 호출 원장
//
// 검토 파이프라인을 여러 단계로 나누면 호출이 늘어난다. 호출마다 시간·토큰·캐시 적중을
// 재지 않으면 단계 분리가 효율을 높였는지 판단할 수 없다. 모든 호출을 여기로 모아
// 같은 방식으로 기록한다(docs/reasoning-pipeline-plan-2026-09-23.md Phase 0).
//
// 기본 추론 경로는 로컬 Ollama다. 클라우드 어댑터는 연결 가능성을 위해 남겨 둔 것이며,
// 사용자가 제공자를 명시적으로 선택했을 때만 호출된다.
import { Agent } from 'undici';
import { ENV } from '../env.js';
import { maskLawSecrets } from '../law/lawErrors.js';
import { readTokenUsage } from '../law/llmBudget.js';

// ── 전송 계층 공통 ────────────────────────────────────────────
// Node의 fetch(undici)는 응답 '헤더'를 300초 안에 받지 못하면 요청을 끊고
// 원인을 알 수 없는 TypeError('fetch failed', UND_ERR_HEADERS_TIMEOUT)만 남긴다.
// 스트리밍으로 호출해도 Ollama는 프롬프트 처리(prefill)가 끝나야 헤더를 보낸다.
// CPU에서 2만 토큰을 넘는 프롬프트는 prefill만 300초를 넘겨(실측 23k 토큰 250초, 더 큰 입력은 초과)
// 검토가 규칙 기반 폴백으로 떨어졌다(docs/audit/pipeline-baseline-2026-09-23.json 사례 03).
// 그래서 LLM 호출에는 헤더·본문 타임아웃을 LLM_TIMEOUT에 맞춘 전용 dispatcher를 쓴다.
// 전체 시간 상한은 아래 createCallGuard의 AbortController가 따로 지킨다.
const dispatchers = new Map();
function llmDispatcher(timeoutMs) {
  if (!dispatchers.has(timeoutMs)) dispatchers.set(timeoutMs, new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }));
  return dispatchers.get(timeoutMs);
}

/**
 * 호출 타임아웃과 전송 오류 해석을 한곳에서 처리한다.
 * @param {string} label 제공자 표시명
 * @param {string} endpoint 오류 메시지에 남길 엔드포인트 (시크릿은 마스킹한다)
 * @param {number} timeoutMs
 * @param {string} [timeoutHint] 타임아웃 시 덧붙일 해결 안내
 */
function createCallGuard(label, endpoint, timeoutMs, timeoutHint = 'LLM_TIMEOUT 환경변수를 늘리거나 출력 예산을 줄이십시오.') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const safeEndpoint = maskLawSecrets(String(endpoint || ''));
  return {
    signal: controller.signal,
    dispatcher: llmDispatcher(timeoutMs),
    done: () => clearTimeout(timer),
    /** 전송 계층 오류에만 원인 코드를 붙인다. 그 외 오류는 그대로 올린다. */
    describe(err) {
      if (controller.signal.aborted) {
        return new Error(`${label} 응답이 ${Math.round(timeoutMs / 1000)}초 내에 완료되지 않았습니다. ${timeoutHint}`);
      }
      if (err instanceof TypeError || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        const cause = err?.cause?.code || err?.cause?.message;
        return new Error(`${label} 호출 실패 (${safeEndpoint}): ${err.message}${cause ? ` [${cause}]` : ''}`);
      }
      return err;
    }
  };
}

/** 줄 단위 스트림을 순서대로 넘긴다. 한 줄이 청크 경계에 걸쳐 쪼개져도 조립한다. */
async function* readLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) yield buffer;
}

/** SSE 스트림에서 data: 페이로드만 뽑는다. [DONE] 표식에서 끝낸다. */
async function* readSseData(body) {
  for await (const line of readLines(body)) {
    const text = line.trim();
    if (!text.startsWith('data:')) continue;
    const payload = text.slice(5).trim();
    if (payload === '[DONE]') return;
    if (payload) yield payload;
  }
}

/**
 * SSE 청크를 순회하며 본문과 사용량을 모은다.
 * @param {object} args
 * @param {ReadableStream} args.body
 * @param {ReturnType<createCallGuard>} args.guard
 * @param {(chunk: object, state: {content: string, usage: object, truncated: boolean}) => void} args.onChunk
 * @param {((chars: number) => void)} [args.onToken] 누적 생성 글자 수 통지 (진행 표시용, 실패해도 무시)
 */
async function collectSseStream({ body, guard, onChunk, onToken }) {
  const state = { content: '', usage: {}, truncated: false };
  try {
    for await (const payload of readSseData(body)) {
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; } // 하트비트 등 JSON이 아닌 줄은 건너뛴다
      if (chunk.error) throw new Error(`제공자 오류: ${chunk.error.message || JSON.stringify(chunk.error)}`);
      onChunk(chunk, state);
      if (onToken) { try { onToken(state.content.length); } catch { /* 진행 표시 실패는 생성을 막지 않는다 */ } }
    }
  } catch (err) {
    throw guard.describe(err);
  } finally {
    guard.done();
  }
  return state;
}

/** Ollama가 보고한 나노초 값을 밀리초로 바꾼다. 없으면 null이다(0으로 채우지 않는다). */
const nsToMs = value => Number.isFinite(value) && value >= 0 ? Math.round(value / 1e6) : null;

/**
 * 설치된 모델 확인. 한 검토 안의 여러 호출이 같은 확인을 반복하지 않도록
 * `config.session`이 있으면 성공 결과를 그 안에 기억한다. 실패는 기억하지 않는다.
 */
async function ensureOllamaModel(url, model, session) {
  const key = `${url}|${model}`;
  if (session?.verifiedModels?.has(key)) return;
  // 짧은 헬스체크로 "Ollama 미기동" 상황만 빠르게 걸러낸다.
  // 생성 자체는 수 분이 걸릴 수 있으므로, 미기동 감지용 타임아웃을 생성 타임아웃으로
  // 그대로 쓰면 정상 동작 중인 모델까지 매번 중단되어 룰베이스로 떨어진다.
  const probeTimeoutMs = parseInt(process.env.LLM_PROBE_TIMEOUT || '2000', 10);
  let installedModels = [];
  try {
    const probe = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(probeTimeoutMs) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    ({ models: installedModels = [] } = await probe.json());
  } catch (err) {
    throw new Error(`Ollama 서버에 연결할 수 없습니다 (${url}): ${err.message}`);
  }

  if (installedModels.length > 0 && !installedModels.some(m => m.name === model || m.model === model)) {
    throw new Error(
      `Ollama에 모델 '${model}'이(가) 설치되어 있지 않습니다. ` +
      `설치된 모델: ${installedModels.map(m => m.name).join(', ')} (해결: ollama pull ${model})`
    );
  }
  session?.verifiedModels?.add(key);
}

/**
 * Ollama API 호출
 * @param {object} config
 * @param {object} config.budget resolveBudget 결과
 * @param {object} [config.schema] JSON Schema. 주면 `format`에 실어 출력 구조를 강제한다.
 * @param {boolean} [config.think] 사고 모드. 지정하지 않으면 모델 기본값을 따른다.
 *   추출·분류 작업은 false가 출력 토큰을 크게 줄인다(실측 864 → 75토큰).
 * @param {object} [config.session] createLlmSession 결과. 모델 확인을 한 번만 한다.
 */
export async function callOllama(systemPrompt, userPrompt, config = {}) {
  const url = config.url || ENV.OLLAMA_URL;
  const model = config.model || ENV.OLLAMA_MODEL;

  await ensureOllamaModel(url, model, config.session);

  // 실제 생성 호출. 로컬 모델은 프롬프트 처리 + 수천 토큰 생성에 수 분이 걸린다.
  //   비스트리밍이면 300초 헤더 타임아웃에 걸린다(위 '전송 계층 공통' 주석 참고).
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '600000', 10);
  const guard = createCallGuard('Ollama', url, timeoutMs, '더 작은 모델을 쓰거나 LLM_TIMEOUT 환경변수를 늘리십시오.');

  let response;
  try {
    response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: guard.signal, dispatcher: guard.dispatcher,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: true,
        format: config.schema || 'json',
        ...(typeof config.think === 'boolean' ? { think: config.think } : {}),
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m', // 매 호출마다 모델을 다시 적재하지 않도록 유지
        options: {
          temperature: 0.1,
          // num_ctx는 프롬프트와 생성 토큰이 함께 쓰는 예산이다. Ollama 기본값(4096)은
          // 법령·판례가 포함된 긴 프롬프트에서 출력 여유를 거의 남기지 않아 응답이 잘린다.
          // 한 검토 안에서는 같은 값을 유지해야 모델 재적재와 접두부 캐시 무효화를 피한다.
          num_ctx: config.budget.contextTokens,
          num_predict: config.budget.outputTokens
        }
      })
    });
  } catch (err) {
    guard.done();
    throw guard.describe(err);
  }

  if (!response.ok) {
    guard.done();
    throw new Error(`Ollama Error HTTP ${response.status}`);
  }

  // Ollama는 SSE가 아니라 NDJSON(한 줄에 JSON 한 개)으로 흘려보낸다.
  let content = '';
  let thinkingChars = 0;
  let last = {};
  try {
    for await (const line of readLines(response.body)) {
      const text = line.trim();
      if (!text) continue;
      const part = JSON.parse(text);
      if (part.error) throw new Error(`Ollama Error: ${part.error}`);
      content += part.message?.content || '';
      thinkingChars += (part.message?.thinking || '').length;
      last = part;
      if (config.onToken) { try { config.onToken(content.length); } catch { /* 진행 표시 실패는 생성을 막지 않는다 */ } }
    }
  } catch (err) {
    throw guard.describe(err);
  } finally {
    guard.done();
  }

  const timing = { loadMs: nsToMs(last.load_duration), prefillMs: nsToMs(last.prompt_eval_duration),
    decodeMs: nsToMs(last.eval_duration), thinkingChars };
  // num_predict 한도에 걸려 응답이 잘리면 JSON 파싱이 실패하고 조용히 룰베이스로 대체된다.
  // 원인을 알 수 있도록 절단 사실을 명시적으로 남긴다.
  if (last.done_reason === 'length') {
    throw Object.assign(new Error('LLM 출력이 토큰 한도로 잘렸습니다.'), { tokenUsage: readTokenUsage('ollama', last), timing, truncated: true });
  }

  return { content, tokenUsage: readTokenUsage('ollama', last), timing };
}

/**
 * OpenAI API 호출 (SSE 스트리밍)
 */
export async function callOpenAi(systemPrompt, userPrompt, config = {}) {
  const apiKey = config.apiKey || ENV.OPENAI_API_KEY;
  const model = config.model || ENV.OPENAI_MODEL;
  const endpoint = 'https://api.openai.com/v1/chat/completions';
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '60000', 10);
  const guard = createCallGuard('OpenAI', endpoint, timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      signal: guard.signal, dispatcher: guard.dispatcher,
      body: JSON.stringify({
        model,
        response_format: config.schema
          ? { type: 'json_schema', json_schema: { name: config.schemaName || 'result', schema: config.schema } }
          : { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: config.budget.outputTokens,
        stream: true,
        // 스트리밍은 기본적으로 usage를 주지 않는다. 마지막 청크에 실어달라고 요청한다.
        stream_options: { include_usage: true }
      })
    });
  } catch (err) { guard.done(); throw guard.describe(err); }
  if (!response.ok) { guard.done(); throw new Error(`OpenAI Error HTTP ${response.status}`); }

  const state = await collectSseStream({ body: response.body, guard, onChunk: (chunk, s) => {
    const choice = chunk.choices?.[0];
    s.content += choice?.delta?.content || '';
    if (choice?.finish_reason === 'length') s.truncated = true;
    if (chunk.usage) s.usage = chunk.usage;
  }, onToken: config.onToken });

  const usage = readTokenUsage('openai', { usage: state.usage });
  if (state.truncated) throw Object.assign(new Error('LLM 출력이 토큰 한도로 잘렸습니다.'), { tokenUsage: usage, truncated: true });
  return { content: state.content, tokenUsage: usage };
}

/**
 * Anthropic API 호출 (SSE 스트리밍)
 */
export async function callAnthropic(systemPrompt, userPrompt, config = {}) {
  const apiKey = config.apiKey || ENV.ANTHROPIC_API_KEY;
  const model = config.model || ENV.ANTHROPIC_MODEL;
  const endpoint = 'https://api.anthropic.com/v1/messages';
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '60000', 10);
  const guard = createCallGuard('Anthropic', endpoint, timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: guard.signal, dispatcher: guard.dispatcher,
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: config.budget.outputTokens,
        temperature: 0.1,
        stream: true
      })
    });
  } catch (err) { guard.done(); throw guard.describe(err); }
  if (!response.ok) { guard.done(); throw new Error(`Anthropic Error HTTP ${response.status}`); }

  // 입력 토큰은 message_start에, 출력 토큰과 중단 사유는 message_delta에 실려 온다.
  const state = await collectSseStream({ body: response.body, guard, onChunk: (chunk, s) => {
    if (chunk.type === 'message_start' && chunk.message?.usage) s.usage = { ...s.usage, ...chunk.message.usage };
    if (chunk.type === 'content_block_delta') s.content += chunk.delta?.text || '';
    if (chunk.type === 'message_delta') {
      if (chunk.usage) s.usage = { ...s.usage, ...chunk.usage };
      if (chunk.delta?.stop_reason === 'max_tokens') s.truncated = true;
    }
  }, onToken: config.onToken });

  const usage = readTokenUsage('anthropic', { usage: state.usage });
  if (state.truncated) throw Object.assign(new Error('LLM 출력이 토큰 한도로 잘렸습니다.'), { tokenUsage: usage, truncated: true });
  return { content: state.content, tokenUsage: usage };
}

/**
 * Google Gemini API 호출 (SSE 스트리밍)
 */
export async function callGemini(systemPrompt, userPrompt, config = {}) {
  const apiKey = config.apiKey || ENV.GEMINI_API_KEY;
  const model = config.model || ENV.GEMINI_MODEL;
  // 키는 쿼리스트링이 아니라 헤더로 보낸다. URL에 실으면 오류 메시지와 로그에 그대로 남는다.
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '60000', 10);
  const guard = createCallGuard('Gemini', endpoint, timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: guard.signal, dispatcher: guard.dispatcher,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: {
          // 스키마 강제는 걸지 않는다. 출력 구조는 호출부의 코드 검증이 확인한다.
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: config.budget.outputTokens
        }
      })
    });
  } catch (err) { guard.done(); throw guard.describe(err); }
  if (!response.ok) { guard.done(); throw new Error(`Gemini Error HTTP ${response.status}`); }

  const state = await collectSseStream({ body: response.body, guard, onChunk: (chunk, s) => {
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts || []) s.content += part.text || '';
    if (candidate?.finishReason === 'MAX_TOKENS') s.truncated = true;
    if (chunk.usageMetadata) s.usage = chunk.usageMetadata;
  }, onToken: config.onToken });

  const usage = readTokenUsage('gemini', { usageMetadata: state.usage });
  if (state.truncated) throw Object.assign(new Error('LLM 출력이 토큰 한도로 잘렸습니다.'), { tokenUsage: usage, truncated: true });
  return { content: state.content, tokenUsage: usage };
}

// 제공자별 필요한 환경변수. 설정 누락 시 무엇을 채워야 하는지 그대로 알려준다.
export const PROVIDER_KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

/**
 * LLM 호출이 불가능한 이유를 구체적으로 설명한다.
 * "제공자 또는 API 키 설정을 확인하십시오"만으로는 무엇이 빠졌는지 알 수 없어,
 * 폴백 검토가 나가는데도 원인을 못 찾는 일이 반복됐다.
 */
export function describeProviderMisconfiguration(provider, llmConfig = {}) {
  const known = ['openai', 'anthropic', 'gemini', 'ollama', 'rule_based', 'local_rule'];
  if (!known.includes(provider)) {
    return `알 수 없는 LLM 제공자 '${provider}'입니다. LLM_PROVIDER를 ${known.slice(0, 4).join(', ')} 중 하나로 설정하십시오.`;
  }
  const envName = PROVIDER_KEY_ENV[provider];
  if (envName && !(llmConfig.apiKey || ENV[envName])) {
    return `${provider} 제공자를 선택했지만 ${envName}가 비어 있습니다. .env에 ${envName}를 설정하거나 LLM_PROVIDER를 ollama로 바꾸십시오.`;
  }
  return `${provider} 제공자를 호출할 수 없습니다. 설정을 확인하십시오.`;
}

const ADAPTERS = { openai: callOpenAi, anthropic: callAnthropic, gemini: callGemini, ollama: callOllama };

/** 제공자 이름으로 어댑터를 고른다. 키가 없는 클라우드 제공자는 호출하지 않고 이유를 알린다. */
export function callProvider(provider, systemPrompt, userPrompt, config = {}) {
  const envName = PROVIDER_KEY_ENV[provider];
  const adapter = ADAPTERS[provider];
  if (!adapter || (envName && !(config.apiKey || ENV[envName]))) {
    throw new Error(describeProviderMisconfiguration(provider, config));
  }
  return adapter(systemPrompt, userPrompt, config);
}

// ── 호출 원장 ─────────────────────────────────────────────────

/**
 * 접두부 KV 캐시가 적중했을 가능성. Ollama는 적중 여부를 직접 알려주지 않으므로
 * 토큰당 입력 처리 시간으로 추정한다. 실측: 5.2k 토큰이 캐시 없이 14.5~39초(2.8~7.4ms/토큰),
 * 같은 접두부 재호출은 0.3초(0.06ms/토큰). 짧은 입력은 판단하지 않는다.
 */
export function prefixCacheLikely({ inputTokens, prefillMs }) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 500 || !Number.isFinite(prefillMs)) return null;
  return prefillMs / inputTokens < 0.5;
}

/**
 * 한 검토 실행의 호출 기록. 결과에 그대로 실어 단계별 비용을 비교한다.
 * 프롬프트·응답 원문은 담지 않는다(검토 이력에 사건 정보가 두 벌로 남지 않게).
 */
export function createRunLedger() {
  const calls = [];
  return {
    calls,
    record(entry) { calls.push(entry); return entry; },
    summary() {
      const sum = key => calls.reduce((n, c) => n + (Number.isFinite(c[key]) ? c[key] : 0), 0);
      const known = key => calls.some(c => Number.isFinite(c[key]));
      return {
        calls: calls.length,
        failed: calls.filter(c => !c.ok).length,
        inputTokens: known('inputTokens') ? sum('inputTokens') : null,
        outputTokens: known('outputTokens') ? sum('outputTokens') : null,
        prefillMs: known('prefillMs') ? sum('prefillMs') : null,
        decodeMs: known('decodeMs') ? sum('decodeMs') : null,
        wallMs: sum('wallMs'),
        prefixCacheHits: calls.filter(c => c.prefixCacheLikely === true).length
      };
    },
    toJSON() { return { calls, totals: this.summary() }; }
  };
}

/** 한 검토 안에서 공유하는 호출 상태. 모델 확인 결과를 기억한다. */
export function createLlmSession({ ledger = createRunLedger() } = {}) {
  return { ledger, verifiedModels: new Set() };
}

/**
 * 제공자 호출 + 원장 기록. 성공·실패 모두 기록하고, 실패는 원래 예외를 그대로 올린다.
 * @param {object} args
 * @param {string} args.stage 원장에 남길 단계 이름 (예: 'review', 'stage1')
 * @param {string} args.provider
 * @param {string} args.system
 * @param {string} args.user
 * @param {object} args.config 어댑터 설정(budget, model, apiKey, schema, think, onToken)
 * @param {object} [args.session] createLlmSession 결과
 */
export async function complete({ stage, provider, system, user, config, session }) {
  const started = Date.now();
  const entry = { stage, provider, model: config.model || null,
    think: typeof config.think === 'boolean' ? config.think : null, schema: Boolean(config.schema) };
  try {
    const result = await callProvider(provider, system, user, { ...config, session });
    session?.ledger.record(describeCall(entry, result, started, true));
    return result;
  } catch (err) {
    session?.ledger.record({ ...describeCall(entry, err, started, false), error: maskLawSecrets(err.message || '원인 미상').slice(0, 200) });
    throw err;
  }
}

function describeCall(entry, outcome, started, ok) {
  const usage = outcome?.tokenUsage || {};
  const timing = outcome?.timing || {};
  const measured = { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
    prefillMs: timing.prefillMs ?? null, decodeMs: timing.decodeMs ?? null, loadMs: timing.loadMs ?? null,
    thinkingChars: timing.thinkingChars ?? null };
  return { ...entry, ok, truncated: Boolean(outcome?.truncated), ...measured,
    outputChars: typeof outcome?.content === 'string' ? outcome.content.length : null,
    wallMs: Date.now() - started, prefixCacheLikely: prefixCacheLikely(measured) };
}
