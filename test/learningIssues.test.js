import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLearningIssues, collectLearningQuestions, expandReferences, explainDiagnostic } from '../public/js/learningIssues.js';

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

test('수집·작성·검증 실행 경고를 외부 전문가 질문으로 보내지 않는다', () => {
  const data = { progressTrace: { events: [
    { kind: 'step', key: 'write', label: '의견서 작성', group: '작성', state: 'RUNNING' },
    { kind: 'warn', key: 'write', detail: '서술과 결론 불일치' },
    { kind: 'step', key: 'verify', label: '근거 검증', group: '검증', state: 'RUNNING' },
    { kind: 'warn', key: 'verify', detail: 'P7 함의 확인 실패' }
  ] }, meta: { dataIntegrity: { collectionDiagnostics: ['판례 본문 수집 실패'] } },
  review: { warnings: ['가장 강한 반대 논리에 대한 응답 없음'] } };

  const questions = collectLearningQuestions(data);
  assert.equal(questions.length, 0);
});

test('법리 공백의 내부 조문 ID를 사람이 읽을 수 있는 공식 표제로 바꾼다', () => {
  const data = { review: { reasoning: {
    evidence: [{ id: 'A1.6x', label: '행정절차법 제21조 제6항 단서' }],
    gaps: [{ id: 'G1', route: 'EXTERNAL_INQUIRY', state: 'OPEN', issueId: 'I1', type: 'AUTHORITY_CONFLICT',
      question: '반대 견해 A1.6x를 어떻게 평가해야 하는가?' }]
  } } };
  const questions = collectLearningQuestions(data);
  assert.equal(questions.length, 1);
  assert.match(questions[0].text, /행정절차법 제21조 제6항 단서/);
});

test('조문·쟁점의 내부 번호를 짧은 설명으로 바꾸되 원본 진단은 보존한다', () => {
  const data = { review: { reasoning: {
    evidence: [{ id: 'A23', label: '민법 제673조', title: '완성전의 도급인의 해제권',
      preview: '도급인은 일이 완성되기 전에는 손해를 배상하고 계약을 해제할 수 있다.' }],
    issues: [{ id: 'I3', question: '해지 시 기성 대가를 지급해야 하는가?' }],
    gateReasons: ['I3: 요건 분해 미검증 조문 A23']
  } } };
  const issue = collectLearningIssues(data)[0];
  assert.equal(issue.detail, 'I3: 요건 분해 미검증 조문 A23');
  assert.match(issue.displayDetail, /민법 제673조.*완성전의 도급인의 해제권.*적용 조건을 더 확인해야 합니다/);
  assert.match(issue.displayDetail, /해지 시 기성 대가/);
  assert.doesNotMatch(issue.displayDetail, /\b(?:A23|I3)\b/);
  assert.match(expandReferences('A23', data), /민법 제673조/);
  assert.equal(explainDiagnostic('조문 요건 분해 실패(A23: A23) — 골격 요건으로 대체: s3: A23 응답에 유효한 출처 ID가 없습니다.', data),
    '민법 제673조 (완성전의 도급인의 해제권): 이 법 조항의 적용 조건을 충분히 확인하지 못했습니다.');
});
