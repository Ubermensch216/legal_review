import './setup.js';
// test/lawApi.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleReferences, normalizeArticleNo } from '../server/law/lawArticleRef.js';
import { expandQueryKeywords } from '../server/law/lawTermKb.js';
import { computeDiff } from '../server/law/lawDiff.js';
import { runTool } from '../server/law/tools/toolRunner.js';

test('조문 인용 정규식 파서 (lawArticleRef)', () => {
  const text = '개인정보 보호법 제15조 제1항 제2호 및 동법 제29조에 따라 안전조치를 취해야 한다. 또한 제30조의2 조항도 준수.';
  const refs = extractArticleReferences(text, '개인정보 보호법');

  assert.ok(refs.length >= 2, '2개 이상의 조문이 추출되어야 함');
  assert.equal(refs[0].articleNo, '15');
  assert.equal(refs[0].paragraphNo, '1');
  assert.equal(refs[0].itemNo, '2');
  assert.equal(normalizeArticleNo('30의2'), '30의2');
});

test('법률 전문용어 KB 확장 (lawTermKb)', () => {
  const query = '야근수당 및 퇴직금 미지급 관련 분쟁';
  const result = expandQueryKeywords(query);

  assert.ok(result.expandedTerms.includes('연장근로수당') || result.expandedTerms.includes('근로기준법 제56조'));
  assert.ok(result.suggestedLaws.some(l => l.name === '근로기준법'));
});

test('조문 Diff 비교 엔진 (lawDiff)', () => {
  const oldText = '개인정보처리자는 정보주체의 동의를 받아야 한다.';
  const newText = '개인정보처리자는 정보주체의 명시적 동의를 받아야 한다.';
  const diffs = computeDiff(oldText, newText);

  assert.ok(diffs.some(d => d.type === 'added' && d.value.includes('명시적')));
});

test('19대 도구 실행 러너 (toolRunner)', async () => {
  const res = await runTool('searchLaw', { query: '개인정보 보호법' });
  assert.equal(res.ok, true);
  assert.equal(res.result.items.length, 0, '자격증명 없는 일반 모드에서는 샘플을 반환하지 않는다.');
  assert.equal(res.result.fetchStatus, 'UNAVAILABLE');

  const toolDiff = await runTool('articleDiff', {
    oldText: '제1조 목적',
    newText: '제1조 목적 및 정의'
  });
  assert.equal(toolDiff.ok, true);
  assert.ok(toolDiff.result.diffChunks.length > 0);
});
