import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVerifiedRules, exactAuthorityMatch } from '../server/reasoning/verifiedRules.js';
import { compactSynthesisIssues, contractExecutiveSummary } from '../server/reasoning/stages/synthesis.js';
import { sanitizeExportText } from '../server/export/reportSafety.js';
import { generatePdf } from '../server/export/exportFiles.js';
import pdfParse from 'pdf-parse';

test('위임 해지 명제에 무관한 저작권법을 연결하지 않는다', () => {
  const entries = new Map([
    ['A1', { id: 'A1', kind: 'ARTICLE', lawName: '민법', articleNo: '689', text: '각 당사자는 언제든지 계약을 해지할 수 있다.', official: true, inForce: true }],
    ['A2', { id: 'A2', kind: 'ARTICLE', lawName: '저작권법', articleNo: '14', text: '저작자는 저작인격권을 가진다.', official: true, inForce: true }]
  ]);
  const registry = { get: id => entries.get(id) };
  const result = [{ issueId: 'I3', elements: [{ id: 'E1', text: '위임계약의 당사자는 언제든지 해지할 수 있다.' }],
    assessments: [{ elementId: 'E1', evidenceIds: ['A1', 'A2'], factIds: [] }], conclusion: { decidingElementIds: ['E1'] } }];
  const ledger = [{ issueId: 'I3', elementId: 'E1', checks: [
    { evidenceId: 'A1', entailment: 'SUPPORTS' }, { evidenceId: 'A2', entailment: 'SUPPORTS' }] }];
  attachVerifiedRules(result, ledger, registry);
  assert.deepEqual(result[0].rulePropositions[0].authorityIds, ['A1']);
  assert.deepEqual(result[0].appliedAuthorities, ['A1']);
  assert.deepEqual(result[0].assessments[0].authorityEvidenceIds, ['A1']);
  assert.equal(result[0].assessments[0].ruleStatus, 'VERIFIED');
  assert.equal(result[0].assessments[0].factStatus, 'UNKNOWN');
  assert.equal(exactAuthorityMatch(result[0].elements[0].text, entries.get('A2')), false);
  assert.equal(exactAuthorityMatch('선량한 풍속 기타 사회질서에 반하는 법률행위는 무효다.', entries.get('A1')), false);
  assert.equal(exactAuthorityMatch('저작재산권을 전부 양도해도 2차적저작물 작성권은 별도로 추정한다.',
    { lawName: '저작권법', articleNo: '14' }), false);
});

test('미확인 근거는 명제의 표시 근거가 되지 않는다', () => {
  const registry = { get: () => ({ kind: 'ARTICLE', lawName: '민법', articleNo: '103', text: '원문', official: true, inForce: true }) };
  const result = [{ issueId: 'I1', elements: [{ id: 'E1', text: '사회질서에 반하는 법률행위는 무효다.' }],
    assessments: [{ elementId: 'E1', evidenceIds: ['A1'], factIds: [] }], conclusion: { decidingElementIds: [] } }];
  attachVerifiedRules(result, [{ issueId: 'I1', elementId: 'E1', checks: [{ evidenceId: 'A1', entailment: null }] }], registry);
  assert.deepEqual(result[0].appliedAuthorities, []);
  assert.equal(result[0].rulePropositions[0].verified, false);
});

