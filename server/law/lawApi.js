import { reportText, reportWarnings } from '../export/reportSafety.js';
// server/law/lawApi.js - 법령 검토 및 워크벤치 Express 라우터
import express from 'express';
import multer from 'multer';
import { parseDocument } from '../parsers/index.js';
import { buildWorkbenchContext } from './lawWorkbench.js';
import { generateLegalReview } from './lawWorkbenchReview.js';
import { searchLaw, getLawDetail, getLawArticle } from './lawApiClient.js';
import { runTool, getAvailableTools } from './tools/toolRunner.js';
import { validDate } from './evidence.js';
import { generateHwpx, generateDocx, generatePdf } from '../export/exportFiles.js';
import { saveHistoryItem, getHistoryList, getHistoryById, deleteHistoryItem, clearAllHistory } from './lawHistoryDb.js';
import { formatErrorResponse } from './lawErrors.js';
import { LAW_CONFIG } from './lawConfig.js';
import { ENV } from '../env.js';
import { createManualLearningRouter } from './manualLearningApi.js';
import { localLearningEndpoint } from './manualLearningLocal.js';
import { getLearningStore } from './manualLearningStore.js';
import { inquiryCoverage } from './manualLearning.js';
import { createProgressReporter, NOOP_PROGRESS } from './progressReporter.js';

const router = express.Router();
router.use('/learning', createManualLearningRouter());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

/**
 * GET /api/law/config - 기본 설정 및 지원 프리셋 조회
 */
router.get('/config', (req, res) => {
  res.json({
    ok: true,
    presets: Object.values(LAW_CONFIG.REVIEW_PRESETS),
    currentProvider: ENV.LLM_PROVIDER,
    hasLawOc: Boolean(ENV.LAW_OC),
    models: {
      ollama: ENV.OLLAMA_MODEL,
      openai: ENV.OPENAI_MODEL,
      anthropic: ENV.ANTHROPIC_MODEL,
      gemini: ENV.GEMINI_MODEL
    }
  });
});

/**
 * GET /api/law/models (또는 /api/law/installed-models) - 프로바이더별 설치/지원 모델 목록 조회
 */
router.get(['/models', '/installed-models'], async (req, res) => {
  const provider = String(req.query.provider || 'ollama').toLowerCase();

  if (provider === 'ollama') {
    let targetUrl = String(req.query.url || ENV.OLLAMA_URL || 'http://localhost:11434').trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `http://${targetUrl}`;
    }

    try {
      const parsed = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return res.status(400).json({ ok: false, error: '유효한 Ollama URL이 아닙니다.' });
      }
    } catch {
      return res.status(400).json({ ok: false, error: '잘못된 URL 형식입니다.' });
    }

    try {
      const probeTimeoutMs = parseInt(process.env.LLM_PROBE_TIMEOUT || '4000', 10);
      const response = await fetch(`${targetUrl}/api/tags`, {
        signal: AbortSignal.timeout(probeTimeoutMs)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const rawModels = Array.isArray(data.models) ? data.models : [];

      const models = rawModels.map(m => {
        const name = m.name || m.model || '';
        const details = m.details || {};
        const capabilities = m.capabilities || [];
        const isEmbeddingOnly = capabilities.length === 1 && capabilities[0] === 'embedding';

        return {
          name,
          parameterSize: details.parameter_size || '',
          quantization: details.quantization_level || '',
          family: details.family || '',
          isEmbeddingOnly,
          capabilities
        };
      }).filter(m => m.name);

      return res.json({
        ok: true,
        provider: 'ollama',
        models
      });
    } catch (err) {
      return res.json({
        ok: false,
        provider: 'ollama',
        models: [
          { name: 'gemma4:e4b', parameterSize: '8.0B', quantization: 'Q4_K_M', family: 'gemma4', isEmbeddingOnly: false },
          { name: 'gemma4:e2b', parameterSize: '5.1B', quantization: 'Q4_K_M', family: 'gemma4', isEmbeddingOnly: false }
        ],
        error: `Ollama 서버에 연결할 수 없습니다 (${targetUrl}): ${err.message}`
      });
    }
  }

  const cloudModels = {
    openai: [
      { name: 'gpt-4o', parameterSize: '', description: 'GPT-4o (권장)' },
      { name: 'gpt-4o-mini', parameterSize: '', description: 'GPT-4o mini (경량)' },
      { name: 'o1-preview', parameterSize: '', description: 'o1 Preview (추론 특화)' },
      { name: 'o1-mini', parameterSize: '', description: 'o1 Mini' }
    ],
    anthropic: [
      { name: 'claude-3-5-sonnet-20241022', parameterSize: '', description: 'Claude 3.5 Sonnet (권장)' },
      { name: 'claude-3-5-haiku-20241022', parameterSize: '', description: 'Claude 3.5 Haiku' }
    ],
    gemini: [
      { name: 'gemini-1.5-pro', parameterSize: '', description: 'Gemini 1.5 Pro (권장)' },
      { name: 'gemini-1.5-flash', parameterSize: '', description: 'Gemini 1.5 Flash' },
      { name: 'gemini-2.0-flash-exp', parameterSize: '', description: 'Gemini 2.0 Flash (실험)' }
    ]
  };

  return res.json({
    ok: true,
    provider,
    models: cloudModels[provider] || []
  });
});

