// Audit probes, not acceptance tests. These assertions reproduce defects at eaadebc.
// No external requests; all cache writes go to a newly created OS temporary directory.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.CACHE_DIR = mkdtempSync(path.join(tmpdir(), 'legal-audit-probes-'));
process.env.UPLOAD_DIR = path.join(process.env.CACHE_DIR, 'uploads');
process.env.LAW_OC = '';
globalThis.fetch = async () => { throw new Error('Audit forbids external requests'); };

const { ENV } = await import('../../server/env.js');
const { getCache, setCache, clearAllCache } = await import('../../server/law/lawCache.js');
const { getLawArticle, getLawDetail } = await import('../../server/law/lawApiClient.js');
const { verifyAndCorrectReviewCitations: verify } = await import('../../server/law/factualityVerifier.js');
const { generateLegalReview } = await import('../../server/law/lawWorkbenchReview.js');
const { buildWorkbenchContext } = await import('../../server/law/lawWorkbench.js');
const { optimizeDocumentContext } = await import('../../server/parsers/contextOptimizer.js');
const { normalizeArticleNo } = await import('../../server/law/lawArticleRef.js');
const { parseLawDetail } = await import('../../server/law/lawApiParser.js');
const { execute: timeTravel } = await import('../../server/law/tools/timeTravel.js');
const { retrieveCascadingHierarchy } = await import('../../server/law/cascadingRetriever.js');

const observations = [];
const record = (id, result) => { observations.push({ id, ...result }); console.log(id, JSON.stringify(result)); };
const article = { articleNo: '15', fullArticleNo: '15', title: 'fixture article', content: 'fixture article header', paragraphs: [{ paragraphNo: '1', content: 'NESTED_EXCEPTION_MARKER', items: [] }] };
const context = { meta: { primaryLawName: '개인정보 보호법', dataIntegrity: { sources: { articles: 'OFFICIAL_API' } } }, officialEvidence: { articles: [article] } };
const cite = async (lawName, articleNo, ctx = context) => (await verify({ review: { legalBasis: [{ lawName, articleNo }] }, workbenchContext: ctx })).verificationReport;

const prewarm = await getCache('law:search:개인정보 보호법:1:3');
assert.equal(prewarm[0].lawId, 'PREWARM_개인정보 보호법');
assert.equal(await getCache('search:개인정보 보호법:1:3'), null);
record('prewarm-invalid-id', { storedId: prewarm[0].lawId, actualSearchKeyMisses: true });

const crossLaw = await cite('존재하지않는감사전용법', '제15조');
assert.equal(crossLaw.citationConfidence, 100);
record('cross-law-false-verification', { confidence: crossLaw.citationConfidence, details: crossLaw.details });

const emptyContext = { meta: { primaryLawName: '개인정보 보호법', dataIntegrity: { sources: { articles: 'NONE' } } }, officialEvidence: { articles: [] } };
const mockVerification = await cite('개인정보 보호법', '제15조', emptyContext);
assert.equal(mockVerification.citationConfidence, 100);
record('secondary-mock-false-verification', { confidence: mockVerification.citationConfidence, measurable: mockVerification.isMeasurable });

assert.equal(normalizeArticleNo('제15조의2'), '15');
const wrongBranch = await getLawArticle('001552', '15', '999');
assert.equal(wrongBranch.article.fullArticleNo, '15');
const branchVerification = await cite('개인정보 보호법', '제15조의999');
assert.equal(branchVerification.citationConfidence, 100);
record('branch-number-collapsed', { normalized: normalizeArticleNo('제15조의2'), requestedBranch: '15의999', returnedArticle: wrongBranch.article.fullArticleNo, confidence: branchVerification.citationConfidence });

const futureVersion = { lawId: 'AUDIT_FUTURE', lawSeq: '101', lawName: '감사시점법', promulDate: '20200101', enforceDate: '20300101' };
await setCache('search:감사시점법:1:10', [futureVersion]);
await setCache('detail:AUDIT_FUTURE:101', { ...futureVersion, articles: [article] });
const future = await timeTravel({ lawName: '감사시점법', targetDate: '20250101' });
assert.equal(future.found, true);
record('future-version-applied', { targetDate: future.targetDate, appliedEnforceDate: future.appliedVersion.enforceDate, found: future.found });

