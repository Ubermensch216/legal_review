import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { coversIssue, loadGoldSet, scoreAgainstGold } from './benchmark/goldSet.js';
import { compareRuns } from './benchmark/compareRuns.js';

const gold = loadGoldSet().cases.find(c => c.id === '01');
const issue = (id, question, legal, stageStatus = 'OK') => ({ id, question, stageStatus, assessments: [{ elementId: 'x' }], conclusion: { legal }, research: { queries: [] } });

test('정답셋은 전문가 검수 전에는 초안으로 표시되고 사례마다 기대 조문과 쟁점을 가진다', () => {
  const set = loadGoldSet();
  assert.equal(set.status, 'DRAFT_NOT_EXPERT_VERIFIED');
  assert.ok(set.cases.every(c => c.expectedArticles.length && c.expectedIssues.length && c.mustCite.every(m => c.expectedArticles.includes(m))));
  assert.ok(set.cases.every(c => c.expertReviewed === null), '검수 전에는 expertReviewed가 비어 있어야 한다');
});

test('기대 쟁점은 키워드 묶음 중 하나가 쟁점 문장에 모두 있으면 다룬 것으로 센다', () => {
  const expected = gold.expectedIssues[0];
  assert.equal(coversIssue(expected, [issue('I1', '불이익 변경에 근로자 동의가 필요한가?')]), true);
  assert.equal(coversIssue(expected, [issue('I1', '휴게시간이 적법한가?')]), false);
});

test('검토 결과를 정답셋과 비교해 인용·쟁점 누락·금지 결론·판단 실행 비율을 낸다', () => {
  const review = {
    legalBasis: [{ lawName: '근로기준법', articleNo: '제94조 제1항', verificationStatus: 'VERIFIED' }],
    reasoning: { issues: [
      issue('I1', '불이익 변경에 근로자 동의가 필요한가?', 'CONDITIONAL'),
      issue('I2', '퇴직 후 경업금지 위약벌이 제20조에 위반되는가?', 'NOT_APPLICABLE'),
      { ...issue('I3', '가산수당을 지급해야 하는가?', 'CONDITIONAL', 'SKIPPED'), assessments: [] }] }
  };
  const score = scoreAgainstGold(review, gold);
  assert.equal(score.citation.mustCited, '1/2');
  assert.deepEqual(score.issueCoverage.missing, ['징계해고 절차']);
  assert.equal(score.issueCoverage.covered, 3);
  assert.equal(score.forbidden.length, 1, '경업금지를 제20조 위반으로 자동 판정한 결론을 잡는다');
  assert.deepEqual(score.judged, { issues: 3, judged: 2, rate: 0.67 });
  assert.equal(score.expertReviewed, null);
});

test('두 측정 결과를 사례별로 비교한다', () => {
  const row = (wallMs, judged, linked) => ({ id: '01', stage: 'DONE', wallMs, ledger: { totals: { calls: 9, outputTokens: 2800 } },
    reasoning: { issues: [1, 2, 3, 4, 5], judgedIssues: judged, linkedIssues: linked, facts: 1 } });
  const [result] = compareRuns({ rows: [row(299000, 0, 0)] }, { rows: [row(240000, 4, 5)] });
  assert.equal(result.time, '299s → 240s');
  assert.equal(result.judged, '0/5 → 4/5');
  assert.equal(result.linked, '0 → 5');
});
