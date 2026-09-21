import { ENV } from './server/env.js';
import { readTokenUsage } from './server/law/llmBudget.js';
export async function callOllama(systemPrompt, userPrompt, config = {}) {
  const url = config.url || ENV.OLLAMA_URL;
  const model = config.model || ENV.OLLAMA_MODEL;

  // 1단계: 짧은 헬스체크로 "Ollama 미기동" 상황만 빠르게 걸러낸다.
  //   생성 자체는 수 분이 걸릴 수 있으므로, 미기동 감지용 타임아웃을 생성 타임아웃으로
  //   그대로 쓰면 정상 동작 중인 모델까지 매번 중단되어 룰베이스로 떨어진다.
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

  // 2단계: 실제 생성 호출. 로컬 모델은 프롬프트 처리 + 수천 토큰 생성에 수 분이 걸린다.
  //   Node의 fetch(undici)는 응답 '헤더'를 300초 안에 받지 못하면 요청을 끊고
  //   원인을 알 수 없는 TypeError('fetch failed', UND_ERR_HEADERS_TIMEOUT)만 남긴다.
  //   이 한도는 dispatcher를 갈아끼우지 않는 한 바꿀 수 없다.
  //   stream:false는 생성이 다 끝나야 헤더가 오므로, LLM_TIMEOUT을 아무리 늘려도
  //   300초를 넘는 생성은 전부 여기서 잘려 룰베이스로 떨어졌다.
  //   그래서 스트리밍으로 받는다. 헤더는 즉시 오고, 청크가 이어지는 동안 본문 타임아웃도 갱신된다.
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '600000', 10);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  // 전송 계층 오류는 undici가 'fetch failed'로만 알려주므로 원인 코드를 붙여 올린다.
  const describeTransportError = (err) => {
    if (controller.signal.aborted) {
      return new Error(
        `Ollama 응답이 ${Math.round(timeoutMs / 1000)}초 내에 완료되지 않았습니다. ` +
        `더 작은 모델을 쓰거나 LLM_TIMEOUT 환경변수를 늘리십시오.`
      );
    }
    if (err instanceof TypeError || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      const cause = err?.cause?.code || err?.cause?.message;
      return new Error(`Ollama 호출 실패 (${url}): ${err.message}${cause ? ` [${cause}]` : ''}`);
    }
    return err;
  };

  let response;
  try {
    response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: true,
        format: 'json',
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m', // 매 호출마다 모델을 다시 적재하지 않도록 유지
        options: {
          temperature: 0.1,
          // num_ctx는 프롬프트와 생성 토큰이 함께 쓰는 예산이다. Ollama 기본값(4096)은
          // 법령·판례가 포함된 긴 프롬프트에서 출력 여유를 거의 남기지 않아 응답이 잘린다.
          num_ctx: config.budget.contextTokens,
          num_predict: config.budget.outputTokens
        }
      })
    });
  } catch (err) {
    clearTimeout(deadline);
    throw describeTransportError(err);
  }

  if (!response.ok) {
    clearTimeout(deadline);
    throw new Error(`Ollama Error HTTP ${response.status}`);
  }

  // NDJSON 스트림(한 줄에 JSON 한 개)을 모아 최종 응답을 만든다.
  let content = '';
  let last = {};
  try {
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = (line) => {
      const text = line.trim();
      if (!text) return;
      const part = JSON.parse(text);
      if (part.error) throw new Error(`Ollama Error: ${part.error}`);
      content += part.message?.content || '';
      last = part;
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    consume(buffer);
  } catch (err) {
    throw describeTransportError(err);
  } finally {
    clearTimeout(deadline);
  }

  // num_predict 한도에 걸려 응답이 잘리면 JSON 파싱이 실패하고 조용히 룰베이스로 대체된다.
  // 원인을 알 수 있도록 절단 사실을 명시적으로 남긴다.
  if (last.done_reason === 'length') throw Object.assign(new Error('LLM 출력이 토큰 한도로 잘렸습니다.'), { tokenUsage: readTokenUsage('ollama', last) });

  return { content, tokenUsage: readTokenUsage('ollama', last) };
}