/**
 * POST /api/law/parse-document - 첨부문서(HWPX, PDF, DOCX 등) 텍스트 파싱
 */
router.post('/parse-document', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: '업로드된 파일이 없습니다.' });
    }

    const parsed = await parseDocument(req.file.buffer, req.file.originalname);
    res.json({
      ok: true,
      filename: req.file.originalname,
      size: req.file.size,
      format: parsed.format,
      ext: parsed.ext,
      text: parsed.text,
      textLength: parsed.text.length
    });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * POST /api/law/workbench - 종합 워크벤치 분석 및 법령 검토 실행 (이력 자동 저장)
 */
/**
 * 진행 상황 스트리밍 채널.
 *
 * 검토는 수 분이 걸리는데 단일 JSON 응답으로는 그 사이 아무것도 보낼 수 없다.
 * stream=1로 요청하면 같은 POST 응답에 NDJSON(한 줄에 JSON 한 개)을 흘려보낸다.
 *   {"type":"progress","event":{...}}  진행 이벤트 (여러 줄)
 *   {"type":"result","payload":{...}}  최종 검토 결과 (마지막 줄)
 *   {"type":"error","error":"..."}     실패
 * stream 미지정 시에는 종전과 동일한 단일 JSON 응답을 준다. (기존 클라이언트 호환)
 */
function createStreamChannel(req, res) {
  const wants = String(req.body?.stream || '') === '1'
    || String(req.headers['accept'] || '').includes('application/x-ndjson');
  if (!wants) return { streaming: false, progress: NOOP_PROGRESS, write() {}, end() {} };

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // 리버스 프록시 버퍼링 방지
  res.flushHeaders?.();

  let closed = false;
  res.on('close', () => { closed = true; });

  const trace = [];
  const write = (obj) => {
    if (closed || res.writableEnded) return;
    try { res.write(`${JSON.stringify(obj)}\n`); } catch { closed = true; }
  };

  const progress = createProgressReporter((event) => {
    // tick(실시간 수치)은 이력에 남기지 않는다. 남기면 같은 줄이 수백 개 쌓인다.
    if (event.kind !== 'tick') trace.push(event);
    write({ type: 'progress', event });
  });

  return {
    streaming: true,
    progress,
    trace,
    isClosed: () => closed,
    write,
    end(obj) {
      if (obj) write(obj);
      if (!closed && !res.writableEnded) res.end();
    }
  };
}

