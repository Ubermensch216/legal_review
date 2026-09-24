import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLearningIssues } from '../public/js/learningIssues.js';

test('검토 이력의 법리 공백과 준비·수집·분석 실패를 함께 표시한다', () => {
  const issues = collectLearningIssues({
    progressTrace: { events: [
      { kind: 'step', key: 'prepare', label: '문서 준비', group: '준비', state: 'RUNNING' },
      { kind: 'warn', key: 'prepare', detail: '첨부 조항 일부 누락' },
      { kind: 'step', key: 'search', label: '판례 수집', group: '수집', state: 'RUNNING' },
      { kind: 'step', key: 'search', state: 'FAILED', detail: '조회 실패' },
      { kind: 'step', key: 'analyse', label: '쟁점 분석', group: '분석', state: 'RUNNING' },
      { kind: 'warn', key: 'analyse', detail: '긴 질의 일부 제외' }
    ] },
    meta: { dataIntegrity: { collectionDiagnostics: ['판례 수집: 조회 실패'] } },
    review: { reasoning: { gaps: [
      { route: 'EXTERNAL_INQUIRY', state: 'OPEN', question: '해석 기준은?' },
      { route: 'USER', state: 'OPEN', question: '사실 확인은?' }
    ] }, warnings: ['긴 질의 일부 제외'] }
  });
  assert.deepEqual(issues.map(({ group, detail }) => [group, detail]), [
    ['법리 판단', '해석 기준은?'],
    ['준비', '첨부 조항 일부 누락'],
    ['수집', '판례 수집: 조회 실패'],
    ['분석', '긴 질의 일부 제외']
  ]);
});

test('진행 기록이 없는 이전 이력에서도 저장된 제한 사항을 표시한다', () => {
  const issues = collectLearningIssues({
    meta: { dataIntegrity: { warnings: ['공식 조문 미확보'] } },
    review: { warnings: ['요약 생성 실패'], reasoning: { gateReasons: ['요건 분해 실패'] } }
  });
  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map(issue => issue.group), ['수집', '분석', '분석']);
});
