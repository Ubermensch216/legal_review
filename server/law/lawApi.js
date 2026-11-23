import { reportText, reportWarnings } from '../export/reportSafety.js';
// server/law/lawApi.js - 법령 검토 및 워크벤치 Express 라우터
import express from 'express';
import multer from 'multer';
import { parseDocument } from '../parsers/index.js';
import { buildWorkbenchContext } from './lawWorkbench.js';
import { generateLegalReview } from './lawWorkbenchReview.js';
import { createLlmSession } from '../reasoning/llmGateway.js';
import { canStartWithProvider, ExternalTransmissionBlockedError, EXTERNAL_PROVIDERS, isExternalProvider } from '../reasoning/externalGate.js';
import { createHash } from 'node:crypto';
import { createDeidentifier, reidentifyDeep, remainingIdentifiers } from '../privacy/deidentify.js';
import { readExternalAudit, recordExternalTransmission } from '../privacy/auditLog.js';
import { recallReview } from '../reasoning/reviewSessionStore.js';
import { EscalationError, previewEscalation, runEscalation } from '../reasoning/escalation.js';
import { depthProfile } from '../reasoning/analysisDepth.js';
import { searchLaw, getLawDetail, getLawArticle } from './lawApiClient.js';
import { runTool, getAvailableTools } from './tools/toolRunner.js';
import { validDate } from './evidence.js';
import { generateHwpx, generateDocx, generatePdf } from '../export/exportFiles.js';
import { saveHistoryItem, getHistoryList, getHistoryById, deleteHistoryItem, clearAllHistory, updateHistoryData } from './lawHistoryDb.js';
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
    // 외부 LLM 제공자별로 서버에 키가 설정되어 있는지(값은 알려 주지 않는다). 설정 화면의 사용 방식 선택에 쓴다.
    externalProviders: Object.fromEntries(EXTERNAL_PROVIDERS.map(name => [name, Boolean(ENV[`${name.toUpperCase()}_API_KEY`])])),
    models: {
      ollama: ENV.OLLAMA_MODEL,
      openai: ENV.OPENAI_MODEL,
      anthropic: ENV.ANTHROPIC_MODEL,
      gemini: ENV.GEMINI_MODEL,
      exaone: ENV.EXAONE_MODEL
    }
  });
});


/** 사용자가 가릴 단어로 지정한 값을 정리한다. */
const parseTerms = value => {
  let list = value;
  if (typeof value === 'string') { try { list = JSON.parse(value); } catch { list = value.split(/[\n,]/); } }
  return (Array.isArray(list) ? list : []).map(x => String(x || '').trim()).filter(x => x.length >= 2 && x.length <= 100).slice(0, 100);
};

/** 외부 LLM만 쓰는 모드의 검토 입력 전체를 비식별화하고, 사용자가 승인할 내용의 해시를 만든다. */
function sanitizeReviewInputs({ query, documentText, provider, terms }) {
  const deid = createDeidentifier({ terms, sample: `${query}\n${documentText}` });
  const sanitized = { query: deid.redact(query), documentText: deid.redact(documentText) };
  const mapping = deid.mapping();
  const digest = createHash('sha256').update(`${provider}|${sanitized.query}|${sanitized.documentText}`).digest('hex');
  const used = Object.keys(mapping).filter(token => `${sanitized.query}\n${sanitized.documentText}`.includes(token));
  const counts = {};
  for (const token of used) { const kind = token.slice(1, token.lastIndexOf('_')); counts[kind] = (counts[kind] || 0) + 1; }
  return { ...sanitized, mapping, digest, counts, replacements: used.length,
    remaining: remainingIdentifiers(`${sanitized.query}\n${sanitized.documentText}`) };
}

/**
 * POST /api/law/privacy/preview - 외부 LLM으로 보낼 검토 입력을 비식별화해 미리 보여 준다. 아무것도 전송하지 않는다.
 */
