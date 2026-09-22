import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openAiStream } from './llmStreamStub.js';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import { ENV } from '../server/env.js';
import { clearAllCache, getCache, setCache } from '../server/law/lawCache.js';
import { searchLaw, getLawDetail, getLawArticle, getLawVersions } from '../server/law/lawApiClient.js';
import { searchPrecedents, searchInterpretations } from '../server/law/decisionsApiClient.js';
import { parseLawDetail, parseLawSearchList } from '../server/law/lawApiParser.js';
import { normalizeArticleNo, extractArticleReferences } from '../server/law/lawArticleRef.js';
import { verifyAndCorrectReviewCitations as verify } from '../server/law/factualityVerifier.js';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';
import { buildWorkbenchContext } from '../server/law/lawWorkbench.js';
import { optimizeDocumentContext } from '../server/parsers/contextOptimizer.js';
import { buildReviewInput } from '../server/law/reviewContext.js';
import { execute as timeTravel } from '../server/law/tools/timeTravel.js';
import { execute as articleAt } from '../server/law/tools/articleAt.js';
import { retrieveCascadingHierarchy } from '../server/law/cascadingRetriever.js';
import { generateDocx, generateHwpx, generatePdf } from '../server/export/exportFiles.js';
import pdfParse from 'pdf-parse';
import { reportText } from '../server/export/reportSafety.js';
import { saveHistoryItem, getHistoryById } from '../server/law/lawHistoryDb.js';
import { reRankPrecedents } from '../server/law/reRanker.js';
import { scoreCitations } from './benchmark/scoring.js';
import { sameOriginOnly } from '../server/requestOrigin.js';

