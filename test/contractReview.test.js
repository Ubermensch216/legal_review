import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument } from '../server/parsers/index.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { attachContractInventory, buildContractInventory, contractAssessments, detectContractLawSeeds, scoreContractRisk } from '../server/reasoning/contractReview.js';
import { verifyDocumentFindings } from '../server/reasoning/verify/warrant.js';
import { deriveGaps } from '../server/reasoning/stages/gaps.js';
import { ensureOperationalRedline, normalizeTableRedline, renderReview } from '../server/reasoning/stages/synthesis.js';
import { runReasoningPipeline } from '../server/reasoning/pipeline.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { ollamaStream } from './llmStreamStub.js';
import { ENV } from '../server/env.js';
import { applyIssue } from '../server/reasoning/stages/application.js';
import { resolveBudget } from '../server/law/llmBudget.js';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';

const sample = async () => {
  const buffer = await readFile(new URL('./docs/review-samples/02_정보시스템_구축_용역계약서.docx', import.meta.url));
  const parsed = await parseDocument(buffer, 'sample.docx');
  const registry = buildEvidenceRegistry({}, { documentText: parsed.text });
  const inventory = buildContractInventory(registry, '비밀유지 의무의 적정성도 검토');
  return { parsed, registry, inventory };
};

test('계약 샘플의 위험 조항·지급 별표·비밀유지 부재를 원문 D와 연결한다', async () => {
  const { parsed, registry, inventory } = await sample();
  const kinds = inventory.findings.map(f => f.kind);
  for (const kind of ['SCOPE_CHANGE', 'DELAY_DAMAGES', 'CONTRACTUAL_PENALTY', 'TERMINATION', 'LIABILITY',
    'INTELLECTUAL_PROPERTY', 'PERSONNEL_DIRECTION', 'DISPUTE_WAIVER', 'PAYMENT_TERMS']) {
    assert.ok(kinds.includes(kind), kind);
  }
  assert.deepEqual(inventory.findings.filter(f => ['DELAY_DAMAGES', 'CONTRACTUAL_PENALTY'].includes(f.kind))
    .map(f => f.documentSupportIds[0]), ['D5', 'D5']);
  assert.equal(registry.get(inventory.findings.find(f => f.kind === 'PAYMENT_TERMS').documentSupportIds[0]).label,
    '첨부문서 별표(대금 지급 일정)');
  assert.equal(inventory.missingClauseAdditions[0].kind, 'CONFIDENTIALITY');
  for (const finding of inventory.findings) {
    const span = finding.sourceSpans[0];
    assert.equal(parsed.text.slice(span.start, span.end), finding.sourceText);
  }
  const payment = inventory.findings.find(f => f.kind === 'PAYMENT_TERMS');
  const lastPayment = payment.sourceSpans[0].tableCells.find(c => c.value === '검수 완료 후 90일');
  assert.equal(parsed.text.slice(lastPayment.start, lastPayment.end), lastPayment.value);
  assert.equal(lastPayment.row, 4);
});

test('존재하지만 불충분한 조항과 실제 부재 조항을 구분하고 관할 문제를 분리한다', async () => {
  const { inventory } = await sample();
  const status = kind => inventory.missingClauseAudit.find(item => item.kind === kind);
  assert.equal(status('CONFIDENTIALITY').status, 'ABSENT');
  for (const kind of ['CHANGE_CONTROL', 'LIABILITY_CAP', 'DELAY_CAP', 'TERMINATION_SETTLEMENT', 'BACKGROUND_IP']) {
    assert.equal(status(kind).status, 'PRESENT_BUT_DEFICIENT', kind);
    assert.ok(status(kind).documentIds.length, kind);
  }
  assert.ok(inventory.findings.some(f => f.kind === 'VENUE_AGREEMENT'));
  assert.ok(inventory.findings.some(f => f.kind === 'DISPUTE_WAIVER'));
});

