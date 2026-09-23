// Opt-in browser fixture. All data is synthetic; no law API or LLM network calls are made.
import '../setup.js';
import express from 'express';
import multer from 'multer';
import { createLearningStore } from '../../server/law/manualLearningStore.js';
import { createManualLearningRouter } from '../../server/law/manualLearningApi.js';
import { findLearningKnowledge } from '../../server/law/manualLearningMemory.js';
import { sameOriginOnly } from '../../server/requestOrigin.js';

process.env.LLM_MODEL_BUDGETS = '{}';
const store = createLearningStore(':memory:');
const history = new Map();
const ctx = {
  meta: { query: '가상시설 사용료 징수권 검토', preset: 'compliance', primaryLawName: '가상법', learningMode: 'manual',
    dataIntegrity: { warnings: [], hasOfficialArticles: true }, asOfDate: '20260922' },
  review: { reviewStatus: 'PARTIAL', reviewEngine: 'BROWSER_TEST_FIXTURE', summary: '합성 시험 자료입니다.',
    facts: '가상기관 개발부가 시설을 위탁했다', legalOpinion: '징수권의 요건을 확인해야 한다.', draftOpinion: '시험용 초안',
    coreIssues: [], legalBasis: [], risks: [], recommendations: [], redlineDiffs: [], furtherChecks: [], warnings: [] },
  officialEvidence: { lawDetail: { lawName: '가상법', lawId: '1', source: 'OFFICIAL_API', enforceDate: '20200101' },
    articles: [{ lawName: '가상법', fullArticleNo: '1', content: '가상 규정', source: 'OFFICIAL_API', enforceDate: '20200101' }],
    precedents: [], interpretations: [], adminRules: [], ordinances: [] },
  impactAndRevisions: { riskClauses: [], extractedReferences: [], lawHistory: [], documentChunks: [] },
  reliability: { isFallback: true, reviewStatus: 'PARTIAL', reviewEngine: 'BROWSER_TEST_FIXTURE', warnings: ['합성 자료로 수행하는 UI 시험입니다.'] }
};
// FIXTURE_STAGED=1: 단계형 검토 결과(판단 공백 포함)를 흉내 낸다. 질의서가 공백에서 만들어지는 경로를 본다.
if (process.env.FIXTURE_STAGED === '1') ctx.review.reasoning = { version: 1, facts: [{ id: 'F1', text: '가상기관이 시설을 위탁했다', status: 'CONFIRMED' }],
  unknownFacts: [], gate: 'HUMAN_REVIEW_REQUIRED', gateReasons: ['I1: 가장 강한 반대 논리에 대한 응답 없음'],
  evidence: [{ id: 'A1', label: '가상법 제1조' }, { id: 'A1.1', label: '가상법 제1조 제1항' }, { id: 'A1.1x', label: '가상법 제1조 제1항 단서' }],
  issues: [{ id: 'I1', question: '수탁자가 사용료를 징수할 수 있는가?', factIds: ['F1'], dependsOn: [], stageStatus: 'OK',
    elements: [{ id: 'A1.E1', text: '관리위탁 계약이 있을 것', mandatory: true, isException: false },
      { id: 'A1.E2', text: '조례에 징수 주체가 정해져 있을 것', mandatory: true, isException: false },
      { id: 'A1.E3', text: '조례로 달리 정한 경우', mandatory: true, isException: true }],
    assessments: [
      { elementId: 'A1.E1', status: 'SATISFIED', proof: 'SUFFICIENT', evidenceIds: ['A1.1'], analysis: '위탁 계약이 확인된다 [F1].' },
      { elementId: 'A1.E2', status: 'UNKNOWN', proof: 'NO_EVIDENCE', evidenceIds: ['A1.1'], analysis: '조례 규정을 확인하지 못했다.' },
      { elementId: 'A1.E3', status: 'UNKNOWN', proof: 'NO_EVIDENCE', evidenceIds: ['A1.1x'], analysis: '' }],
    conclusion: { legal: 'CONDITIONAL', proof: 'NO_EVIDENCE', decidingElementIds: ['A1.E2'], reasons: ['판단 미확정 요건: A1.E2'] },
    precedents: [], narrative: '징수권은 조례 근거가 있어야 한다 [A1.1]. 조례를 확인하기 전에는 판단을 유보한다.',
    counter: { position: '위탁 계약에 징수 조항이 있으면 충분하다', evidenceIds: [], response: '' } }],
  gaps: [{ id: 'G1', issueId: 'I1', elementId: 'A1.E2', type: 'LEGAL_INTERPRETATION', route: 'EXTERNAL_INQUIRY', state: 'OPEN', priority: 3,
    question: '관리위탁 권한에 사용료 징수권이 포함되는지 판단하는 기준은 무엇인가?' },
  { id: 'G2', issueId: 'I1', elementId: null, type: 'AUTHORITY_CONFLICT', route: 'EXTERNAL_INQUIRY', state: 'OPEN', priority: 2,
    question: '상반된 해석례를 어떻게 평가해야 하는가?' },
  { id: 'G3', issueId: 'I1', elementId: 'A1.E1', type: 'FACT_UNKNOWN', route: 'USER', state: 'OPEN', priority: 1, question: '위탁계약서 원본 확인' }] };