const noNetwork = globalThis.fetch;
afterEach(async () => { globalThis.fetch = noNetwork; ENV.LAW_OC = ''; ENV.LAW_DEMO_MODE = false; await clearAllCache(); });
const law = { lawId: '1552', lawSeq: '10', lawName: '개인정보 보호법', enforceDate: '20200101', source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT' };
const article = { articleNo: '15', fullArticleNo: '15', title: '수집', content: '수집 요건', paragraphs: [{ paragraphNo: '1', content: 'NESTED_EXCEPTION', items: [{ itemNo: '2', content: '예외 요건' }] }] };
const context = () => ({ meta: { primaryLawName: law.lawName, dataIntegrity: { hasOfficialArticles: true, sources: { articles: 'OFFICIAL_API' }, warnings: [] } }, officialEvidence: { lawDetail: { ...law }, articles: [structuredClone(article)] } });
const review = () => ({ summary: '확인된 내용', facts: '사실', legalOpinion: '근거와 제한을 함께 검토했습니다.', draftOpinion: '검토 초안', coreIssues: [], legalBasis: [], risks: [], recommendations: [], redlineDiffs: [], furtherChecks: [] });
const verifyOne = (item, ctx = context(), lookupArticle = async () => null) => verify({ review: { legalBasis: [item] }, workbenchContext: ctx, lookupArticle });
const lawXml = (id = '1552', date = '20200101') => `<법령><기본정보><법령ID>${id}</법령ID><법령명_한글>개인정보 보호법</법령명_한글><시행일자>${date}</시행일자></기본정보><조문><조문단위><조문번호>15</조문번호><조문내용>수집 요건</조문내용><항><항번호>1</항번호><항내용>예외</항내용></항></조문단위></조문></법령>`;
const listXml = items => `<LawSearch>${items.map(i => `<law><법령ID>${i.lawId}</법령ID><법령일련번호>${i.lawSeq}</법령일련번호><법령명한글>${i.lawName}</법령명한글><시행일자>${i.enforceDate}</시행일자></law>`).join('')}</LawSearch>`;
const xmlResponse = text => ({ ok: true, text: async () => text });
const llmStub = (value, capture = () => {}, finish_reason = 'stop') => {
  globalThis.fetch = async (_url, options) => { capture(JSON.parse(options.body));
    return openAiStream(typeof value === 'string' ? value : JSON.stringify(value), { finishReason: finish_reason }); };
};
const generate = (ctx, text = '') => generateLegalReview({ query: '면책', preset: 'contract_risk', documentText: text, workbenchContext: ctx, llmConfig: { provider: 'openai', apiKey: 'fixture-only' } });

test('조문 조회는 중첩 본문을 보존하고 없는 항·호를 실패로 반환한다', async () => {
  const deps = { getLawArticle: async () => ({ ...law, article }) };
  const params = { lawName: law.lawName, articleNo: '15' };
  const full = await articleAt(params, deps);
  assert.match(full.fullContent, /NESTED_EXCEPTION/);
  assert.equal(full.source, 'OFFICIAL_API');
  assert.equal((await articleAt({ ...params, paragraphNo: '9' }, deps)).found, false);
  assert.equal((await articleAt({ ...params, paragraphNo: '1', itemNo: '9' }, deps)).found, false);
  assert.equal((await articleAt({ ...params, paragraphNo: '1', itemNo: '2' }, deps)).found, true);
});

test('법령 이름과 가지·항·호가 다른 인용은 검증하지 않는다', async () => {
  for (const item of [
    { lawName: '존재하지않는법', articleNo: '제15조' },
    { lawName: law.lawName, articleNo: '제15조의999' },
    { lawName: law.lawName, articleNo: '제15조 제99항' },
    { lawName: law.lawName, articleNo: '제15조 제1항 제99호' },
    { lawName: law.lawName, articleNo: '제15조 및 제999조' }
  ]) {
    const { verificationReport, verifiedReview } = await verifyOne(item);
    assert.equal(verificationReport.validCount, 0);
    assert.equal(verifiedReview.legalBasis[0].verificationStatus, 'UNVERIFIED');
  }
  const result = await verifyOne({ lawName: law.lawName, articleNo: '제15조 제1항 제2호' });
  assert.equal(result.verificationReport.validCount, 1);
});

test('목업 보충 조회 및 출처 없는 로컬 자료는 검증률을 만들지 않는다', async () => {
  const ctx = { officialEvidence: { articles: [] } };
  for (const result of [{ ...law, article, isMockData: true }, { lawName: law.lawName, article }]) {
    const { verificationReport } = await verifyOne({ lawName: law.lawName, articleNo: '15' }, ctx, async () => result);
    assert.equal(verificationReport.citationConfidence, null);
    assert.equal(verificationReport.validCount, 0);
  }
});

test('삭제·시행 전·다른 버전의 조문은 VERIFIED가 아니다', async () => {
  for (const change of [{ isDeleted: true }, { enforceDate: '20990101' }]) {
    const ctx = context(); Object.assign(ctx.officialEvidence.articles[0], change);
    assert.equal((await verifyOne({ lawName: law.lawName, articleNo: '15' }, ctx)).verificationReport.validCount, 0);
  }
  assert.equal((await verifyOne({ lawName: law.lawName, articleNo: '15', lawSeq: '999' })).verificationReport.validCount, 0);
});

test('조문 정규화는 표준 가지 번호와 띄어쓴 법령명을 보존한다', () => {
  assert.equal(normalizeArticleNo('제15조의2 제1항'), '15의2');
  assert.equal(normalizeArticleNo('15의2'), '15의2');
  const refs = extractArticleReferences('개인정보 보호법 제15조의2 제1항 제2호 및 근로기준법 제56조');
  assert.equal(refs[0].lawName, '개인정보 보호법');
  assert.equal(refs[0].fullArticleNo, '15의2');
  assert.equal(refs[0].paragraphNo, '1');
  assert.equal(refs[1].lawName, '근로기준법');
});

test('가짜 pre-warm ID와 기존 캐시는 조회에 사용하지 않는다', async () => {
  assert.equal(await getCache('law:search:개인정보 보호법:1:3'), null);
  await setCache('search:개인정보 보호법:1:3', [{ lawId: 'PREWARM_개인정보 보호법' }]);
  assert.equal((await searchLaw(law.lawName, 1, 3)).length, 0);
  assert.equal(await getLawDetail('PREWARM_개인정보 보호법'), null);
});

test('버전 본문 조회는 ID보다 MST와 시행일을 사용한다', async () => {
  ENV.LAW_OC = 'fixture'; let url;
  globalThis.fetch = async input => { url = new URL(input); return xmlResponse(lawXml()); };
  const result = await getLawDetail('1552', '10', { enforceDate: '20200101' });
  assert.equal(url.searchParams.get('target'), 'eflaw');
  assert.equal(url.searchParams.get('MST'), '10');
  assert.equal(url.searchParams.has('ID'), false);
  assert.equal(url.searchParams.get('efYd'), '20200101');
  assert.equal(result.source, 'OFFICIAL_API');
  assert.equal((await getLawArticle('1552', '15', '999')), null);
});

test('HTTP 200 오류 문서를 공식 법령으로 승인하지 않는다', async () => {
  assert.equal(parseLawDetail('<html><body>error</body></html>'), null);
  assert.throws(() => parseLawSearchList('<html>error</html>'));
  ENV.LAW_OC = 'fixture'; globalThis.fetch = async () => xmlResponse('<html>error</html>');
  await assert.rejects(getLawDetail('1552'));
  assert.equal((await searchLaw(law.lawName)).fetchStatus, 'ERROR');
});

test('연혁 목록은 정확한 ID로 다음 페이지까지 가져온다', async () => {
  ENV.LAW_OC = 'fixture'; const requested = [];
  globalThis.fetch = async input => {
    const u = new URL(input); requested.push(u);
    const page = Number(u.searchParams.get('page'));
    const items = !u.searchParams.has('LID') ? [law] : page === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...law, lawSeq: String(i + 1) })) : [{ ...law, lawSeq: '101' }];
    return xmlResponse(listXml(items));
  };
  assert.equal((await getLawVersions(law.lawName)).length, 101);
  assert.ok(requested.some(u => u.searchParams.get('LID') === law.lawId && u.searchParams.get('page') === '2'));
});

