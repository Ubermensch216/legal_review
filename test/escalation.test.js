import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ENV } from '../server/env.js';
import { setExternalTransmissionPolicyForTests } from '../server/reasoning/externalGate.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { computeIssueConclusion } from '../server/reasoning/verify/conclusion.js';
import { buildSanitizedRequest, EscalationError, previewEscalation, runEscalation, selectEscalationCandidates } from '../server/reasoning/escalation.js';
import { recallReview, rememberReview } from '../server/reasoning/reviewSessionStore.js';
import { auditLogPath, readExternalAudit } from '../server/privacy/auditLog.js';

const realFetch = globalThis.fetch;
const realKey = ENV.EXAONE_API_KEY;
afterEach(() => { globalThis.fetch = realFetch; ENV.EXAONE_API_KEY = realKey; setExternalTransmissionPolicyForTests(() => true); });

const OFFICIAL = { source: 'OFFICIAL_API' };
const law = '개인정보 보호법';
const documentText = '제1조(목적)\n담당 홍길동 과장(010-1234-5678)은 정보주체의 동의 없이 개인정보를 수집하였다.';
const registry = buildEvidenceRegistry({ meta: { primaryLawName: law, asOfDate: '20260923' },
  officialEvidence: { lawDetail: { ...OFFICIAL, lawName: law }, articles: [{ ...OFFICIAL, lawName: law, fullArticleNo: '15', title: '수집·이용',
    enforceDate: '20200101', content: '', paragraphs: [{ paragraphNo: '①', content: '정보주체의 동의를 받은 경우 개인정보를 수집할 수 있다.' }] }] } }, { documentText });
const articleId = registry.ids(e => e.kind === 'ARTICLE')[0];
const unitId = registry.children(articleId)[0].id;
const documentId = registry.ids(e => e.kind === 'DOCUMENT')[0];
const element = { id: `${articleId}.E1`, text: '정보주체의 동의를 받을 것', mandatory: true, isException: false, sourceIds: [articleId] };
const open = { elementId: element.id, status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [], contraryFactIds: [], evidenceIds: [], analysis: '', openQuestion: '' };
const issue = { id: 'I1', question: '홍길동 과장의 수집이 적법한가?', type: 'PRIMARY', priority: 'HIGH', dependsOn: [], factIds: ['F1'], evidenceIds: [articleId], searchTerms: [] };
const follower = { ...element, id: 'x.E1' };
const satisfied = { ...open, elementId: 'x.E1', status: 'SATISFIED', proof: 'SUFFICIENT' };

const makeContext = () => ({
  caseIssues: { issues: [issue, { ...issue, id: 'I2', question: '후속 쟁점', dependsOn: ['I1'], factIds: [] }],
    facts: [{ id: 'F1', text: '홍길동 과장(010-1234-5678)이 동의 없이 수집', status: 'CONFIRMED', docRef: documentId, quote: '', quoteVerified: true }], unknownFacts: [] },
  issueResults: [
    { issueId: 'I1', elements: [element], assessments: [open], conclusion: computeIssueConclusion([element], [open]), stageStatus: 'PARTIAL',
      precedents: [], counter: null, narrative: '', openQuestions: [], omittedEvidence: [], warnings: [], gateReasons: [] },
    { issueId: 'I2', elements: [follower], assessments: [satisfied],
      conclusion: computeIssueConclusion([follower], [satisfied], [{ issueId: 'I1', legal: 'CONDITIONAL' }]), stageStatus: 'OK',
      precedents: [], counter: null, narrative: '', openQuestions: [], omittedEvidence: [], warnings: [], gateReasons: [] }],
  registry, preset: 'privacy_security', gaps: [], ledger: [], redlines: [], contractFindings: [], missingClauseAdditions: [], missingClauseAudit: [],
  contractRegime: null, synthesis: { summary: '기존 요약', risks: [], recommendations: [], table: '' },
  research: { I1: { evidenceIds: [articleId], adverseCandidateIds: [], documentIds: [documentId], candidates: [], queries: [] },
    I2: { evidenceIds: [], adverseCandidateIds: [], documentIds: [], candidates: [], queries: [] } } });

const sse = payload => ({ ok: true, status: 200, body: (async function* () {
  yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
})() });

