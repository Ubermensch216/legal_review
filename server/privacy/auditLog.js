// server/privacy/auditLog.js - 외부 LLM 전송 기록
//
// 무엇을 보냈는지는 남기지 않는다(그 자체가 민감정보일 수 있다). 언제, 어디로, 어떤 승인으로, 얼마나,
// 어떤 종류의 식별정보를 가리고 보냈는지만 한 줄씩 남겨 사용자가 나중에 확인할 수 있게 한다.
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../env.js';

export const auditLogPath = () => path.join(ENV.CACHE_DIR, 'external-audit.jsonl');

/** 기록 실패가 검토를 막지는 않지만, 실패 사실은 호출부가 알 수 있게 false를 돌려준다. */
export function recordExternalTransmission(entry) {
  try {
    fs.mkdirSync(path.dirname(auditLogPath()), { recursive: true });
    fs.appendFileSync(auditLogPath(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    return true;
  } catch { return false; }
}

export function readExternalAudit(limit = 100) {
  try {
    return fs.readFileSync(auditLogPath(), 'utf8').split('\n').filter(Boolean).slice(-limit).map(line => JSON.parse(line));
  } catch { return []; }
}
