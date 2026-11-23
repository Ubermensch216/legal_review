import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileDocument, profilePromptLines } from '../server/reasoning/documentProfile.js';

test('감사 결과 보고서는 지적 사항·처분 요구 신호로 식별하고, 지적문을 확정 사실로 보지 않도록 안내한다', () => {
  const p = profileDocument({ query: '이 처분 수위가 타당한지 검토해 주세요', documentText: '감사 결과 보고\n1. 지적 사항: 수당 과다 지급\n처분 요구: 회수 및 주의\n관련 규정 위반 사항' });
  assert.equal(p.type, 'AUDIT_REPORT');
  assert.equal(p.purpose, 'CONSEQUENCE');
  assert.match(profilePromptLines(p), /감사기관의 주장이며 확정 사실이 아니다/);
});

test('계약서와 기존 검토의견서를 구분한다', () => {
  assert.equal(profileDocument({ documentText: '용역 계약서\n갑(발주기관)과 을(수급인)은\n계약 기간 및 계약 금액\n제10조 해지 및 손해배상' }).type, 'CONTRACT');
  const ai = profileDocument({ documentText: '# 법률 검토의견서\n## 1. 검토 요지\n쟁점별 검토\n결론 표' });
  assert.equal(ai.type, 'AI_REVIEW');
  assert.match(ai.guidance, /결론을 사실로 받아들이지 말고/);
});

test('신호가 약하면 종류를 단정하지 않고 지시문도 덧붙이지 않는다', () => {
  const p = profileDocument({ query: '이 업무를 해도 되나요?', documentText: '회의 메모입니다.' });
  assert.equal(p.type, 'UNKNOWN');
  assert.equal(profilePromptLines(p), '');
});
