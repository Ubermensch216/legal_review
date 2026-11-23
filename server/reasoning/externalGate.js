// server/reasoning/externalGate.js - 외부 LLM 전송 게이트
//
// 문서·질의 원문이 이 PC 밖으로 나가는 모든 경로(생성 호출, 토큰 계수 API)는 여기를 지나야 한다.
// 기본값은 '차단'이다. 전송은 사용자가 그 전송문을 확인하고 승인했을 때만 허용한다.
// 승인은 전송문의 해시에 묶인다. 승인 뒤 내용이 한 글자라도 바뀌면 다시 막힌다.
//
// 승인에는 두 가지가 있다.
//  - approvedDigests: 사용자가 비식별된 전송문 하나를 보고 승인한 해시(쟁점 단위 외부 재검토).
//  - scope: 사용자가 비식별된 검토 입력 전체를 승인한 범위(외부 LLM만 쓰는 모드). 이 경우에도 호출마다
//    전송문에 식별정보 후보가 남아 있으면 막는다.
// 승인을 발급하는 곳은 사용자가 승인 버튼을 누른 API뿐이다.
import { createHash } from 'node:crypto';
import { remainingIdentifiers } from '../privacy/deidentify.js';
import { recordExternalTransmission } from '../privacy/auditLog.js';

export const EXTERNAL_PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini', 'exaone']);
export const isExternalProvider = provider => EXTERNAL_PROVIDERS.includes(String(provider || '').toLowerCase());

const PROVIDER_LABEL = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', exaone: 'LG EXAONE' };

export class ExternalTransmissionBlockedError extends Error {
  constructor(provider, reason = null) {
    super(reason ? `${PROVIDER_LABEL[provider] || provider}로 보내려는 내용에 ${reason}이(가) 남아 있어 전송을 차단했습니다. 비식별 결과를 다시 확인하십시오.` : `${PROVIDER_LABEL[provider] || provider} 같은 외부 LLM으로는 사용자 승인 없이 문서를 보낼 수 없어 전송을 차단했습니다. `
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
export function transmissionDecision(provider, system, user, approval = null) {
  if (!isExternalProvider(provider)) return { allowed: true };
  const digest = payloadDigest(system, user);
  const approved = approval?.approvedDigests;
  if (approved && (approved instanceof Set ? approved.has(digest) : approved.includes(digest))) {
    return { allowed: true, basis: 'PAYLOAD_APPROVED', digest };
  }
  if (approval?.scope && (!approval.scope.provider || approval.scope.provider === provider)) {
    const remaining = remainingIdentifiers(`${system}
${user}`);
    return remaining.length ? { allowed: false, reason: remaining.join(', '), digest }
      : { allowed: true, basis: 'SCOPE_APPROVED', digest, scope: approval.scope.label || approval.scope.inputDigest };
  }
  return testPolicy?.(provider, digest) ? { allowed: true, basis: 'TEST', digest } : { allowed: false, digest };
}

export const isTransmissionAllowed = (provider, system, user, approval = null) =>
  transmissionDecision(provider, system, user, approval).allowed;

export function assertTransmissionAllowed(provider, system, user, approval = null) {
  const decision = transmissionDecision(provider, system, user, approval);
  if (!decision.allowed) throw new ExternalTransmissionBlockedError(provider, decision.reason || null);
  if (isExternalProvider(provider) && decision.basis !== 'TEST') {
    recordExternalTransmission({ provider, basis: decision.basis, digest: decision.digest, scope: decision.scope || null,
      chars: String(system || '').length + String(user || '').length });
  }
}

/**
 * 검토를 시작하기 전에 이 제공자를 쓸 수 있는지 미리 본다. 전송문 단위 확인은 호출 직전에 다시 한다.
 * 승인 흐름이 아직 없으면 외부 제공자는 시작 단계에서 거절한다.
 */
export const canStartWithProvider = (provider, approval = null) => !isExternalProvider(provider) || Boolean(testPolicy) || Boolean(approval?.scope);