test('시점 조회는 공포일 대신 시행일로 결정하고 본문 버전을 확인한다', async () => {
  const versions = [{ ...law, promulDate: '20190101' }, { ...law, lawSeq: '11', promulDate: '20210101', enforceDate: '20300101' }];
  const deps = { getLawVersions: async () => versions, getLawDetail: async (_id, seq, options) => ({ ...versions.find(v => v.lawSeq === seq), enforceDate: options.enforceDate, articles: [article] }) };
  assert.equal((await timeTravel({ lawName: law.lawName, targetDate: '20250101' }, deps)).appliedVersion.lawSeq, '10');
  assert.equal((await timeTravel({ lawName: law.lawName, targetDate: '20300101' }, deps)).appliedVersion.lawSeq, '11');
  assert.equal((await timeTravel({ lawName: law.lawName, targetDate: '20180101' }, deps)).found, false);
  assert.equal((await timeTravel({ lawName: law.lawName, targetDate: '20250101', articleNo: '제15조의2' }, deps)).found, false);
  await assert.rejects(timeTravel({ lawName: law.lawName, targetDate: '20250230' }, deps));
  const mismatch = { ...deps, getLawDetail: async () => ({ ...law, lawSeq: '999', articles: [article] }) };
  assert.equal((await timeTravel({ lawName: law.lawName, targetDate: '20250101' }, mismatch)).found, false);
});

