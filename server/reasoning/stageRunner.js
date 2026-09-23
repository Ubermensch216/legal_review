// server/reasoning/stageRunner.js - 단계 호출 공통: 호출 → JSON 해석 → 스키마 검증 → 1회 교정 재시도
import { complete } from './llmGateway.js';
import { parseModelJson, validateSchema } from './schemas.js';

export class StageError extends Error {
  constructor(stage, message, details = {}) {
    super(`${stage}: ${message}`);
    this.name = 'StageError';
    this.stage = stage;
    Object.assign(this, details);
  }
}

/**
 * 한 단계를 실행한다. 프롬프트는 [공통 접두부][과제 접미부] 순서로 붙인다.
 * 접두부를 바이트 단위로 같게 유지해야 Ollama가 앞선 호출의 KV 캐시를 재사용한다.
 *
 * 재시도는 한 번뿐이다. 온도가 낮아 같은 입력을 다시 보내면 같은 오류가 나므로,
 * 무엇이 틀렸는지를 접미부 끝에 덧붙여 보낸다(접두부는 그대로라 캐시는 유지된다).
 *
 * @param {object} args
 * @param {string} args.stage 원장·오류에 남길 단계 이름
 * @param {string} args.provider
 * @param {string} args.system 전 단계 공통 지시문
 * @param {string} args.prefix 공통 접두부
 * @param {string} args.task 단계별 접미부
 * @param {object} args.schema JSON Schema
 * @param {object} args.config 게이트웨이 어댑터 설정(budget, model, think 등)
 * @param {object} args.session createLlmSession 결과
 * @returns {Promise<{ value: object, attempts: number }>}
 */
export async function runStage({ stage, provider, system, prefix, task, schema, config, session }) {
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = `${prefix}\n\n${task}${feedback}`;
    let content;
    try {
      ({ content } = await complete({ stage: attempt === 1 ? stage : `${stage}:retry`, provider, system, user,
        config: { ...config, schema }, session }));
    } catch (err) {
      // 전송 실패·절단은 같은 입력으로 다시 보내도 결과가 같다. 교정 재시도 대상이 아니다.
      throw new StageError(stage, err.message, { cause: err, attempts: attempt });
    }
    const value = parseModelJson(content);
    const errors = value === null ? ['JSON으로 해석할 수 없습니다'] : validateSchema(schema, value);
    if (!errors.length) return { value, attempts: attempt };
    if (attempt === 2) throw new StageError(stage, `출력 형식 오류: ${errors.slice(0, 3).join(' / ')}`, { attempts: attempt, errors });
    feedback = `\n\n[직전 출력의 형식 오류 — 고쳐서 다시 출력하십시오]\n${errors.slice(0, 6).map(e => `- ${e}`).join('\n')}`;
  }
  throw new StageError(stage, '도달할 수 없는 경로');
}
