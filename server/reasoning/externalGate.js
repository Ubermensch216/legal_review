// server/reasoning/externalGate.js - 외부 LLM 전송 게이트
//
// 문서·질의 원문이 이 PC 밖으로 나가는 모든 경로(생성 호출, 토큰 계수 API)는 여기를 지나야 한다.
// 기본값은 '차단'이다. 전송은 사용자가 그 전송문을 확인하고 승인했을 때만 허용한다.
// 승인은 전송문의 해시에 묶인다. 승인 뒤 내용이 한 글자라도 바뀌면 다시 막힌다.
//
// 승인 화면과 승인 발급은 4단계(비식별·승인 절차)에서 구현한다. 그 전까지 운영 코드에는
// 승인을 발급하는 곳이 없으므로 외부 제공자 호출은 모두 차단된다.
import { createHash } from 'node:crypto';

export const EXTERNAL_PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini', 'exaone']);
export const isExternalProvider = provider => EXTERNAL_PROVIDERS.includes(String(provider || '').toLowerCase());

const PROVIDER_LABEL = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', exaone: 'LG EXAONE' };

export class ExternalTransmissionBlockedError extends Error {
  constructor(provider) {
    super(`${PROVIDER_LABEL[provider] || provider} 같은 외부 LLM으로는 사용자 승인 없이 문서를 보낼 수 없어 전송을 차단했습니다. `
      + '외부 전송 승인 기능이 도입되기 전까지는 설정에서 \'Ollama (로컬 LLM)\'를 선택하십시오.');
    this.name = 'ExternalTransmissionBlockedError';
    this.code = 'EXTERNAL_TRANSMISSION_BLOCKED';
    this.statusCode = 409;
    this.provider = provider;
  }
}

/** 전송문(시스템 지시문 + 사용자 입력)의 해시. 승인은 이 값에 묶인다. */
export const payloadDigest = (system, user) =>
  createHash('sha256').update(`${String(system ?? '')}\n\n${String(user ?? '')}`).digest('hex');

// 운영 코드는 이 값을 바꾸지 않는다. 시험이 외부 제공자 어댑터를 가짜 응답으로 검증할 때만 쓴다.
let testPolicy = null;
export function setExternalTransmissionPolicyForTests(policy) { testPolicy = typeof policy === 'function' ? policy : null; }

/**
 * 이 전송문을 보내도 되는가.
 * @param {string} provider
 * @param {string} system
 * @param {string} user
 * @param {{ approvedDigests?: Set<string>|string[] }} [approval] 사용자 승인. 4단계에서 세션에 실린다.
 */
export function isTransmissionAllowed(provider, system, user, approval = null) {
  if (!isExternalProvider(provider)) return true;
  const digest = payloadDigest(system, user);
  const approved = approval?.approvedDigests;
  if (approved && (approved instanceof Set ? approved.has(digest) : approved.includes(digest))) return true;
  return Boolean(testPolicy?.(provider, digest));
}

export function assertTransmissionAllowed(provider, system, user, approval = null) {
  if (!isTransmissionAllowed(provider, system, user, approval)) throw new ExternalTransmissionBlockedError(provider);
}

/**
 * 검토를 시작하기 전에 이 제공자를 쓸 수 있는지 미리 본다. 전송문 단위 확인은 호출 직전에 다시 한다.
 * 승인 흐름이 아직 없으면 외부 제공자는 시작 단계에서 거절한다.
 */
export const canStartWithProvider = provider => !isExternalProvider(provider) || Boolean(testPolicy);