test('병합 사건번호는 대표 사건을 대조하되 다른 사건번호는 제외한다', async () => {
  ENV.LAW_OC = 'fixture';
  for (const [number, expected] of [['2023다290355, 290362', 'FULL_TEXT'], ['2023다2903550', 'LIST_ONLY'], ['2023다999999', 'LIST_ONLY']]) {
    await clearAllCache();
    globalThis.fetch = async url => xmlResponse(String(url).includes('lawSearch.do')
      ? '<PrecSearch><prec><판례일련번호>10</판례일련번호><사건번호>2023다290355</사건번호></prec></PrecSearch>'
      : `<PrecService><판례정보일련번호>10</판례정보일련번호><사건번호>${number}</사건번호><판결요지>픽스처 본문</판결요지></PrecService>`);
    const results = await searchPrecedents('병합 사건', 1, 1);
    assert.equal(results[0].contentStatus, expected);
  }
});

test('판례·해석례는 목록 ID로 본문을 조회하고 공식 상세 필드를 정규화한다', async () => {
  ENV.LAW_OC = 'fixture'; const calls = [];
  globalThis.fetch = async input => {
    const u = new URL(input); const target = u.searchParams.get('target'); calls.push(u);
    if (u.pathname.endsWith('lawSearch.do')) return xmlResponse(target === 'prec'
      ? '<PrecSearch><prec><판례일련번호>10</판례일련번호><사건번호>fixture-1</사건번호><사건명>사건</사건명></prec></PrecSearch>'
      : '<ExpcSearch><expc><법령해석례일련번호>20</법령해석례일련번호><안건명>질의</안건명></expc></ExpcSearch>');
    return xmlResponse(target === 'prec'
      ? '<PrecService><판례정보일련번호>10</판례정보일련번호><사건번호>fixture-1</사건번호><판결요지>공식 요지 픽스처</판결요지></PrecService>'
      : '<ExpcService><법령해석례일련번호>20</법령해석례일련번호><안건명>질의</안건명><해석일자>20200101</해석일자><회답>공식 회답 픽스처</회답></ExpcService>');
  };
  const [prec] = await searchPrecedents('fixture'); const [expc] = await searchInterpretations('fixture');
  assert.equal(prec.summary, '공식 요지 픽스처'); assert.equal(prec.contentStatus, 'FULL_TEXT');
  assert.equal(expc.answer, '공식 회답 픽스처'); assert.equal(expc.replyDate, '20200101');
  assert.equal(calls.filter(u => u.pathname.endsWith('lawService.do')).length, 2);
  await searchPrecedents('fixture'); assert.equal(calls.length, 4, '재조회는 목록·본문 캐시를 사용한다');
});

test('본문 수집 실패 판례는 LIST_ONLY이며 LLM 근거에서 제외된다', async () => {
  ENV.LAW_OC = 'fixture';
  globalThis.fetch = async input => xmlResponse(new URL(input).pathname.endsWith('lawSearch.do')
    ? '<PrecSearch><prec><판례일련번호>10</판례일련번호><사건번호>OMIT_CASE</사건번호></prec></PrecSearch>' : '<html>error</html>');
  const precedents = await searchPrecedents('fixture');
  assert.equal(precedents[0].contentStatus, 'LIST_ONLY');
  const ctx = context(); ctx.officialEvidence.precedents = precedents;
  assert.equal(buildReviewInput(ctx).precedentsText, '');
});