let importAttempts = 0;
const app = express(); app.use('/api', sameOriginOnly); app.use(express.json());
app.get('/api/law/config', (req, res) => res.json({ ok: true, models: { ollama: 'fixture-local' } }));
app.get('/api/law/history', (req, res) => res.json({ ok: true, items: [] }));
app.post('/api/law/history', (req, res) => res.json({ ok: true }));
app.get('/api/law/history/:id', (req, res) => res.json({ ok: true, item: history.get(req.params.id) }));
app.post('/api/law/workbench', multer().none(), (req, res) => {
  if (req.body.learningMode !== 'manual') return res.status(400).json({ error: 'UI 시험: 로컬 수동 학습 모드가 요청에 포함되지 않았습니다.' });
  const id = `fixture-${history.size + 1}`;
  const data = structuredClone(ctx);
  const sourceId = req.body.sourceHistoryId;
  if (sourceId) {
    const found = findLearningKnowledge(ctx, ctx.meta.query, store, { historyId: sourceId });
    data.meta.sourceHistoryId = sourceId;
    data.review.learningReferences = found.used;
    data.review.learningExcluded = found.excluded;
    data.review.summary = `합성 재검토: 참고 지식 ${found.used.length}건`;
  }
  data.historyId = id; history.set(id, { id, data }); res.json(data);
});
app.use('/api/law/learning', createManualLearningRouter({ store, history: id => history.get(id), local: async (system, user) => {
  if (system.includes('비식별로 추상화')) return {
    abstractFacts: ['한 기관이 시설을 민간에 위탁했다.'], preservedLogic: ['징수권의 명시적 근거가 필요하다.'], missingFacts: [], sensitiveTerms: ['가상기관']
  };
  if (system.includes('미해결 쟁점을 분석')) return {
    needsHelp: true, abstractFacts: ['가상기관 개발부가 시설을 위탁했다.'], preservedLogic: ['징수권의 명시적 근거가 필요하다.'],
    questions: ['가상기관의 사용료 징수권 요건은 무엇인가?'], missingFacts: [], sensitiveTerms: ['가상기관 개발부']
  };
  if (importAttempts++ === 0) throw Object.assign(new Error('시험용 일시 오류: 붙여넣은 답변이 유지되어야 합니다.'), { statusCode: 503 });
  return { card: { title: '가상시설 징수권 확인', issue: '사용료 징수권', conditions: ['징수권 근거 존재'], exceptions: ['근거 없으면 판단 보류'],
    principles: ['근거와 요건 확인'], checklist: ['위임 조항 확인'], keywords: ['가상시설', '사용료'],
    citations: [{ lawName: '가상법', articleNo: '제1조' }] }, answeredQuestions: [1], sensitiveTerms: [] };
} }));
app.use(express.static('public'));
const server = app.listen(Number(process.env.FIXTURE_PORT || 0), '127.0.0.1', () => console.log(`BROWSER_FIXTURE http://127.0.0.1:${server.address().port}`));
process.on('SIGINT', () => { server.close(); store.close(); process.exit(0); });
