import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { batchDocumentParts, mergeTopUpFacts, needsFactTopUp, topUpFacts } from '../server/reasoning/stages/factTopUp.js';

const longDoc = [...Array(6).keys()].map(i => `제${i + 1}조(항목${i + 1})\n① 2024년 ${i + 1}월 ${i + 1}0일 담당 직원에게 가산수당 ${i + 1}00만원을 추가 지급하였다. ${'세부 경위를 설명한다. '.repeat(60)}`).join('\n');
const registry = () => buildEvidenceRegistry({ meta: { asOfDate: '20260923' }, officialEvidence: {} }, { documentText: longDoc });
const base = { facts: [{ id: 'F1', text: '직원에게 수당을 지급하였다', status: 'CONFIRMED', docRef: 'D1', quote: '', quoteVerified: false }],
  issues: [{ id: 'I1', question: '가산수당 추가 지급이 적법한가', searchTerms: ['가산수당'], factIds: ['F1'], evidenceIds: [], dependsOn: [] }], unknownFacts: [], diagnostics: {} };

test('사실 보충은 긴 문서에서 사실이 분량에 비해 적을 때만 필요하다', () => {
  assert.equal(needsFactTopUp(1, 13502), true);
  assert.equal(needsFactTopUp(5, 13502), false);
  assert.equal(needsFactTopUp(0, 2000), false, '짧은 문서는 보충하지 않는다');
});

test('문서 조각은 입력 예산 안에서 묶인다', () => {
  const batches = batchDocumentParts(registry());
  assert.ok(batches.length >= 2);
  assert.ok(batches.every(b => b.reduce((n, p) => n + p.text.length, 0) <= 2800 * 1.01));
});

test('새 사실은 중복을 걸러 이어 붙이고, 원문에 없는 인용은 추론으로 낮추며, 용어가 겹치는 쟁점에 연결한다', () => {
  const reg = registry();
  const merged = mergeTopUpFacts(base, [
    { text: '직원에게 수당을 지급하였다', status: 'CONFIRMED', docRef: 'D1', quote: '' },
    { text: '가산수당 200만원을 추가 지급하였다', status: 'CONFIRMED', docRef: 'D2', quote: '가산수당 200만원을 추가 지급하였다' },
    { text: '가산수당을 사후 추가 지급한 것으로 보인다', status: 'CONFIRMED', docRef: 'D3', quote: '원문에 없는 문장입니다' }
  ], { registry: reg, query: '' });
  assert.deepEqual(merged.facts.map(f => f.id), ['F1', 'F2', 'F3']);
  assert.equal(merged.facts[1].quoteVerified, true);
  assert.equal(merged.facts[2].status, 'INFERRED');
  assert.deepEqual(merged.issues[0].factIds, ['F1', 'F2', 'F3']);
  assert.equal(merged.diagnostics.factTopUp.added, 2);
});

test('보충 호출이 모두 실패해도 S1 결과를 그대로 돌려준다', async () => {
  const result = await topUpFacts({ caseIssues: base, registry: registry(), query: '', documentChars: 13502, provider: 'ollama',
    config: { model: 'x', budget: { inputLimit: 4096, outputLimit: 512 } }, session: null });
  assert.equal(result.facts.length, 1);
  assert.ok(result.diagnostics.factTopUp.failures.length >= 1 || result.diagnostics.factTopUp.added === 0);
});