router.post('/privacy/preview', upload.single('file'), async (req, res) => {
  try {
    const provider = String(req.body.llmProvider || '').toLowerCase();
    if (!isExternalProvider(provider)) return res.status(400).json({ ok: false, error: '외부 LLM 제공자를 선택한 경우에만 전송 미리보기를 만들 수 있습니다.' });
    let documentText = req.body.documentText || '';
    if (req.file) {
      const parsed = await parseDocument(req.file.buffer, req.file.originalname);
      documentText = `${documentText}\n\n[첨부문서: ${req.file.originalname}]\n${parsed.text}`.trim();
    }
    const query = req.body.query || '';
    if (!query && !documentText) return res.status(400).json({ ok: false, error: '검토 요청 질의 또는 첨부문서가 필요합니다.' });
    const sanitized = sanitizeReviewInputs({ query, documentText, provider, terms: parseTerms(req.body.privateTerms) });
    res.json({ ok: true, provider, digest: sanitized.digest, query: sanitized.query, documentText: sanitized.documentText,
      counts: sanitized.counts, replacements: sanitized.replacements, remaining: sanitized.remaining });
  } catch (err) {
    res.status(err.statusCode || 500).json(formatErrorResponse(err));
  }
});

/** GET /api/law/privacy/audit - 외부 LLM 전송 기록(내용은 남기지 않는다) */
router.get('/privacy/audit', (req, res) => {
  res.json({ ok: true, entries: readExternalAudit(Math.min(500, parseInt(req.query.limit || '100', 10) || 100)) });
});

const escalationContext = reviewId => {
  const ctx = recallReview(reviewId);
  if (!ctx) throw new EscalationError('검토 세션이 만료되었거나 서버가 다시 시작되었습니다. 검토를 다시 실행한 뒤 외부 재검토를 요청하십시오.', 410, 'SESSION_EXPIRED');
  return ctx;
};
const escalationProvider = value => {
  const provider = String(value || '').toLowerCase();
  if (!isExternalProvider(provider)) throw new EscalationError('외부 LLM 제공자를 선택하십시오.', 400, 'NOT_EXTERNAL');
  return provider;
};

/**
 * POST /api/law/escalation/preview - 로컬 모델이 풀지 못한 쟁점을 외부 LLM에 보낼 때의 비식별 전송 내용을 미리 보여 준다.
 */
router.post('/escalation/preview', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const ctx = escalationContext(req.body.reviewId);
    const provider = escalationProvider(req.body.provider);
    res.json({ ok: true, ...previewEscalation(ctx, String(req.body.issueId || ''), { provider, terms: parseTerms(req.body.privateTerms) }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, code: err.code, error: err.message });
  }
});

/**
 * POST /api/law/escalation/send - 사용자가 승인한 비식별 전송 내용을 외부 LLM으로 보내고 답변을 검토에 반영한다.
 */
