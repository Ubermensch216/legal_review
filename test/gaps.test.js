import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveGaps } from '../server/reasoning/stages/gaps.js';

const issue = (id, extra = {}) => ({ id, question: `${id} 쟁점`, type: 'PRIMARY', priority: 'HIGH', ...extra });
const element = id => ({ id, text: `${id} 요건`, mandatory: true, isException: false });
const assessment = (elementId, extra = {}) => ({ elementId, status: 'UNKNOWN', proof: 'NO_EVIDENCE', evidenceIds: ['A1.1'], openQuestion: '', ...extra });
const result = (issueId, deciding, assessments) => ({ issueId, stageStatus: 'OK', elements: assessments.map(a => element(a.elementId)),
  assessments, conclusion: { legal: 'CONDITIONAL', decidingElementIds: deciding }, precedents: [], counter: null });

test('결론을 좌우하지 않는 요건의 공백은 만들지 않고, 여러 쟁점에 걸친 같은 요건은 한 번만 묻는다', () => {
  const gaps = deriveGaps({
    issues: [issue('I1'), issue('I2')],
    issueResults: [
      result('I1', ['A1.E1'], [assessment('A1.E1', { openQuestion: '판단 기준은?' }), assessment('A1.E2', { openQuestion: '결론과 무관한 의문' })]),
      result('I2', ['A1.E1'], [assessment('A1.E1', { openQuestion: '같은 요건의 판단 기준은?' })])
    ]
  });
  const legal = gaps.filter(g => g.type === 'LEGAL_INTERPRETATION');
  assert.deepEqual(legal.map(g => [g.issueId, g.elementId]), [['I1', 'A1.E1']]);
  assert.equal(gaps.filter(g => g.type === 'FACT_UNKNOWN' && g.elementId).length, 1);
  assert.ok(!gaps.some(g => g.elementId === 'A1.E2'));
});

test('쟁점에 매이지 않는 자료 밖 사실은 문장마다 따로 남는다', () => {
  const gaps = deriveGaps({ issues: [], issueResults: [], unknownFacts: ['실제 근로시간', '변경 전후 임금'], collectionWarnings: ['판례 조회 미완료'] });
  assert.deepEqual(gaps.map(g => [g.type, g.route, g.question]), [
    ['FACT_UNKNOWN', 'USER', '실제 근로시간'], ['FACT_UNKNOWN', 'USER', '변경 전후 임금'], ['COLLECTION_FAILURE', 'RECOLLECT', '판례 조회 미완료']]);
});

test('입증 자료 부족을 설명하는 모델 질문은 외부 법리 질의로 분류하지 않는다', () => {
  const gaps = deriveGaps({ issues: [issue('I1')], issueResults: [result('I1', ['A1.E1', 'A1.E2', 'A1.E3'], [
    assessment('A1.E1', { openQuestion: '근로자 동의가 실제로 이루어졌는지 사실관계가 자료에 제시되어 있지 않다.' }),
    assessment('A1.E2', { evidenceIds: [], openQuestion: '' }),
    assessment('A1.E3', { openQuestion: '노동조합이 있는가?' })
  ])] });
  assert.deepEqual(gaps.map(g => g.type), ['FACT_UNKNOWN', 'FACT_UNKNOWN', 'FACT_UNKNOWN']);
  assert.ok(gaps.every(g => g.route === 'USER'));
  assert.match(gaps[0].question, /동의가 실제로/);
});

test('요건이 없어 생략된 쟁점은 공식 근거 공백으로 남긴다', () => {
  const gaps = deriveGaps({ issues: [issue('I1')], issueResults: [{ ...result('I1', [], []), stageStatus: 'SKIPPED' }] });
  assert.deepEqual(gaps.map(g => [g.type, g.route, g.issueId]), [['MISSING_AUTHORITY', 'EXTERNAL_INQUIRY', 'I1']]);
});

test('외부 질의 공백이 질문 상한(12)을 넘으면 뒤쪽은 버리지 않고 다음 질의로 미룬다', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `A${i + 1}.E1`);
  const gaps = deriveGaps({ issues: [issue('I1')], issueResults: [result('I1', ids, ids.map(id => assessment(id, { openQuestion: `${id}의 법리 기준은 무엇인가?` })))] });
  const inquiry = gaps.filter(g => g.route === 'EXTERNAL_INQUIRY');
  assert.equal(inquiry.filter(g => g.state === 'OPEN').length, 12);
  assert.equal(inquiry.filter(g => g.state === 'DEFERRED').length, 2);
});
