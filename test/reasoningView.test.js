import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReasoningOpinion } from '../public/js/reasoningView.js';

const reasoning = {
  facts: [{ id: 'F1', text: '동의 없이 조항을 변경했다' }],
  evidence: [{ id: 'A1.1', label: '근로기준법 제94조 제1항', official: true, inForce: true }],
  issues: [{
    id: 'I1', question: '동의가 필요한가?', factIds: ['F1'],
    elements: [{ id: 'E1', text: '불리한 변경', sourceIds: ['A1.1'], mandatory: true }],
    assessments: [{ elementId: 'E1', status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: ['F1'], contraryFactIds: [],
      evidenceIds: ['A1.1'], analysis: '불리한지 확인되지 않았다', openQuestion: '변경 전후 조건은?' }],
    conclusion: { legal: 'CONDITIONAL', proof: 'NO_EVIDENCE', reasons: ['불이익 여부 미확정'], decidingElementIds: ['E1'] }
  }],
  gaps: [{ issueId: 'I1', route: 'EXTERNAL_INQUIRY', state: 'OPEN', question: '해석 기준 확인' }],
  gate: 'HUMAN_REVIEW_REQUIRED', gateReasons: ['추가 검토 필요']
};

test('쟁점별 I-R-A-C 뒤에 전체 결론과 남은 확인 사항을 표시한다', () => {
  const html = renderReasoningOpinion(reasoning, { summary: '현재 판단 유보', recommendations: ['변경 조건 확보'] });
  const markers = ['Issue · 쟁점', 'Rule · 적용 규범', 'Application · 사실에 적용', 'Conclusion · 쟁점별 결론', '종합 분석 결과'];
  let position = -1;
  for (const marker of markers) {
    const next = html.indexOf(marker);
    assert.ok(next > position, marker);
    position = next;
  }
  assert.match(html, /공식·기준일 유효 · 근로기준법 제94조 제1항/);
  assert.match(html, /포섭 판단.*불리한지 확인되지 않았다/);
  assert.match(html, /현재 판단 유보/);
  assert.match(html, /결론을 제한하는 남은 확인 사항/);
  assert.match(html, /data-open-learning/);
  assert.doesNotMatch(renderReasoningOpinion(reasoning, {}, { report: true }), /data-open-learning/);
});

test('공식 출처가 없는 규범을 공식으로 표시하거나 입력 HTML을 실행 가능한 형태로 내보내지 않는다', () => {
  const input = structuredClone(reasoning);
  input.issues[0].elements[0].sourceIds = [];
  input.issues[0].assessments[0].evidenceIds = [];
  input.issues[0].question = '<script>alert(1)</script>';
  const html = renderReasoningOpinion(input);
  assert.match(html, /연결된 공식 출처 없음 · 확인 필요/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