test('최적화한 후반 위험 조항·법령 항 내용이 실제 LLM 요청에 들어간다', async () => {
  const document = `제1조(일반) ${'일반 문구 '.repeat(1200)}\n제2조(면책) 모든 책임을 지지 않는다. LATE_RISK_MARKER`;
  const ctx = context();
  ctx.reviewContext = { document: optimizeDocumentContext({ documentText: document, query: '면책', maxChars: 4500 }) };
  assert.ok(ctx.reviewContext.document.optimizedText.length <= 4500);
  ctx.officialEvidence.precedents = [{ source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT', caseNo: 'ZERO_SCORE', relevanceScore: 0, summary: '공식 요지' }, { isMockData: true, caseNo: 'FORBIDDEN_MOCK', summary: '샘플' }];
  let prompt; llmStub(review(), body => { prompt = body.messages[1].content; });
  await generate(ctx, document);
  assert.ok(prompt.includes('LATE_RISK_MARKER'));
  assert.ok(prompt.includes('NESTED_EXCEPTION'));
  assert.ok(prompt.includes('관련도: 0점'));
  assert.equal(prompt.includes('FORBIDDEN_MOCK'), false);
});

test('거대 조항과 아주 작은 예산도 문서 예산을 초과하지 않는다', () => {
  for (const maxChars of [0, 20, 1500, 4500]) {
    const result = optimizeDocumentContext({ documentText: '제1조(내용) ' + '긴 문구 '.repeat(5000), query: '문구', maxChars });
    assert.ok(result.optimizedText.length <= maxChars);
  }
});

test('빈·불완전·잘린 LLM 응답은 완료 처리하거나 근거를 자동 생성하지 않는다', async () => {
  for (const output of [{}, [], { summary: '일부' }, '{"summary":"잘린']) {
    llmStub(output);
    const result = await generate(context());
    assert.equal(result.reviewStatus, 'FAILED'); assert.equal(result.isFallback, true);
    assert.equal(result.legalBasis.length, 0); assert.equal(result.factualityVerification.citationConfidence, null);
    assert.equal(/원천 무효|정면으로 위배|패소할 위험/.test(result.legalOpinion + result.draftOpinion), false);
  }
  llmStub(review(), () => {}, 'length');
  assert.equal((await generate(context())).reviewStatus, 'FAILED');
});

test('정상 JSON에도 인용을 덧붙이지 않고 없는 수정 원문은 표시한다', async () => {
  llmStub(review()); const valid = await generate(context()); assert.deepEqual(valid.legalBasis, []);
  llmStub({ ...review(), redlineDiffs: [{ originalText: '없는 문장', revisedText: '수정 문장' }] });
  const partial = await generate(context(), '실제 원문');
  assert.equal(partial.reviewStatus, 'PARTIAL'); assert.equal(partial.redlineDiffs[0].sourceVerified, false);
});

const services = overrides => ({ searchLaw: async () => [], getLawDetail: async () => null, searchPrecedents: async () => [], searchInterpretations: async () => [], searchAdminRules: async () => [], searchOrdinances: async () => [], retrieveCascadingHierarchy: async () => null, runTool: async () => ({ ok: true, result: null }), ...overrides });
test('워크벤치는 시행령을 모법으로 바꾸지 않고 빈 본문에 제한을 표시한다', async () => {
  const deps = services({ searchLaw: async () => [law], getLawDetail: async () => ({ ...law, articles: [] }) });
  const decree = await buildWorkbenchContext({ targetLaw: `${law.lawName} 시행령` }, deps);
  assert.equal(decree.meta.primaryLawName, `${law.lawName} 시행령`);
  assert.equal(decree.meta.dataIntegrity.isFallback, true);
  const empty = await buildWorkbenchContext({ targetLaw: law.lawName }, deps);
  assert.equal(empty.meta.dataIntegrity.hasOfficialArticles, false);
  assert.equal(empty.meta.dataIntegrity.isFallback, true);
});

test('연쇄 검색은 빈 본문을 완료로 표시하지 않는다', async () => {
  const cascade = await retrieveCascadingHierarchy({ lawName: law.lawName, articleNos: ['15'] }, services({ searchLaw: async name => [{ ...law, lawName: name }], getLawDetail: async () => ({ ...law, articles: [] }) }));
  assert.equal(cascade.isCompleteHierarchy, false);
  assert.equal(cascade.stageStatus.decree, 'BODY_UNAVAILABLE');
});

test('DOCX·HWPX·Markdown은 출처·인용 경고를 보존하며 빈 근거를 채우지 않는다', async () => {
  const data = { reliability: { warnings: ['SOURCE_WARNING'] }, review: { isFallback: true, fallbackReason: 'FALLBACK_REASON', legalOpinion: '다른 의견', legalBasis: [{ lawName: '감사법', articleNo: '제999조', verificationStatus: 'UNVERIFIED', verificationNote: 'CITATION_WARNING' }] } };
  for (const [create, file] of [[generateDocx, 'word/document.xml'], [generateHwpx, 'Contents/section0.xml']]) {
    const buffer = await create({ contentMarkdown: 'DRAFT_WARNING', reviewData: data });
    const xml = await (await JSZip.loadAsync(buffer)).file(file).async('string');
    for (const marker of ['SOURCE_WARNING', 'FALLBACK_REASON', 'CITATION_WARNING', 'DRAFT_WARNING', '제999조']) assert.ok(xml.includes(marker), marker);
    const empty = await create({ contentMarkdown: '근거 미제공' });
    const emptyXml = await (await JSZip.loadAsync(empty)).file(file).async('string');
    assert.equal(emptyXml.includes('제1조 및 제2조'), false);
  }
  assert.ok(reportText(data, '본문').includes('CITATION_WARNING'));
  const pdf = await pdfParse(await generatePdf({ contentMarkdown: 'DRAFT_WARNING', reviewData: data }));
  for (const marker of ['SOURCE_WARNING', 'FALLBACK_REASON', 'CITATION_WARNING', 'DRAFT_WARNING']) assert.ok(pdf.text.includes(marker), marker);
});

test('실제 워크벤치 경로에서 복수 법령의 조문과 최적화 문서를 보존한다', async () => {
  const other = { ...law, lawId: '5', lawName: '근로기준법' };
  const laws = [law, other];
  const deps = services({ searchLaw: async name => laws.filter(l => l.lawName === name), getLawDetail: async id => ({ ...laws.find(l => l.lawId === id), articles: [{ ...article }] }) });
  const result = await buildWorkbenchContext({ targetLaw: law.lawName, query: '개인정보 보호법 제15조 및 근로기준법 제15조', documentText: '제1조(자료) 검토 자료' }, deps);
  assert.deepEqual(result.officialEvidence.articles.map(a => a.lawName), [law.lawName, other.lawName]);
  assert.equal(result.reviewContext.document.optimizedText, '제1조(자료) 검토 자료');
  const verified = await verifyOne({ lawName: other.lawName, articleNo: '15' }, result);
  assert.equal(verified.verificationReport.validCount, 1);
});

test('워크벤치 확보 통계는 재정렬 전 전체 후보와 실패 경고를 보존한다', async () => {
  const candidates = [
    { id: '1', source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT', summary: '본문', caseNo: '2020다1' },
    ...['2', '3', '4'].map(id => ({ id, source: 'OFFICIAL_API', contentStatus: 'LIST_ONLY', detailErrorCode: 'UNEXPECTED_BODY_ROOT' }))
  ];
  const result = await buildWorkbenchContext({ targetLaw: law.lawName, query: '제15조' }, services({ searchPrecedents: async () => candidates }));
  assert.equal(result.meta.retrievalAvailability.precedents.listCount, 4);
  assert.equal(result.meta.retrievalAvailability.precedents.fullTextCount, 1);
  assert.equal(result.meta.retrievalAvailability.precedents.failures.UNEXPECTED_BODY_ROOT, 3);
  assert.ok(result.meta.dataIntegrity.warnings.some(w => w.includes('본문 1건 확보, 3건 미확보')));
});

test('기준 시점을 지정하면 그 시점 버전의 조문을 쓰고 현행 본문으로 대체하지 않는다', async () => {
  const past = { ...law, lawSeq: '10', enforceDate: '20200101' };
  const current = { ...law, lawSeq: '11', enforceDate: '20240101' };
  const bodies = {
    '10': [{ ...article, content: 'PAST_TEXT' }],
    // 이 버전에는 기준일 뒤에 시행된 조문이 하나 더 있다.
    '11': [{ ...article, content: 'CURRENT_TEXT' }, { articleNo: '16', fullArticleNo: '16', title: '신설', content: 'FUTURE_TEXT', enforceDate: '20240101' }]
  };
  const deps = services({
    searchLaw: async () => [current],
    getLawVersions: async () => [past, current],
    getLawDetail: async (lawId, seq, options) => ({ ...law, lawSeq: seq, enforceDate: options.enforceDate, articles: structuredClone(bodies[seq]) })
  });

  const asOf2021 = await buildWorkbenchContext({ targetLaw: law.lawName, query: '제15조', targetDate: '2021-01-01' }, deps);
  assert.equal(asOf2021.meta.targetDate, '20210101');
  assert.equal(asOf2021.meta.asOfDate, '20210101');
  assert.equal(asOf2021.officialEvidence.lawDetail.lawSeq, '10');
  assert.deepEqual(asOf2021.officialEvidence.articles.map(a => a.content), ['PAST_TEXT']);

  // 시점을 지정하지 않으면 종전대로 검색 결과(현행) 본문을 쓴다.
  const currentReview = await buildWorkbenchContext({ targetLaw: law.lawName, query: '제15조' }, deps);
  assert.equal(currentReview.meta.targetDate, '');
  assert.equal(currentReview.officialEvidence.lawDetail.lawSeq, '11');
  assert.deepEqual(currentReview.officialEvidence.articles.map(a => a.content), ['CURRENT_TEXT']);

  // 기준일 뒤에 시행된 조문은 LLM 입력에서도 빠지고, 시점 검토임이 제한 사항으로 남는다.
  const input = buildReviewInput(asOf2021, '', '제15조');
  assert.ok(input.articlesText.includes('PAST_TEXT'));
  assert.ok(!input.articlesText.includes('FUTURE_TEXT'));
  assert.ok(input.warnings.some(w => w.includes('20210101 시점에 시행 중이던')));
});

test('시점 버전을 확인하지 못하면 현행 본문으로 대체하지 않고 제한으로 표시한다', async () => {
  const deps = services({
    searchLaw: async () => [law],
    getLawVersions: async () => [],                       // 그 시점에 시행 중이던 버전 없음
    getLawDetail: async () => ({ ...law, articles: [structuredClone(article)] })
  });
  const result = await buildWorkbenchContext({ targetLaw: law.lawName, query: '제15조', targetDate: '19990101' }, deps);
  assert.equal(result.officialEvidence.articles.length, 0);
  assert.equal(result.meta.dataIntegrity.hasOfficialArticles, false);
  assert.equal(result.meta.dataIntegrity.isFallback, true);
  assert.ok(result.meta.dataIntegrity.warnings.some(w => w.includes('19990101 시점에 시행 중이던 버전을 확인하지 못했습니다')));
});

test('형식이 잘못된 기준일은 조용히 오늘로 떨어지지 않는다', async () => {
  const deps = services({ searchLaw: async () => [law], getLawDetail: async () => ({ ...law, articles: [structuredClone(article)] }) });
  const result = await buildWorkbenchContext({ targetLaw: law.lawName, query: '제15조', targetDate: '2021-13-45' }, deps);
  assert.equal(result.meta.targetDate, '');               // 시점 검토로 표시하지 않는다
  assert.ok(result.meta.dataIntegrity.warnings.some(w => w.includes("'2021-13-45'의 형식이 올바르지 않아")));
});

test('시점 검토는 인용 검증 기준일도 그 시점으로 바꾼다', async () => {
  const historical = context();
  historical.meta.targetDate = '20210101';
  historical.meta.asOfDate = '20210101';
  historical.officialEvidence.lawDetail.enforceDate = '20200101';
  historical.officialEvidence.articles[0].enforceDate = '20200101';

  const inForce = await verifyOne({ lawName: law.lawName, articleNo: '15' }, historical);
  assert.equal(inForce.verificationReport.validCount, 1);

  // 기준일 뒤에 시행된 조문은 그 시점 근거가 될 수 없다.
  const later = structuredClone(historical);
  later.officialEvidence.articles[0].enforceDate = '20240101';
  assert.equal((await verifyOne({ lawName: law.lawName, articleNo: '15' }, later)).verificationReport.validCount, 0);

  // 과거 시점 검토에서는 현행 조문 엔드포인트로 되묻지 않는다.
  let lookups = 0;
  const lookup = async () => { lookups++; return { ...law, article: structuredClone(article) }; };
  await verifyOne({ lawName: law.lawName, articleNo: '99' }, historical, lookup);
  assert.equal(lookups, 0);
  await verifyOne({ lawName: law.lawName, articleNo: '99' }, context(), lookup);
  assert.equal(lookups, 1);
});

test('연쇄 체계도 기준 시점 버전으로 맞추고 확인 못 한 단계는 싣지 않는다', async () => {
  const past = { ...law, lawSeq: '10', enforceDate: '20200101' };
  const current = { ...law, lawSeq: '11', enforceDate: '20240101' };
  const deps = services({
    searchLaw: async name => [{ ...current, lawName: name }],
    // 시행령만 그 시점 버전이 확인되고, 모법·시행규칙은 확인되지 않는다.
    getLawVersions: async name => (/시행령$/.test(name) ? [past, current] : []),
    getLawDetail: async (lawId, seq, options) => ({ ...law, lawName: '개인정보 보호법 시행령', lawSeq: seq, enforceDate: options.enforceDate,
      articles: [{ articleNo: '31', fullArticleNo: '31', title: '위임', content: '법 제15조에 따른 사항' }] }),
    searchAdminRules: async () => []
  });
  const cascade = await retrieveCascadingHierarchy({ lawName: `${law.lawName} 시행령`, articleNos: ['31'], asOfDate: '20210101' }, deps);
  assert.equal(cascade.asOfDate, '20210101');
  assert.equal(cascade.decree.lawSeq, '10');
  assert.equal(cascade.stageStatus.act, 'VERSION_UNAVAILABLE');
  assert.equal(cascade.act, null);
  assert.ok(cascade.warnings.some(w => w.includes('20210101 시점에 시행 중이던 버전으로')));
});

test('직접 실행한 이력 테스트도 외부의 기존 DB를 건드리지 않는다', () => {
  const seed = saveHistoryItem({ query: 'PRESERVE_TEST_SEED' });
  const child = spawnSync(process.execPath, ['--test', 'test/lawHistory.test.js'], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.ok(getHistoryById(seed));
});

test('판례 숫자 부분 일치와 타 법령 동번호로 평가 점수를 얻지 못한다', () => {
  const ranked = reRankPrecedents({ precedents: [{ holding: '제150조의 요건', courtName: '' }], articleNos: ['15'] });
  assert.equal(ranked[0].relevanceScore, 0);
  const score = scoreCitations({ legalBasis: [{ lawName: '근로기준법', articleNo: '제15조', verificationStatus: 'VERIFIED' }] }, ['15'], law.lawName);
  assert.equal(score.recall, 0); assert.equal(score.precision, 0);
});

test('다른 사이트의 로컬 API 요청을 차단한다', () => {
  for (const origin of ['https://attacker.example', 'null']) {
    let status, next = false;
    sameOriginOnly({ protocol: 'http', get: name => ({ host: '127.0.0.1:3000', origin })[name] }, { status: code => { status = code; return { json() {} }; } }, () => { next = true; });
    assert.equal(status, 403); assert.equal(next, false);
  }
  let allowed = false;
  sameOriginOnly({ protocol: 'http', get: name => ({ host: 'localhost:3000', origin: 'http://localhost:3000' })[name] }, {}, () => { allowed = true; });
  assert.equal(allowed, true);
});