router.post('/workbench', upload.single('file'), async (req, res) => {
  const channel = createStreamChannel(req, res);
  const progress = channel.progress;
  const fail = (statusCode, body) => {
    if (!channel.streaming) return res.status(statusCode).json(body);
    channel.end({ type: 'error', ...body });
  };
  try {
    // Following a manually imported answer is always a local operation.
    const sourceHistoryId = String(req.body.sourceHistoryId || '').trim().slice(0, 100) || null;
    if (sourceHistoryId && !getHistoryById(sourceHistoryId)) {
      return fail(404, { ok: false, error: '원 검토 이력을 찾을 수 없습니다. 검토를 다시 실행한 뒤 시도하십시오.' });
    }
    const manualLearning = req.body.learningMode === 'manual' || Boolean(sourceHistoryId);
    if (manualLearning) localLearningEndpoint();
    const query = req.body.query || '';
    const preset = req.body.preset || 'compliance';
    const targetLaw = req.body.targetLaw || '';
    // 검토 기준 시점(선택). 형식이 틀렸을 때 조용히 오늘로 떨어뜨리면
    // 사용자는 과거 시점을 검토했다고 믿게 되므로 여기서 거절한다.
    const targetDate = String(req.body.targetDate || '').trim();
    if (targetDate && !validDate(targetDate)) {
      return fail(400, { ok: false, error: '검토 기준일은 YYYYMMDD 또는 YYYY-MM-DD 형식이어야 합니다.' });
    }
    let documentText = req.body.documentText || '';
    let documentName = '';

    // 파일이 직접 업로드된 경우 파싱
    if (req.file) {
      documentName = req.file.originalname;
      progress.start('parse', '첨부문서 파싱', `${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`, '준비');
      const parsedDoc = await parseDocument(req.file.buffer, req.file.originalname);
      documentText = `${documentText}\n\n[첨부문서: ${req.file.originalname}]\n${parsedDoc.text}`.trim();
      progress.done('parse', `${parsedDoc.format} · ${parsedDoc.text.length.toLocaleString()}자`
        + ` · 조항 ${parsedDoc.chunks.length}개`
        + `${parsedDoc.tables.length ? ` · 표 ${parsedDoc.tables.length}개` : ''}`
        + `${parsedDoc.riskClauses.length ? ` · 위험 조항 ${parsedDoc.riskClauses.length}개` : ''}`);
    }

    if (!query && !documentText) {
      return fail(400, {
        ok: false,
        error: '검토 요청 질의 또는 첨부문서가 필요합니다.'
      });
    }

    // 1. 법령 워크벤치 데이터 구축 (공식 조문, 판례, 영향분석 등)
    const workbenchContext = await buildWorkbenchContext({
      query,
      preset,
      documentText,
      targetLaw,
      targetDate,
      progress
    });

    // 2. LLM 10대 검토의견서 생성
    let chosenModel = req.body.llmModel;
    if (manualLearning) {
      // 수동 학습 모드는 반드시 로컬 Ollama만 사용한다.
      // 클라우드 프로바이더가 지정되어 있거나 모델이 없으면 로컬 기본 모델을 사용하되,
      // Ollama 모델명이 전달된 경우 해당 모델을 사용한다.
      if (req.body.llmProvider && req.body.llmProvider !== 'ollama') {
        chosenModel = ENV.OLLAMA_MODEL;
      } else {
        chosenModel = req.body.llmModel || ENV.OLLAMA_MODEL;
      }
    } else {
      chosenModel = req.body.llmModel || ({
        openai: ENV.OPENAI_MODEL,
        anthropic: ENV.ANTHROPIC_MODEL,
        gemini: ENV.GEMINI_MODEL,
        ollama: ENV.OLLAMA_MODEL
      })[req.body.llmProvider || ENV.LLM_PROVIDER];
    }

    const llmConfig = {
      provider: manualLearning ? 'ollama' : (req.body.llmProvider || ENV.LLM_PROVIDER || 'ollama'),
      model: chosenModel,
      apiKey: manualLearning ? undefined : req.body.llmApiKey
    };
    if (!manualLearning && req.body.llmUrl) {
      llmConfig.url = req.body.llmUrl;
    }

    if (manualLearning) workbenchContext.meta.learningMode = 'manual';

    // 같은 사건의 재검토. 이 값이 있으면 그 검토에서 승인한 지식을 쟁점어 일치 없이도 싣는다.
    // 저장된 이력이 실제로 있어야 한다. 없는 값을 받아 남의 지식을 끌어오지 않게 한다.
    const learningStore = sourceHistoryId ? getLearningStore() : null;
    const inquiries = learningStore ? learningStore.list('inquiry').filter(i => i.historyId === sourceHistoryId) : [];
    const cards = learningStore ? learningStore.list('knowledge') : [];
    const unmet = inquiries.flatMap(i => inquiryCoverage(i, cards).questions
      .filter(q => q.state !== 'APPROVED').map(q => `${i.id.slice(0, 8)} #${q.no}`));
    if (unmet.length) {
      workbenchContext.meta.dataIntegrity.warnings.push(`외부 질의 중 승인된 답변이 연결되지 않은 질문 ${unmet.length}건이 남아 있습니다: ${unmet.join(', ')}. 해당 쟁점의 판단을 보류하십시오.`);
    }

    const reviewResult = await generateLegalReview({
      query,
      preset,
      documentText,
      workbenchContext,
      llmConfig,
      sourceHistoryId,
      progress
    });
    if (unmet.length && reviewResult.reviewStatus === 'COMPLETE') reviewResult.reviewStatus = 'PARTIAL';

    // 데이터 출처(목업 여부)와 검토 엔진(LLM/룰베이스)을 응답 최상단에 노출한다.
    // 폴백 결과가 정상 검토와 구분되지 않은 채 결재 문서로 나가는 것을 막기 위함이다.
    const dataIntegrity = workbenchContext.meta?.dataIntegrity || {};
    const reviewIsFallback = Boolean(reviewResult?.isFallback);
    const warnings = reportWarnings({ meta: workbenchContext.meta, review: reviewResult });

    const responsePayload = {
      ok: true,
      reliability: {
        isFallback: Boolean(dataIntegrity.isFallback) || reviewIsFallback || reviewResult?.reviewStatus !== 'COMPLETE',
        reviewStatus: reviewResult?.reviewStatus || 'FAILED',
        reviewEngine: reviewResult?.reviewEngine || 'UNKNOWN',
        dataSources: dataIntegrity.sources || {},
        citationConfidence: reviewResult?.factualityVerification?.citationConfidence ?? null,
        isCitationMeasurable: Boolean(reviewResult?.factualityVerification?.isMeasurable),
        warnings
      },
      // 이 검토가 어느 사건의 후속이고 어떤 지식을 썼는지 남긴다.
      // 별도 테이블 없이 이력만으로 지식의 출처를 되짚을 수 있어야 한다.
      meta: sourceHistoryId ? { ...workbenchContext.meta, sourceHistoryId,
        usedInquiryIds: [...new Set((reviewResult?.learningReferences || []).map(r => learningStore.get(r.id)?.parentId).filter(Boolean))],
        usedKnowledgeIds: (reviewResult?.learningReferences || []).map(r => r.id) } : workbenchContext.meta,
      review: reviewResult,                     // Tab 1: 검토 초안
      officialEvidence: workbenchContext.officialEvidence, // Tab 2: 공식 근거
      impactAndRevisions: workbenchContext.impactAndRevisions // Tab 3: 개정/영향
    };

    // 검토 추론 과정을 결과에 동봉한다. 이력에서 다시 불러올 때도 같은 타임라인을 볼 수 있어야 한다.
    if (channel.streaming) {
      const warnCount = channel.trace.filter(e => e.kind === 'warn').length;
      const stepCount = channel.trace.filter(e => e.kind === 'step' && e.state !== 'RUNNING').length;
      progress.finish(`${stepCount}단계 완료${warnCount ? ` · 제한 사항 ${warnCount}건` : ''}`);
      responsePayload.progressTrace = {
        events: channel.trace,
        stepCount,
        warnCount,
        totalMs: progress.elapsedMs()
      };
    }

    // 3. 검토 이력 DB 자동 저장
    progress.start('save', '검토 이력 저장', '', '검증');
    const historyTitle = query || (documentName ? `[문서검토] ${documentName}` : '법령 검토');
    const historyId = saveHistoryItem({
      query: historyTitle,
      preset,
      targetLaw: workbenchContext.meta?.primaryLawName || targetLaw,
      documentName,
      reviewData: responsePayload
    });

    responsePayload.historyId = historyId;
    progress.done('save', `이력 ID ${historyId}`);

    if (channel.streaming) return channel.end({ type: 'result', payload: responsePayload });
    res.json(responsePayload);
  } catch (err) {
    console.error('[LawApi] workbench 에러:', err);
    if (channel.streaming) {
      progress.fail('__pipeline__', err.message || '검토 실행 실패');
      return channel.end({ type: 'error', ...formatErrorResponse(err) });
    }
    res.status(err.statusCode || 500).json(formatErrorResponse(err));
  }
});

