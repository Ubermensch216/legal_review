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
const server = app.listen(0, '127.0.0.1', () => console.log(`BROWSER_FIXTURE http://127.0.0.1:${server.address().port}`));
process.on('SIGINT', () => { server.close(); store.close(); process.exit(0); });
