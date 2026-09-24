import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateProgressWithinRange, progressRangeForStep } from '../public/js/reviewTrace.js';

test('긴 분석 작업은 시작만으로 마무리 구간에 도달하지 않는다', () => {
  const range = progressRangeForStep('s1', { profile: 'staged', totalIssues: 3, issueKeys: [] });
  const afterSixSeconds = estimateProgressWithinRange({ range, elapsedMs: 6000 });

  assert.deepEqual(range, [44, 58, 90000]);
  assert.ok(afterSixSeconds >= 44 && afterSixSeconds < 48,
    `쟁점 분석 6초 시점의 진행률이 너무 앞섰습니다: ${afterSixSeconds}`);
});

test('단계 완료 가중치는 작업 개수가 아니라 예상 소요량을 반영한다', () => {
  const quickAggregation = progressRangeForStep('integrity', { profile: 'monolithic' });
  const longGeneration = progressRangeForStep('llm', { profile: 'monolithic' });

  assert.equal(quickAggregation[1] - quickAggregation[0], 1);
  assert.equal(longGeneration[1] - longGeneration[0], 26);
});

test('단계형 포섭 구간은 실제 쟁점 수에 맞춰 균등 배분된다', () => {
  const context = { profile: 'staged', totalIssues: 2, issueKeys: ['s4:I1', 's4:I2'] };

  assert.deepEqual(progressRangeForStep('s4:I1', context), [70, 78, 90000]);
  assert.deepEqual(progressRangeForStep('s4:I2', context), [78, 86, 90000]);
});

test('진행 중인 작업은 자기 구간 끝을 넘지 않고 완료 때만 끝에 도달한다', () => {
  const range = [52, 78, 120000];
  const running = estimateProgressWithinRange({ range, elapsedMs: 600000, workDone: 20000, workTotal: 16000 });
  const done = estimateProgressWithinRange({ range, completed: true });

  assert.ok(running < 78);
  assert.equal(done, 78);
});

test('단계형 분석 실패 후 단일 호출 폴백은 기존 진행률 이후 구간을 사용한다', () => {
  assert.deepEqual(progressRangeForStep('budget', { profile: 'fallback' }), [58, 60, 2000]);
  assert.deepEqual(progressRangeForStep('llm', { profile: 'fallback' }), [66, 80, 120000]);
});