test('S1이 쟁점을 5개만 반환해도 계약 후보를 삭제하지 않고 검증된 문서 사실로 연결한다', async () => {
  const { registry, inventory } = await sample();
  const caseIssues = attachContractInventory({ facts: [], issues: [], unknownFacts: [], diagnostics: {} }, inventory, registry);
  assert.equal(caseIssues.issues.length, 10);
  assert.equal(caseIssues.facts.filter(f => f.sourceType === 'DOCUMENT').length, 8);
  for (const issue of caseIssues.issues) {
    assert.ok(issue.factIds.length);
    assert.ok(issue.documentIds.length);
    const fact = caseIssues.facts.find(f => f.id === issue.factIds[0]);
    assert.equal(fact.text, registry.get(issue.documentIds[0]).text);
    assert.equal(fact.quoteVerified, true);
  }
  const result = caseIssues.issues.map(issue => ({ issueId: issue.id, stageStatus: 'SKIPPED', assessments: [],
    conclusion: { legal: 'CONDITIONAL', proof: 'NO_EVIDENCE', decidingElementIds: [] } }));
  const findings = contractAssessments(caseIssues.issues, result, inventory, registry);
  assert.ok(findings.every(f => f.analysisMode === 'HYBRID'));
  assert.ok(findings.every(f => f.facialAssessment.documentSupportIds.length > 0));
  assert.ok(findings.every(f => f.legalAssessment.status === 'AUTHORITY_INCOMPLETE'));
  assert.ok(findings.every(f => f.documentConclusion.status === 'CONFIRMED'));
  assert.ok(findings.every(f => f.facialRiskConclusion.status === 'CONFIRMED'));
  assert.equal(findings.find(f => f.kind === 'INTELLECTUAL_PROPERTY').ipDimensions.length, 8);
  assert.equal(verifyDocumentFindings(findings, registry).filter(w => w.overall === 'SUPPORTED').length, 10);
  assert.equal(verifyDocumentFindings([{ ...findings[0], documentFinding: '원문에 없는 주장' }], registry)[0].overall,
    'NOT_SUPPORTED');
  assert.ok(findings.every(f => f.legalValidity === 'AUTHORITY_INCOMPLETE'));
  const review = renderReview({ caseIssues, issueResults: result,
    synthesis: { summary: 'D4의 구체적 내용이 없다. 요약', table: '', risks: [], recommendations: [] },
    gaps: [], registry, preset: 'contract_risk', contractFindings: findings,
    missingClauseAdditions: inventory.missingClauseAdditions });
  assert.match(review.legalOpinion, /직접 인력 지휘/);
  assert.equal((review.legalOpinion.match(/문언 판단:/g) || []).length, caseIssues.issues.length);
  assert.equal((review.legalOpinion.match(/법적 판단:/g) || []).length, caseIssues.issues.length);
  assert.equal((review.legalOpinion.match(/추가 확인사항:/g) || []).length, caseIssues.issues.length);
  assert.doesNotMatch(review.legalOpinion, /판단 미확정 요건: 출처를 확인하지 못한 자료|해당 쟁점의 판단 단계가 완료되지 않았습니다/);
  assert.match(review.legalOpinion, /도급 또는 도급적 요소인 경우.*민법 제673조/);
  assert.equal(findings.find(f => f.kind === 'PERSONNEL_DIRECTION').facialRiskConclusion.level, 'HIGH');
  assert.equal(findings.find(f => f.kind === 'INTELLECTUAL_PROPERTY').additionalFactDetails[0].materiality, 'SCOPE_ONLY');
  assert.match(review.draftOpinion, /비밀유지 조항 부재/);
  assert.doesNotMatch(review.legalOpinion, /D[4-9].{0,30}내용이 없다/);
  assert.doesNotMatch(review.draftOpinion, /D4의 구체적 내용이 없다/);
});