ENV.LAW_OC = 'AUDIT_STUB_ONLY';
let capturedUrl;
globalThis.fetch = async (url) => { capturedUrl = new URL(url); return { ok: true, text: async () => '<법령><기본정보><법령명_한글>감사법</법령명_한글></기본정보></법령>' }; };
await getLawDetail('AUDIT_ID', 'AUDIT_OLD_VERSION');
assert.equal(capturedUrl.searchParams.get('MST'), null);
record('version-parameter-discarded', { ID: capturedUrl.searchParams.get('ID'), MST: capturedUrl.searchParams.get('MST') });
ENV.LAW_OC = '';

const longDocument = `제1조(일반) ${'일반 안내 문구. '.repeat(650)}\n제2조(면책) 모든 책임을 지지 않는다. LATE_RISK_MARKER`;
const optimized = optimizeDocumentContext({ documentText: longDocument, query: '면책', maxChars: 4500 });
assert.ok(optimized.optimizedText.length > 4500);
record('optimizer-budget-overflow', { budget: 4500, actualChars: optimized.optimizedText.length, selectedLateRisk: optimized.selectedChunks.some(c => c.content.includes('LATE_RISK_MARKER')) });

let prompt = '';
globalThis.fetch = async (_url, options) => { prompt = JSON.parse(options.body).messages[1].content; return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; };
const promptContext = structuredClone(context);
promptContext.officialEvidence.precedents = [{ caseNo: 'AUDIT_CASE', caseName: 'fixture', relevanceScore: 0, isMockData: true, summary: '' }];
promptContext.impactAndRevisions = { documentChunks: optimized.selectedChunks };
const emptyReview = await generateLegalReview({ query: '면책', preset: 'contract_risk', documentText: longDocument, workbenchContext: promptContext, llmConfig: { provider: 'openai', apiKey: 'AUDIT_STUB_ONLY' } });
assert.equal(prompt.includes('LATE_RISK_MARKER'), false);
assert.equal(prompt.includes('NESTED_EXCEPTION_MARKER'), false);
assert.ok(prompt.includes('관련도: 90점'));
assert.ok(prompt.includes('AUDIT_CASE'));
record('llm-prompt-loss-and-mock-label', { lateRiskIncluded: prompt.includes('LATE_RISK_MARKER'), nestedParagraphIncluded: prompt.includes('NESTED_EXCEPTION_MARKER'), zeroScoreDisplayedAs90: prompt.includes('관련도: 90점'), mockCaseUnderOfficialHeading: prompt.includes('[수집 및 시맨틱 Re-ranking된 대법원 판례]') && prompt.includes('AUDIT_CASE'), mockWarningIncluded: /목업|샘플|MOCK/.test(prompt) });
assert.equal(emptyReview.isFallback, false);
assert.equal(emptyReview.factualityVerification.citationConfidence, 100);
record('empty-json-accepted-as-verified-review', { isFallback: emptyReview.isFallback, summary: emptyReview.summary, opinion: emptyReview.legalOpinion, addedCitations: emptyReview.legalBasis.length, confidence: emptyReview.factualityVerification.citationConfidence });

const fallback = await generateLegalReview({ query: '계약 문구 점검', preset: 'compliance', documentText: '', workbenchContext: context, llmConfig: { provider: 'rule_based' } });
assert.ok(fallback.legalOpinion.includes('원천 무효'));
record('fallback-retains-legal-conclusions', { isFallback: fallback.isFallback, opinionDeclaresInvalidity: fallback.legalOpinion.includes('원천 무효'), draftDeclaresInvalidity: fallback.draftOpinion.includes('원천 무효') });

const wrongLaw = await buildWorkbenchContext({ targetLaw: '개인정보 보호법 시행령' });
assert.equal(wrongLaw.meta.primaryLawName, '개인정보 보호법');
record('decree-replaced-by-parent-law', { requested: '개인정보 보호법 시행령', actual: wrongLaw.meta.primaryLawName });

await clearAllCache();
ENV.LAW_OC = 'AUDIT_STUB_ONLY';
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const body = u.pathname.endsWith('lawSearch.do') && u.searchParams.get('target') === 'law'
    ? '<LawSearch><law><법령ID>AUDIT_ERROR</법령ID><법령명한글>감사오류법</법령명한글><법령구분명>법률</법령구분명></law></LawSearch>'
    : '<html><body>API_ERROR_FIXTURE</body></html>';
  return { ok: true, text: async () => body };
};
const invalidPayload = await buildWorkbenchContext({ targetLaw: '감사오류법' });
assert.equal(invalidPayload.meta.dataIntegrity.isFallback, false);
record('error-payload-classified-official', invalidPayload.meta.dataIntegrity);

