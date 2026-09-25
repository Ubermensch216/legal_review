// 실제 계약 샘플(02)의 검토 JSON을 독립적인 수용 기준으로 채점한다.
// node test/benchmark/contractAcceptance.js <staged-02-1.json>
import fs from 'node:fs';
import { exactAuthorityMatch } from '../../server/reasoning/verifiedRules.js';

const input = process.argv[2];
if (!input) throw new Error('검토 JSON 경로를 지정하십시오.');
const { review } = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!review?.reasoning) throw new Error('단계형 검토 결과가 필요합니다.');

const expectedKinds = [
  'SCOPE_CHANGE', 'DELAY_DAMAGES', 'CONTRACTUAL_PENALTY', 'TERMINATION',
  'LIABILITY', 'INTELLECTUAL_PROPERTY', 'PERSONNEL_DIRECTION',
  'VENUE_AGREEMENT', 'DISPUTE_WAIVER', 'PAYMENT_TERMS'
];
const expectedLaws = ['민법', '약관의 규제에 관한 법률', '저작권법', '파견근로자 보호 등에 관한 법률', '민사소송법'];
const findings = review.contractFindings || [];
const issues = review.reasoning.issues || [];
const evidence = new Map((review.reasoning.evidence || []).map(e => [e.id, e]));
const authorityIds = findings.flatMap(f => f.authorityEvidenceIds || []);
const warrants = review.reasoning.warrants || [];
const supportedAuthority = (issueId, id) => warrants.some(w => w.issueId === issueId
  && (w.checks || []).some(c => c.evidenceId === id && ['SUPPORTS', 'PARTIAL'].includes(c.entailment)
    && exactAuthorityMatch(w.text, evidence.get(evidence.get(id)?.parentId) || evidence.get(id))));
const appliedPairs = findings.flatMap(f => (f.authorityEvidenceIds || []).map(id => ({ issueId: f.issueId, id })));
const redlined = new Set((review.redlineDiffs || []).flatMap(d => d.issueIds || []));
const riskIds = new Set(findings.filter(f => ['HIGH', 'MEDIUM'].includes(f.facialRisk)).map(f => f.issueId));
const text = [review.summary, review.legalOpinion, review.draftOpinion, ...(review.furtherChecks || [])].join('\n');
const falseAbsence = text.match(/D\d+(?:\.\d+)?[^.!?\n]{0,80}(?:내용이 없|확인할 수 없|제시되지 않|자료에 포함되지 않|구체적 내용이 없)/g) || [];
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const detected = new Set(findings.filter(f => f.facialRisk !== 'NONE').map(f => f.kind));
const retrieved = new Set([...evidence.values()].filter(e => e.official && e.inForce && e.kind === 'ARTICLE').map(e => e.lawName));
const expectedMissing = { CONFIDENTIALITY: 'ABSENT', INFORMATION_SECURITY: 'ABSENT',
  CHANGE_CONTROL: 'PRESENT_BUT_DEFICIENT', DELAY_CAP: 'PRESENT_BUT_DEFICIENT',
  LIABILITY_CAP: 'PRESENT_BUT_DEFICIENT', TERMINATION_SETTLEMENT: 'PRESENT_BUT_DEFICIENT',
  BACKGROUND_IP: 'PRESENT_BUT_DEFICIENT' };
const missing = new Map((review.missingClauseAudit || []).map(item => [item.kind, item.status]));
const quality = review.reasoning.diagnostics?.contract || {};
const result = {
  issueRecall: ratio(expectedKinds.filter(kind => detected.has(kind)).length, expectedKinds.length),
  documentLinkRate: ratio(issues.filter(i => i.documentIds?.some(id => evidence.has(id))).length, issues.length),
  authorityRecall: ratio(expectedLaws.filter(name => retrieved.has(name)).length, expectedLaws.length),
  authorityOfficialRate: ratio(authorityIds.filter(id => evidence.get(id)?.official && evidence.get(id)?.inForce).length,
    authorityIds.length),
  authorityPrecision: ratio(appliedPairs.filter(({ issueId, id }) => evidence.get(id)?.official
    && evidence.get(id)?.inForce && supportedAuthority(issueId, id)).length, appliedPairs.length),
  ruleAuthorityAccuracy: quality.ruleAuthorityAccuracy ?? null,
  elementRelevance: quality.elementRelevance ?? null,
  warrantSupportRate: ratio(warrants.filter(w => w.overall === 'SUPPORTED').length, warrants.length),
  documentWarrantSupportRate: ratio((review.reasoning.documentWarrants || []).filter(w => w.overall === 'SUPPORTED').length,
    (review.reasoning.documentWarrants || []).length),
  missingClauseRecall: Number((review.missingClauseAdditions || []).some(m => m.kind === 'CONFIDENTIALITY')),
  missingClauseClassificationAccuracy: ratio(Object.entries(expectedMissing).filter(([kind, status]) => missing.get(kind) === status).length,
    Object.keys(expectedMissing).length),
  redlineCoverage: ratio([...riskIds].filter(id => redlined.has(id)).length, riskIds.size),
  synthesisSuccessRate: quality.synthesisSuccessRate ?? null,
  reportCompressionRatio: quality.reportCompressionRatio ?? null,
  contradictionRate: ratio(falseAbsence.length, Math.max(findings.length, 1)),
  falseAbsence,
  reviewStatus: review.reviewStatus,
  gate: review.reasoning.gate
};
console.log(JSON.stringify(result, null, 2));