test('어려운 쟁점만 골라 제안하고, 근거가 없거나 이미 판단된 쟁점은 뺀다', () => {
  const ctx = makeContext();
  const picks = selectEscalationCandidates({ issues: ctx.caseIssues.issues, issueResults: ctx.issueResults });
  assert.deepEqual(picks.map(p => p.issueId), ['I1']);
  assert.ok(picks[0].reasons.some(r => /결론 요건 1개를 판단하지 못함/.test(r)));
});

test('전송 내용은 식별정보를 가린 사본이고, 같은 입력이면 해시가 같다', () => {
  const ctx = makeContext();
  const a = buildSanitizedRequest(ctx, 'I1', { provider: 'exaone' });
  const b = buildSanitizedRequest(ctx, 'I1', { provider: 'exaone' });
  assert.equal(a.digest, b.digest);
  assert.ok(!a.material.includes('홍길동') && !a.material.includes('010-1234-5678'));
  assert.deepEqual(a.remaining, []);
  assert.ok(a.replacements >= 2);
  assert.notEqual(buildSanitizedRequest(ctx, 'I1', { provider: 'exaone', terms: ['정보주체'] }).digest, a.digest);
  assert.equal(previewEscalation(ctx, 'I1', { provider: 'exaone' }).digest, a.digest);
});

test('승인한 해시로만 전송하고, 외부 답변은 원래 값으로 복원해 결론을 코드가 다시 계산한다', async () => {
  setExternalTransmissionPolicyForTests(null);
  ENV.EXAONE_API_KEY = 'test-key';
  const ctx = makeContext();
  const { digest, text } = previewEscalation(ctx, 'I1', { provider: 'exaone' });
  const token = text.match(/\[비공개_\d+\]/)?.[0] || '[비공개_1]';
  const sent = [];
  const answer = { assessments: [{ elementId: element.id, verdict: 'VIOLATES', quote: '동의 없이 개인정보를 수집하였다', factIds: ['F1'], contraryFactIds: [],
    evidenceIds: [unitId], analysis: `${token} 과장의 수집에는 동의가 없었다`, openQuestion: '' }], precedents: [],
  counter: { position: '', evidenceIds: [], response: '' }, narrative: '' };
  globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return sse(answer); };
  await assert.rejects(() => runEscalation({ ctx, issueId: 'I1', provider: 'exaone', model: 'k-exaone_v2.5', digest: 'x'.repeat(64) }),
    err => err instanceof EscalationError && err.code === 'DIGEST_MISMATCH');
  assert.equal(sent.length, 0, '해시가 다르면 아무것도 보내지 않는다');

  const result = await runEscalation({ ctx, issueId: 'I1', provider: 'exaone', model: 'k-exaone_v2.5', digest });
  assert.ok(sent.length >= 1);
  const outgoing = JSON.stringify(sent);
  assert.ok(!outgoing.includes('홍길동') && !outgoing.includes('010-1234-5678'), '전송문에 식별정보가 없다');
  assert.equal(result.before.legal, 'CONDITIONAL');
  assert.deepEqual([result.after.legal, result.after.compliance], ['NOT_APPLICABLE', 'VIOLATION_RISK']);
  const record = result.reasoningPatch.issues.find(i => i.id === 'I1');
  assert.match(record.assessments[0].analysis, /^홍길동 과장의 수집/, '답변의 대체 표기를 복원한다');
  assert.equal(record.assessments[0].origin, 'EXTERNAL');
  assert.equal(record.source, 'EXTERNAL');
  assert.equal(result.reasoningPatch.issues.find(i => i.id === 'I2').conclusion.legal, 'APPLIES', '선결 쟁점이 풀리면 후속 쟁점 결론도 갱신된다');
  assert.match(result.reviewPatch.summary, /\[외부 LLM 재검토 반영\] 쟁점 1: 판단 유보 → 위반 소지/);
  assert.ok(record.gateReasons.some(r => /외부 LLM 답변이 반영됨/.test(r)));
  assert.ok(fs.existsSync(auditLogPath()));
  const audit = readExternalAudit();
  assert.ok(audit.some(e => e.purpose === 'ISSUE_ESCALATION' && e.digest === digest));
  assert.ok(!JSON.stringify(audit).includes('홍길동'), '감사 기록에는 내용이 남지 않는다');
});

test('검토 세션은 보관했다가 꺼내고, 모르는 ID는 없는 것으로 본다', () => {
  const id = rememberReview({ ok: true });
  assert.deepEqual(recallReview(id), { ok: true });
  assert.equal(recallReview('없는-세션'), null);
});