test('결론 요건의 PARTIAL 근거는 미검증으로 두고 부수 요건의 PARTIAL만 경고와 함께 보존한다', () => {
  const registry = { get: () => ({ kind: 'ARTICLE', lawName: '민법', articleNo: '398', text: '원문', official: true, inForce: true }) };
  const result = [{ issueId: 'I1', elements: [
    { id: 'E1', text: '결론 요건' }, { id: 'E2', text: '부수 요건' }],
    assessments: [{ elementId: 'E1', factIds: [] }, { elementId: 'E2', factIds: [] }],
    conclusion: { decidingElementIds: ['E1'] } }];
  const ledger = ['E1', 'E2'].map(elementId => ({ issueId: 'I1', elementId,
    checks: [{ evidenceId: 'A1', entailment: 'PARTIAL' }] }));
  attachVerifiedRules(result, ledger, registry);
  assert.equal(result[0].rulePropositions[0].verificationStatus, 'UNVERIFIED');
  assert.equal(result[0].rulePropositions[1].verificationStatus, 'VERIFIED');
  assert.deepEqual(result[0].assessments[0].authorityEvidenceIds, []);
  assert.deepEqual(result[0].assessments[1].authorityEvidenceIds, ['A1']);
});

test('종합 입력은 조문 전문과 검색 후보를 싣지 않고 쟁점별로 제한한다', () => {
  const issues = Array.from({ length: 10 }, (_, n) => ({ id: `I${n + 1}`, question: '계약 위험'.repeat(100) }));
  const results = issues.map(issue => ({ issueId: issue.id, appliedAuthorities: ['A1'],
    elements: [{ id: 'E1', text: '요건'.repeat(100) }], conclusion: { legal: 'CONDITIONAL', decidingElementIds: ['E1'] } }));
  const compact = compactSynthesisIssues(issues, results);
  assert.equal(compact.split('\n').length, 10);
  assert.ok(compact.split('\n').every(line => line.length <= 900));
  assert.doesNotMatch(compact, /researchCandidates|evidenceText/);
});

test('종합 모델이 쟁점 수를 잘못 쓰거나 내부 번호를 노출하면 검증된 요약으로 교정한다', () => {
  const issues = Array.from({ length: 10 }, (_, n) => ({ id: `I${n + 1}` }));
  const results = issues.map(issue => ({ issueId: issue.id, stageStatus: 'PARTIAL', conclusion: { legal: 'CONDITIONAL' } }));
  const summary = contractExecutiveSummary(issues, results,
    [{ label: '지체상금', facialRisk: 'HIGH' }], '8개 계약 쟁점(I1, I2)을 검토했습니다.');
  assert.match(summary, /10개 쟁점/);
  assert.doesNotMatch(summary, /\bI\d+\b|8개/);
});

test('내보내기 직전 UI 토큰과 처리되지 않은 Markdown을 제거한다', () => {
  const text = sanitizeExportText('### 제목\n**중요** merge_type flag gavel rate_review checklist\n| 항목 | 결과 |\n| --- | --- |\n| A | B |');
  assert.match(text, /제목.*중요/s);
  assert.doesNotMatch(text, /\b(?:merge_type|flag|gavel|rate_review|checklist)\b|^#{1,6}\s|\|\s*-{3,}|\*\*/m);
});

test('PDF를 다시 추출해 내부 UI 토큰과 Markdown 노출을 검사한다', async () => {
  const pdf = await generatePdf({ title: '민법 검토의견서',
    contentMarkdown: '# 계약서 법률검토의견서\n## 1. 검토 요약\n### 핵심\n**위험** merge_type flag gavel rate_review checklist\n| 항목 | 결과 |\n| --- | --- |\n| 대금 | 확인 |',
    reviewData: { meta: { preset: 'contract_risk', query: '계약 샘플', governingLaws: ['민법', '민사소송법'] },
      review: { summary: '요약', legalBasis: [], recommendations: [] } } });
  const extracted = (await pdfParse(pdf)).text;
  assert.match(extracted, /계약서 법률검토의견서/);
  assert.doesNotMatch(extracted, /1\. 검토 배경 및 질의 요지|2\. 법률적 쟁점 및 심층 검토 의견|3\. 리스크 평가 및 보완 조치 사항/);
  assert.doesNotMatch(extracted, /\b(?:merge_type|flag|gavel|rate_review|checklist)\b|^#{1,6}\s|\|\s*-{3,}|\*\*/m);
});