await clearAllCache();
ENV.LAW_OC = '';
await setCache('search:감사연쇄:1:6', [{ lawId: 'A', lawName: '감사연쇄법', lawType: '법률' }, { lawId: 'B', lawName: '감사연쇄법 시행령', lawType: '대통령령' }]);
await setCache('detail:B:', { articles: [] });
const cascade = await retrieveCascadingHierarchy({ lawName: '감사연쇄법', articleNos: ['999'] });
assert.equal(cascade.isCompleteHierarchy, true);
assert.equal(cascade.decree.articles.length, 0);
record('empty-decree-classified-complete', { isCompleteHierarchy: cascade.isCompleteHierarchy, decreeArticles: cascade.decree.articles.length, hasRule: Boolean(cascade.rule) });

const parsed = parseLawDetail('<html><body>API_ERROR_FIXTURE</body></html>');
assert.ok(parsed);
record('error-html-parsed-as-law', { lawName: parsed.lawName, articleCount: parsed.articles.length });

// Inspect generated XML in memory only; no document artifact or user history is touched.
const { generateDocx } = await import('../../server/export/exportFiles.js');
const { default: JSZip } = await import('jszip');
const exported = await generateDocx({ title: 'Audit fixture', contentMarkdown: 'DRAFT_WARNING_MARKER', reviewData: { reliability: { isFallback: true, warnings: ['SOURCE_WARNING_MARKER'] }, review: { isFallback: true, fallbackReason: 'FALLBACK_REASON_MARKER', legalOpinion: 'OPINION_MARKER', legalBasis: [{ lawName: '감사법', articleNo: '제999조', verificationStatus: 'UNVERIFIED', verificationNote: 'CITATION_WARNING_MARKER' }] } } });
const exportXml = await (await JSZip.loadAsync(exported)).file('word/document.xml').async('string');
assert.ok(exportXml.includes('제999조'));
assert.equal(exportXml.includes('SOURCE_WARNING_MARKER'), false);
assert.equal(exportXml.includes('CITATION_WARNING_MARKER'), false);
assert.equal(exportXml.includes('DRAFT_WARNING_MARKER'), false);
record('export-drops-provenance-and-citation-warnings', { citationIncluded: exportXml.includes('제999조'), sourceWarningIncluded: exportXml.includes('SOURCE_WARNING_MARKER'), citationWarningIncluded: exportXml.includes('CITATION_WARNING_MARKER'), draftWarningIncluded: exportXml.includes('DRAFT_WARNING_MARKER'), fallbackReasonIncluded: exportXml.includes('FALLBACK_REASON_MARKER') });
const emptyExport = await generateDocx({ title: 'Audit empty evidence', contentMarkdown: 'No evidence supplied' });
const emptyExportXml = await (await JSZip.loadAsync(emptyExport)).file('word/document.xml').async('string');
assert.ok(emptyExportXml.includes('제1조 및 제2조'));
record('export-invents-basis-for-empty-input', { inventedArticlesIncluded: emptyExportXml.includes('제1조 및 제2조') });

const { saveHistoryItem, getHistoryById } = await import('../../server/law/lawHistoryDb.js');
const seedId = saveHistoryItem({ query: 'ISOLATED_AUDIT_SEED_DO_NOT_DELETE' });
assert.ok(getHistoryById(seedId));
const historyTest = spawnSync(process.execPath, ['--test', 'test/lawHistory.test.js'], { env: process.env, encoding: 'utf8' });
assert.equal(historyTest.status, 0, historyTest.stderr + historyTest.stdout);
assert.equal(getHistoryById(seedId), null);
record('history-test-deletes-preexisting-record', { testExitCode: historyTest.status, seededHistorySurvives: false, usedIsolatedTempDb: true });

writeFileSync(new URL('./observations.json', import.meta.url), JSON.stringify({ revision: 'eaadebc', node: process.version, externalRequests: 0, observations }, null, 2) + '\n');
console.log(`Recorded ${observations.length} audit observations. These are defect reproductions, not passing product tests.`);