test('계약 문언이 연결된 쟁점은 일반 입증 질문을 만들지 않고 관련 법률 후보를 분기한다', async () => {
  const { parsed } = await sample();
  const laws = detectContractLawSeeds(parsed.text).map(x => x.name);
  assert.ok(laws.includes('민법'));
  assert.ok(laws.includes('저작권법'));
  assert.ok(laws.includes('파견근로자 보호 등에 관한 법률'));
  const gaps = deriveGaps({ contractMode: true,
    issues: [{ id: 'I1', type: 'PRIMARY', priority: 'HIGH', question: '문언 위험?', documentIds: ['D4'] }],
    issueResults: [{ issueId: 'I1', stageStatus: 'OK', conclusion: { decidingElementIds: ['A1.E1'] },
      elements: [{ id: 'A1.E1', text: '요건' }], assessments: [{ elementId: 'A1.E1', status: 'UNKNOWN',
        proof: 'INSUFFICIENT', evidenceIds: [], openQuestion: '' }] }] });
  assert.ok(!gaps.some(g => g.type === 'FACT_UNKNOWN'));
});

test('존재하는 비밀유지 조항은 누락으로 표시하지 않는다', () => {
  const text = '제1조(목적) 정보시스템 구축 용역을 정한다.\n제2조(비밀유지) 양 당사자는 계약상 비밀정보를 제3자에게 공개하지 않는다.';
  const registry = buildEvidenceRegistry({}, { documentText: text });
  const inventory = buildContractInventory(registry, '비밀유지 검토');
  assert.equal(inventory.missingClauseAudit.find(c => c.kind === 'CONFIDENTIALITY').status, 'ADEQUATE');
  assert.ok(!inventory.missingClauseAdditions.some(c => c.kind === 'CONFIDENTIALITY'));
});

test('기존 기술을 원 권리자에게 남기는 조항은 위험한 IP 귀속으로 오인하지 않는다', () => {
  const text = '제1조(지식재산권) 을의 기존 범용 모듈은 을에게 존속하고, 갑은 사업 목적의 이용권을 가진다.';
  const inventory = buildContractInventory(buildEvidenceRegistry({}, { documentText: text }), '시스템 구축 계약 검토');
  assert.ok(!inventory.findings.some(f => f.kind === 'INTELLECTUAL_PROPERTY'));
});

test('지급 별표 수정안은 원문과 동일한 열 수를 유지한다', async () => {
  const { registry } = await sample();
  const original = registry.get('D11').text;
  const revised = '### [별표] 대금 지급 일정\n| 구분 | 지급 시기 | 지급 비율 | 금액(원) | 지급 조건 |\n| --- | --- | --- | --- | --- |\n| 잔금 | 검수 후 30일 | 40% | 480,000,000 | 합의한 공제액 반영';
  const normalized = normalizeTableRedline(revised, original);
  assert.match(normalized, /합의한 공제액 반영 \|$/);
  assert.equal(normalizeTableRedline('| 잔금 | 조건 부족 |', original), null);
});

test('편의해지에 시정기간을 잘못 부여한 수정안은 정산 가능한 문안으로 바꾼다', () => {
  const checked = ensureOperationalRedline('사업계획 변경 시 수급인에게 30일의 시정기간을 부여한다.', ['TERMINATION']);
  assert.equal(checked.substituted, true);
  assert.match(checked.text, /기성대가/);
  assert.match(checked.text, /사전 서면통지/);
  assert.doesNotMatch(checked.text, /사업계획 변경.{0,35}시정기간/);
});

test('공식 근거가 없으면 높은 문언 위험을 법적 위반 확정으로 올리지 않는다', () => {
  const finding = { kind: 'PAYMENT_TERMS', facialRisk: 'HIGH', documentSupportIds: ['D11'], authorityEvidenceIds: [] };
  const score = scoreContractRisk(finding, { institutionType: 'UNKNOWN' });
  assert.equal(score.legalInvalidityRisk, 'UNRATED');
  assert.equal(score.finalLevel, 'HIGH_CANDIDATE');
  assert.equal(score.confidence, 'MEDIUM');
});