/**
 * GET /api/law/history - 검토 이력 목록 조회
 */
router.get('/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const historyList = getHistoryList(limit, offset);
    res.json({
      ok: true,
      total: historyList.length,
      items: historyList
    });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * GET /api/law/history/:id - 특정 검토 이력 상세 조회 및 복원
 */
router.get('/history/:id', (req, res) => {
  try {
    const item = getHistoryById(req.params.id);
    if (!item) {
      return res.status(404).json({ ok: false, error: '해당 이력을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, item });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * DELETE /api/law/history/:id - 특정 이력 삭제
 */
router.delete('/history/:id', (req, res) => {
  try {
    getLearningStore().deleteHistory(req.params.id);
    const success = deleteHistoryItem(req.params.id);
    res.json({ ok: success });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * DELETE /api/law/history - 전체 이력 초기화
 */
router.delete('/history', (req, res) => {
  try {
    getLearningStore().clear();
    const success = clearAllHistory();
    res.json({ ok: success });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * POST /api/law/report - 보고서 파일 내보내기 (HWPX, DOCX, PDF, MD)
 */
router.post('/report', async (req, res) => {
  try {
    const { format = 'hwpx', title = '법률검토의견서', content = '', reviewData = {} } = req.body;
    const cleanTitle = (title || '법률검토의견서').replace(/[\\/:*?"<>|]/g, '_');

    if (format === 'hwpx') {
      const buffer = await generateHwpx({ title, contentMarkdown: content, reviewData });
      res.setHeader('Content-Type', 'application/hwp+zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanTitle)}.hwpx`);
      return res.send(buffer);
    } else if (format === 'docx') {
      const buffer = await generateDocx({ title, contentMarkdown: content, reviewData });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanTitle)}.docx`);
      return res.send(buffer);
    } else if (format === 'pdf') {
      const buffer = await generatePdf({ title, contentMarkdown: content, reviewData });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanTitle)}.pdf`);
      return res.send(buffer);
    } else if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanTitle)}.md`);
      return res.send(reportText(reviewData, content));
    } else {
      return res.status(400).json({ ok: false, error: '지원하지 않는 포맷입니다. (hwpx, docx, pdf, md)' });
    }
  } catch (err) {
    console.error('[LawApi] report 내보내기 에러:', err);
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * GET /api/law/search - 법령 검색
 */
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    const page = parseInt(req.query.page || '1', 10);
    const display = parseInt(req.query.display || '20', 10);

    const items = await searchLaw(query, page, display);
    res.json({ ok: !items.fetchStatus, query, page, total: items.length, items, fetchStatus: items.fetchStatus || 'SUCCESS', message: items.unavailableReason });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * GET /api/law/detail/:lawId - 법령 상세 조회
 */
router.get('/detail/:lawId', async (req, res) => {
  try {
    const detail = await getLawDetail(req.params.lawId, req.query.seq);
    if (!detail) {
      return res.status(404).json({ ok: false, error: '법령을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, detail });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * GET /api/law/article - 특정 조문 조회
 */
router.get('/article', async (req, res) => {
  try {
    const lawName = req.query.law || '';
    const articleNo = req.query.article || '';
    const branchNo = req.query.branch || '';

    const result = await getLawArticle(lawName, articleNo, branchNo);
    if (!result) {
      return res.status(404).json({ ok: false, error: '조문을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

/**
 * GET /api/law/tools - 사용 가능한 도구 목록
 */
router.get('/tools', (req, res) => {
  res.json({
    ok: true,
    tools: getAvailableTools()
  });
});

/**
 * POST /api/law/tools/execute - 개별 도구 실행
 */
router.post('/tools/execute', async (req, res) => {
  try {
    const { tool, params } = req.body;
    if (!tool) {
      return res.status(400).json({ ok: false, error: 'tool 이름이 필요합니다.' });
    }

    const result = await runTool(tool, params || {});
    res.json(result);
  } catch (err) {
    res.status(500).json(formatErrorResponse(err));
  }
});

export default router;
