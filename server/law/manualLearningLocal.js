import { ENV } from '../env.js';
import { createTokenCounter, recordObservation, resolveBudget } from './llmBudget.js';

export function localLearningEndpoint() {
  const url = new URL(ENV.OLLAMA_URL);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) {
    throw Object.assign(new Error('수동 학습은 이 PC의 Ollama만 사용합니다. OLLAMA_URL을 localhost 또는 127.0.0.1로 설정하십시오.'), { statusCode: 503 });
  }
  // Do not allow redirects to a remote model endpoint.
  return new URL('/api/chat', url).href;
}

// 학습 작업의 산출물은 짧은 JSON 하나다. 검토 본문용 출력 예산(기본 8,192 토큰)을 그대로
// 예약하면 그만큼 입력이 줄어, 정작 외부 답변이 들어갈 자리가 남지 않는다.
// 운영자가 더 작은 값을 지정했다면 그 설정을 넘어서지 않는다.
const TASK_OUTPUT_TOKENS = Object.freeze({ analysis: 3072, card: 5120 });

export function learningBudget(task) {
  const operator = resolveBudget('ollama', { model: ENV.OLLAMA_MODEL });
  const wanted = TASK_OUTPUT_TOKENS[task];
  return wanted
    ? resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, outputTokens: Math.min(operator.outputTokens, wanted) })
    : operator;
}

/**
 * 입력이 로컬 AI 예산에 들어가는지 미리 잰다.
 * 초과분을 문자 수로 함께 돌려주어야 사용자가 무엇을 얼마나 줄일지 알 수 있다.
 */
export function learningInputRoom(system, user, task) {
  const budget = learningBudget(task);
  // Learning must not invoke a remote token-count API or a user-provided tokenizer module.
  const count = createTokenCounter('ollama', { model: ENV.OLLAMA_MODEL }).estimate(system, user);
  const overTokens = count.tokens - budget.inputLimit;
  const perChar = count.tokens / Math.max(1, String(system).length + String(user).length);
  return { limit: budget.inputLimit, tokens: count.tokens, raw: count.raw, overTokens,
    overChars: overTokens > 0 ? Math.ceil(overTokens / perChar) : 0 };
}

const ko = n => n.toLocaleString('ko-KR');

export async function callLearningLocal(system, user, { task = 'card' } = {}) {
  const endpoint = localLearningEndpoint();
  const budget = learningBudget(task);
  const room = learningInputRoom(system, user, task);
  if (room.overTokens > 0) {
    throw Object.assign(new Error(`로컬 AI 입력 한도(${ko(room.limit)} 토큰)를 ${ko(room.overTokens)} 토큰 넘었습니다. `
      + `약 ${ko(room.overChars)}자를 줄이거나 OLLAMA_NUM_CTX를 늘리십시오.`), { statusCode: 413 });
  }
  let parsed;
  let promptTokens = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ENV.OLLAMA_MODEL, stream: true, format: 'json',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: { temperature: 0, num_ctx: budget.contextTokens, num_predict: budget.outputTokens } })
    });
    if (!response.ok) throw new Error('로컬 AI 응답 실패');
    const decoder = new TextDecoder(); let buffer = ''; let content = ''; let done = false;
    const consume = line => {
      if (!line.trim()) return;
      const part = JSON.parse(line);
      // 출력이 잘린 것과 응답 자체가 깨진 것은 사용자가 취할 조치가 다르다.
      if (part.done_reason === 'length') throw Object.assign(new Error('로컬 AI 출력 미완료'), { truncated: true });
      if (part.error) throw new Error('로컬 AI 출력 오류');
      content += part.message?.content || '';
      if (content.length > 60000) throw new Error('로컬 AI 출력 한도 초과');
      if (part.done) { done = true; promptTokens = part.prompt_eval_count ?? null; }
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 150000) throw new Error('로컬 AI 응답 한도 초과');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    }
    buffer += decoder.decode(); consume(buffer);
    if (!done) throw new Error('로컬 AI 응답 미완료');
    parsed = JSON.parse(content);
  } catch (error) {
    // 모델 원문이나 내부 예외는 그대로 올리지 않는다. 예산 수치만 알린다.
    if (error?.truncated) {
      throw Object.assign(new Error(`로컬 AI 출력이 ${ko(budget.outputTokens)} 토큰에서 잘렸습니다. `
        + '요청 범위를 좁히거나 OLLAMA_NUM_PREDICT를 늘리십시오. 잘린 결과는 저장하지 않았습니다.'), { statusCode: 503 });
    }
    throw Object.assign(new Error('로컬 AI가 완전한 JSON 응답을 반환하지 못했습니다. Ollama 상태와 모델·입출력 예산을 확인하십시오. 외부 AI 호출은 하지 않았습니다.'), { statusCode: 503 });
  } finally { clearTimeout(timeout); }

  // 토큰 추정이 실제보다 작으면 Ollama가 프롬프트 앞부분을 조용히 잘라낸다.
  // 그렇게 만들어진 지식은 답변 일부만 반영하고도 완전한 것처럼 보이므로,
  // 모델이 보고한 실제 입력 토큰으로 대조하고 다음 추정에 반영한다.
  if (Number.isSafeInteger(promptTokens) && promptTokens > 0) {
    recordObservation('ollama', ENV.OLLAMA_MODEL, room.raw, promptTokens);
    if (promptTokens > budget.inputLimit) {
      throw Object.assign(new Error(`실제 입력이 예산을 넘었습니다(추정 ${ko(room.tokens)} 토큰, 실제 ${ko(promptTokens)} 토큰, 한도 ${ko(budget.inputLimit)} 토큰). `
        + '일부가 잘린 채 처리되었을 수 있어 결과를 저장하지 않았습니다. 범위를 줄여 다시 시도하십시오.'), { statusCode: 413 });
    }
  }
  return parsed;
}