test('기본 검토의 규칙 기반 폴백에도 문서 위험과 누락조항이 포함된다', async () => {
  const { parsed } = await sample();
  const review = await generateLegalReview({ query: '계약서 위험과 비밀유지 누락을 검토',
    preset: 'contract_risk', documentText: parsed.text,
    workbenchContext: { meta: { asOfDate: '20260925' }, officialEvidence: {} },
    llmConfig: { provider: 'rule_based' } });
  assert.equal(review.contractFindings.length, 10);
  assert.ok(review.missingClauseAdditions.some(m => m.kind === 'CONFIDENTIALITY'));
  assert.match(review.legalOpinion, /대금 지급 조건/);
});

test('계약 조항만으로 실제 사건 요건을 확정하지 않고 시스템 지침형 반론을 버린다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith('/api/tags')
    ? { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) }
    : ollamaStream(JSON.stringify({ reasoning: '', narrative: '계약에 위약벌이 적혀 있다 [D1].',
      assessments: [{ elementId: 'A1.E1', status: 'SATISFIED', proof: 'SUFFICIENT', factIds: ['DF1'], contraryFactIds: [],
        evidenceIds: ['A1'], documentSupportIds: ['D1'], analysis: '계약상 위약벌 약정이 있다', openQuestion: '' }],
      precedents: [], counter: { position: '자료로 확인되지 않는 내용은 추측하지 않고 모른다고 표시한다',
        evidenceIds: ['A1'], response: '' } }));
  try {
    const documentText = '제1조(위약벌) 을은 계약금액의 3배를 위약벌로 지급한다.';
    const registry = buildEvidenceRegistry({ meta: { primaryLawName: '민법' }, officialEvidence: {
      articles: [{ source: 'OFFICIAL_API', lawName: '민법', fullArticleNo: '398',
        content: '제398조(배상액의 예정) 당사자는 채무불이행에 관한 손해배상액을 예정할 수 있다.', paragraphs: [] }]
    } }, { documentText });
    const fact = { id: 'DF1', text: registry.get('D1').text, status: 'CONFIRMED', sourceType: 'DOCUMENT',
      docRef: 'D1', quoteVerified: true };
    const result = await applyIssue({ issue: { id: 'I1', question: '위약벌 위험은?', factIds: ['DF1'] },
      elements: [{ id: 'A1.E1', text: '실제 채무불이행이 발생했을 것', mandatory: true, isException: false, sourceIds: ['A1'] }],
      research: { evidenceIds: ['A1'], adverseCandidateIds: [], documentIds: ['D1'] },
      registry, facts: [fact], runPrefix: '[검토 기준일] 20260925', provider: 'ollama',
      config: { budget: resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, outputTokens: 3072 }), think: false },
      session: createLlmSession(), contractMode: true });
    assert.equal(result.conclusion.legal, 'CONDITIONAL');
    assert.deepEqual(result.assessments[0].documentSupportIds, ['D1']);
    assert.equal(result.counter, null);
  } finally { globalThis.fetch = originalFetch; }
});