router.post('/escalation/send', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const ctx = escalationContext(req.body.reviewId);
    const provider = escalationProvider(req.body.provider);
    const issueId = String(req.body.issueId || '');
    const model = String(req.body.model || '').trim() || ({ openai: ENV.OPENAI_MODEL, anthropic: ENV.ANTHROPIC_MODEL, gemini: ENV.GEMINI_MODEL, exaone: ENV.EXAONE_MODEL })[provider];
    const result = await runEscalation({ ctx, issueId, provider, model, apiKey: req.body.apiKey || undefined, digest: String(req.body.digest || ''),
      terms: parseTerms(req.body.privateTerms),
      local: { provider: 'ollama', model: String(req.body.localModel || '').trim() || ENV.OLLAMA_MODEL } });
    const historyId = String(req.body.historyId || '').trim();
    if (historyId) {
      updateHistoryData(historyId, data => ({ ...data, review: { ...data.review, ...result.reviewPatch,
        reviewStatus: data.review?.reviewStatus, escalation: data.review?.escalation, reasoning: { ...data.review?.reasoning, ...result.reasoningPatch,
          gate: 'HUMAN_REVIEW_REQUIRED', gateReasons: [...new Set([...(data.review?.reasoning?.gateReasons || []), result.externalNote])] },
        externalReviews: [...(data.review?.externalReviews || []), { issueId, provider, model, at: new Date().toISOString(),
          before: result.before, after: result.after }] } }));
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[LawApi] escalation 에러:', err.message);
    res.status(err.statusCode || 500).json({ ok: false, code: err.code, error: err.message });
  }
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
    ],
    exaone: [
      { name: 'k-exaone_v2.5', parameterSize: '', description: 'K-EXAONE 2.5' }
    ]
  };

  // 키 값은 내려보내지 않고 설정 여부만 알린다.
  if (provider === 'exaone') {
    const keyConfigured = Boolean(ENV.EXAONE_API_KEY);
    return res.json({
      ok: keyConfigured,
      provider,
      keyConfigured,
      models: cloudModels.exaone,
      ...(keyConfigured ? {} : { error: '.env에 EXAONE_API_KEY를 설정한 뒤 서버를 재시작하십시오.' })
    });
  }

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
    res.status(err.statusCode || 500).json(formatErrorResponse(err));
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
    const sourceHistory = sourceHistoryId ? getHistoryById(sourceHistoryId) : null;
    if (sourceHistoryId && !sourceHistory) {
      return fail(404, { ok: false, error: '원 검토 이력을 찾을 수 없습니다. 검토를 다시 실행한 뒤 시도하십시오.' });
    }
    if (sourceHistoryId) {
      const learningStore = getLearningStore();
      const inquiries = learningStore.list('inquiry').filter(i => i.historyId === sourceHistoryId);
      const cards = learningStore.list('knowledge');
      const unmet = inquiries.flatMap(i => inquiryCoverage(i, cards).questions
        .filter(q => q.state !== 'APPROVED').map(q => `#${q.no}`));
      if (unmet.length) {
        return fail(409, { ok: false,
          error: `외부 전문가 확인 질문 ${unmet.length}건에 승인된 답변이 없습니다 (${unmet.join(', ')}). 모든 답변을 승인한 뒤 최종 검토를 실행하십시오.` });
      }
      if (!sourceHistory.data?.review?.reasoning?.issues?.length) {
        return fail(409, { ok: false, error: '원 검토에 재사용할 쟁점·요건 구조가 없습니다. 단계형 최초 검토를 완료한 뒤 외부 답변을 연결하십시오.' });
      }
    }
    // 기본분석에 이어 심화분석: 보관된 사실·쟁점·수집 근거를 재사용한다. 파일을 다시 받지 않는다.
    const deepenReviewId = String(req.body.deepenReviewId || '').trim().slice(0, 100);
    const deepen = deepenReviewId ? recallReview(deepenReviewId) : null;
    if (deepenReviewId && !deepen) {
      return fail(410, { ok: false, code: 'SESSION_EXPIRED',
        error: '기본분석 세션이 만료되었거나 서버가 다시 시작되었습니다. 심화분석을 처음부터 실행하십시오.' });
    }
    const manualLearning = req.body.learningMode === 'manual' || Boolean(sourceHistoryId);
    if (manualLearning) localLearningEndpoint();
    let query = deepen ? deepen.query : (req.body.query || '');
    const preset = deepen?.preset || req.body.preset || 'compliance';
    const targetLaw = req.body.targetLaw || '';
    // 검토 기준 시점(선택). 형식이 틀렸을 때 조용히 오늘로 떨어뜨리면
    // 사용자는 과거 시점을 검토했다고 믿게 되므로 여기서 거절한다.
    const targetDate = String(req.body.targetDate || '').trim();
    if (targetDate && !validDate(targetDate)) {
      return fail(400, { ok: false, error: '검토 기준일은 YYYYMMDD 또는 YYYY-MM-DD 형식이어야 합니다.' });
    }
    if (sourceHistoryId) {
      const original = sourceHistory.data?.meta || {};
      if (query.trim() !== String(original.query || '').trim() || preset !== original.preset
        || targetDate.replace(/\D/g, '') !== String(original.targetDate || '').replace(/\D/g, '')) {
        return fail(409, { ok: false, error: '원 검토의 질의·검토 유형·기준일이 달라졌습니다. 저장된 구조에 답변을 끼워 넣으려면 원래 조건을 유지하십시오.' });
      }
    }
    let documentText = deepen ? deepen.documentText : (req.body.documentText || '');
    let documentName = deepen?.documentName || '';

    // 파일이 직접 업로드된 경우 파싱
    if (req.file && !deepen) {
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

    // 목록 선별부터 최종 검토까지 같은 제공자 설정과 호출 원장을 사용한다.
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
        exaone: ENV.EXAONE_MODEL,
        ollama: ENV.OLLAMA_MODEL
      })[req.body.llmProvider || ENV.LLM_PROVIDER];
    }

    const resolvedProvider = manualLearning ? 'ollama' : (req.body.llmProvider || ENV.LLM_PROVIDER || 'ollama');
    if (deepen && isExternalProvider(resolvedProvider)) {
      return fail(400, { ok: false, error: '외부 LLM 검토는 전송 내용을 다시 승인해야 하므로 심화분석을 처음부터 실행하십시오.' });
    }
    // 분석 수준을 지정하지 않은 호출은 종전과 같은 전체 검증(심화분석)이다.
    const requestedDepth = deepen ? 'DEEP' : req.body.analysisDepth;
    const depth = requestedDepth ? depthProfile(requestedDepth) : null;
    const llmConfig = {
      provider: resolvedProvider,
      model: chosenModel,
      apiKey: manualLearning ? undefined : req.body.llmApiKey,
      // 외부 질의 루프의 최초 검토에는 재사용할 쟁점·요건·공백 구조가 필요하다.
      // EXAONE 검토도 같은 구조를 남겨야 외부 전문가 질의 탭을 그대로 쓸 수 있다.
      ...(manualLearning || resolvedProvider === 'exaone' || depth ? { pipeline: 'staged' } : {}),
      ...(depth ? { analysisDepth: depth.depth, screenBoundary: depth.screenBoundary } : {})
    };
    // 외부 LLM만 쓰는 모드: 검토 입력 전체를 비식별화하고, 사용자가 미리보기에서 승인한 해시와 같을 때만 시작한다.
    // 승인 없이는 문서가 이 PC 밖으로 나가지 않게, 호출이 시작되기 전에 거절한다(호출 직전에도 다시 막는다).
    let externalApproval = null;
    let originalQuery = null;
    let reidentifyMapping = null;
    if (!manualLearning && isExternalProvider(resolvedProvider)) {
      const sanitized = sanitizeReviewInputs({ query, documentText, provider: resolvedProvider, terms: parseTerms(req.body.privateTerms) });
      if (!req.body.externalApprovalDigest || req.body.externalApprovalDigest !== sanitized.digest) {
        return fail(409, { ok: false, code: 'EXTERNAL_TRANSMISSION_BLOCKED', needsApproval: true,
          error: new ExternalTransmissionBlockedError(resolvedProvider).message });
      }
      if (sanitized.remaining.length) {
        return fail(422, { ok: false, code: 'IDENTIFIERS_REMAIN', error: `비식별 후에도 ${sanitized.remaining.join(', ')}이(가) 남아 있어 전송하지 않았습니다. 가릴 단어를 추가해 미리보기를 다시 확인하십시오.` });
      }
      originalQuery = query;
      ({ query, documentText } = sanitized);
      reidentifyMapping = sanitized.mapping;
      externalApproval = { scope: { provider: resolvedProvider, inputDigest: sanitized.digest, label: 'review-input' } };
      recordExternalTransmission({ provider: resolvedProvider, purpose: 'REVIEW_INPUT_APPROVED', digest: sanitized.digest,
        counts: sanitized.counts, replacements: sanitized.replacements });
    }
    if (!canStartWithProvider(resolvedProvider, externalApproval)) {
      return fail(409, { ok: false, code: 'EXTERNAL_TRANSMISSION_BLOCKED', error: new ExternalTransmissionBlockedError(resolvedProvider).message });
    }
    // 요청이 임의의 주소를 모델 서버로 지정해 문서를 보내지 못하게 한다. 이 PC 또는 설정된 OLLAMA_URL만 허용한다.
    if (!manualLearning && req.body.llmUrl) {
      let requested;
      try { requested = new URL(String(req.body.llmUrl)); } catch { requested = null; }
      const configured = new URL(ENV.OLLAMA_URL);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(requested?.hostname);
      if (!requested || !(loopback || requested.origin === configured.origin)) {
        return fail(400, { ok: false, error: 'llmUrl은 이 PC의 Ollama 또는 서버에 설정된 OLLAMA_URL만 사용할 수 있습니다.' });
      }
      llmConfig.url = requested.origin;
    }

    // 최초 검토에서만 공식 자료를 수집한다. 후속 검토는 저장된 스냅샷을 사용한다.
    const llmSession = createLlmSession();
    if (externalApproval) llmSession.externalApproval = externalApproval;
    const workbenchContext = deepen ? deepen.workbenchContext : sourceHistoryId
      ? { meta: structuredClone(sourceHistory.data.meta),
        officialEvidence: structuredClone(sourceHistory.data.officialEvidence),
        impactAndRevisions: structuredClone(sourceHistory.data.impactAndRevisions || {}) }
      : await buildWorkbenchContext({ query, preset, documentText, targetLaw, targetDate,
        llmConfig, session: llmSession, progress });
    if (sourceHistoryId) {
      workbenchContext.meta.dataIntegrity ||= { warnings: [] };
      workbenchContext.meta.dataIntegrity.warnings ||= [];
      workbenchContext.meta.dataIntegrity.warnings.push(
        `최종 재검토는 원 검토의 공식 근거 스냅샷(${workbenchContext.meta.asOfDate || '기준일 미상'})을 재사용했습니다.`);
      progress.note('learning', '원 검토의 공식 근거 스냅샷과 쟁점 구조를 재사용합니다.');
    }

    // 2. LLM 검토의견서 생성

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
      llmSession,
      sourceHistoryId,
      progress,
      resumeContext: deepen
    });
    // 심화분석으로 이어갈 때 문서 이름을 이력에 다시 쓸 수 있게 보관한다.
    if (reviewResult?.analysisSession?.reviewId) {
      const session = recallReview(reviewResult.analysisSession.reviewId);
      if (session) session.documentName = documentName;
    }
    if (unmet.length && reviewResult.reviewStatus === 'COMPLETE') reviewResult.reviewStatus = 'PARTIAL';

    // 데이터 출처(목업 여부)와 검토 엔진(LLM/룰베이스)을 응답 최상단에 노출한다.
    // 폴백 결과가 정상 검토와 구분되지 않은 채 결재 문서로 나가는 것을 막기 위함이다.
    const dataIntegrity = workbenchContext.meta?.dataIntegrity || {};
    const reviewIsFallback = Boolean(reviewResult?.isFallback);
    const warnings = reportWarnings({ meta: workbenchContext.meta, review: reviewResult });
    const learningReferences = Array.isArray(reviewResult?.learningReferences) ? reviewResult.learningReferences : [];
    const externalKnowledge = {
      applied: learningReferences.length > 0,
      count: learningReferences.length,
      humanExpertCount: learningReferences.filter(r => r.source === 'USER_APPROVED_HUMAN_EXPERT').length,
      externalAiCount: learningReferences.filter(r => r.source !== 'USER_APPROVED_HUMAN_EXPERT').length
    };

    const responsePayload = {
      ok: true,
      reliability: {
        isFallback: Boolean(dataIntegrity.isFallback) || reviewIsFallback || reviewResult?.reviewStatus !== 'COMPLETE',
        reviewStatus: reviewResult?.reviewStatus || 'FAILED',
        reviewEngine: reviewResult?.reviewEngine || 'UNKNOWN',
        analysisDepth: reviewResult?.analysisDepth || null,
        dataSources: dataIntegrity.sources || {},
        citationConfidence: reviewResult?.factualityVerification?.citationConfidence ?? null,
        isCitationMeasurable: Boolean(reviewResult?.factualityVerification?.isMeasurable),
        reviewOrigin: externalKnowledge.applied ? 'EXTERNAL_KNOWLEDGE_RERUN' : 'INITIAL_REVIEW',
        externalKnowledge,
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

    // 외부 LLM에는 대체 표기로 보냈으므로, 사용자에게 돌려주는 결과는 원래 값으로 복원한다.
    if (reidentifyMapping) Object.assign(responsePayload, reidentifyDeep(responsePayload, reidentifyMapping));
    responsePayload.reliability.llmMode = reidentifyMapping ? 'EXTERNAL_ONLY' : (responsePayload.review?.escalation ? 'LOCAL_WITH_ESCALATION' : 'LOCAL_ONLY');

    // 3. 검토 이력 DB 자동 저장
    progress.start('save', '검토 이력 저장', '', '검증');
    const historyTitle = (originalQuery ?? query) || (documentName ? `[문서검토] ${documentName}` : '법령 검토');
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