test('저작재산권 양도 명제는 모델이 잘못 고른 제14조 대신 원 출처 제45조로 검증한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('/api/tags')
    ? { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) }
    : ollamaStream(JSON.stringify({ reasoning: '', narrative: '',
      assessments: [{ elementId: 'A2.E1', status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [],
        contraryFactIds: [], evidenceIds: ['A1'], analysis: '추가 확인', openQuestion: '' }],
      precedents: [], counter: { position: '', evidenceIds: [], response: '' } }));
  try {
    const registry = buildEvidenceRegistry({ meta: { primaryLawName: '저작권법' }, officialEvidence: { articles: [
      { source: 'OFFICIAL_API', lawName: '저작권법', fullArticleNo: '14', content: '제14조(저작인격권의 일신전속성) 저작인격권은 저작자 일신에 전속한다.', paragraphs: [] },
      { source: 'OFFICIAL_API', lawName: '저작권법', fullArticleNo: '45', content: '제45조(저작재산권의 양도) 저작재산권은 전부 또는 일부를 양도할 수 있다.', paragraphs: [] }
    ] } });
    const result = await applyIssue({ issue: { id: 'I1', question: '저작재산권 양도?', factIds: [] },
      elements: [{ id: 'A2.E1', text: '저작재산권을 양도할 수 있다.', mandatory: true, isException: false, sourceIds: ['A2'] }],
      research: { evidenceIds: ['A1', 'A2'], adverseCandidateIds: [], documentIds: [] },
      registry, facts: [], runPrefix: '[검토 기준일] 20260925', provider: 'ollama',
      config: { budget: resolveBudget('ollama', { model: ENV.OLLAMA_MODEL, outputTokens: 3072 }), think: false },
      session: createLlmSession(), contractMode: true });
    assert.deepEqual(result.assessments[0].evidenceIds, ['A2']);
  } finally { globalThis.fetch = originalFetch; }
});

test('단계형 전체 경로에서 S1이 한 쟁점만 내도 계약 위험과 누락조항을 보존한다', async () => {
  const { parsed } = await sample();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    const prompt = JSON.parse(options.body).messages[1].content;
    const value = prompt.includes('[과제: 사건 사실과 법률 쟁점 정리]') ? {
      facts: [], issues: [{ id: 'I1', question: '과업 변경 조항의 위험은 무엇인가?', type: 'PRIMARY',
        priority: 'HIGH', dependsOn: [], factIds: [], evidenceIds: [], searchTerms: ['과업 변경'] }], unknownFacts: []
    } : prompt.includes('[과제: 수정 조문 작성]') ? {
      revisedText: '위험을 줄이는 수정 문안', reason: '계약 문언의 불균형 완화', evidenceIds: []
    } : { summary: '계약 문언에 위험이 있다.', risks: [], recommendations: [] };
    return ollamaStream(JSON.stringify(value));
  };
  try {
    const review = await runReasoningPipeline({ query: '비밀유지 의무를 검토', preset: 'contract_risk',
      documentText: parsed.text, workbenchContext: { meta: { asOfDate: '20260925' }, officialEvidence: {} },
      provider: 'ollama', model: ENV.OLLAMA_MODEL, session: createLlmSession(),
      clients: { searchPrecedents: async () => [], searchInterpretations: async () => [] },
      embed: async texts => ({ vectors: texts.map(() => [1, 0]), warning: null }) });
    assert.equal(review.reasoning.issues.length, 10);
    assert.equal(review.reasoning.documentWarrants.length, 10);
    assert.ok(review.reasoning.documentWarrants.every(w => w.overall === 'SUPPORTED'));
    assert.ok(review.contractFindings.some(f => f.kind === 'PERSONNEL_DIRECTION'));
    assert.ok(review.contractFindings.some(f => f.kind === 'PAYMENT_TERMS'));
    assert.ok(review.missingClauseAdditions.some(m => m.kind === 'CONFIDENTIALITY'));
    assert.ok(review.redlineDiffs.length >= 7);
    assert.equal(review.reasoning.diagnostics.contract.documentLinkRate, 1);
    assert.equal(review.reasoning.diagnostics.contract.documentWarrantSupportRate, 1);
    assert.equal(review.reasoning.diagnostics.contract.synthesisSuccessRate, 1);
    assert.match(review.summary, /계약 문언에 위험/);
    const checked = `${review.legalOpinion}\n${review.draftOpinion}\n${review.furtherChecks.join('\n')}`;
    for (const pattern of [
      /D4의 구체적 내용이 없다/, /D5 조항이 제시되지 않았다/,
      /D6 조항의 내용을 확인할 수 없다/, /D7 조항이 자료에 포함되지 않았다/
    ]) assert.doesNotMatch(checked, pattern);
    assert.equal(review.reasoning.gate, 'HUMAN_REVIEW_REQUIRED');
  } finally { globalThis.fetch = originalFetch; }
});
