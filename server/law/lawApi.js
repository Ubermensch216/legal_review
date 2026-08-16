// server/law/lawApi.js - 법령 검토 및 워크벤치 Express 라우터
import express from 'express';
import multer from 'multer';
import { parseDocument } from '../parsers/index.js';
import { buildWorkbenchContext } from './lawWorkbench.js';
import { generateLegalReview } from './lawWorkbenchReview.js';
import { searchLaw, getLawDetail, getLawArticle } from './lawApiClient.js';
import { runTool, getAvailableTools } from './tools/toolRunner.js';
import { generateHwpx, generateDocx, generatePdf } from '../export/exportFiles.js';
import { saveHistoryItem, getHistoryList, getHistoryById, deleteHistoryItem, clearAllHistory } from './lawHistoryDb.js';
import { formatErrorResponse } from './lawErrors.js';
import { LAW_CONFIG } from './lawConfig.js';
import { ENV } from '../env.js';

const router = express.Router();
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
router.post('/workbench', upload.single('file'), async (req, res) => {
  try {
    const query = req.body.query || '';
    const preset = req.body.preset || 'compliance';
    const targetLaw = req.body.targetLaw || '';
    let documentText = req.body.documentText || '';
    let documentName = '';

    // 파일이 직접 업로드된 경우 파싱
    if (req.file) {
      documentName = req.file.originalname;
      const parsedDoc = await parseDocument(req.file.buffer, req.file.originalname);
      documentText = `${documentText}\n\n[첨부문서: ${req.file.originalname}]\n${parsedDoc.text}`.trim();
    }

    if (!query && !documentText) {
      return res.status(400).json({
        ok: false,
        error: '검토 요청 질의 또는 첨부문서가 필요합니다.'
      });
    }

    // 1. 법령 워크벤치 데이터 구축 (공식 조문, 판례, 영향분석 등)
    const workbenchContext = await buildWorkbenchContext({
      query,
      preset,
      documentText,
      targetLaw
    });

    // 2. LLM 10대 검토의견서 생성
    const llmConfig = {
      provider: req.body.llmProvider,
      model: req.body.llmModel,
      apiKey: req.body.llmApiKey
    };

    const reviewResult = await generateLegalReview({
      query,
      preset,
      documentText,
      workbenchContext,
      llmConfig
    });

    const responsePayload = {
      ok: true,
      meta: workbenchContext.meta,
      review: reviewResult,                     // Tab 1: 검토 초안
      officialEvidence: workbenchContext.officialEvidence, // Tab 2: 공식 근거
      impactAndRevisions: workbenchContext.impactAndRevisions // Tab 3: 개정/영향
    };

    // 3. 검토 이력 DB 자동 저장
    const historyTitle = query || (documentName ? `[문서검토] ${documentName}` : '법령 검토');
    const historyId = saveHistoryItem({
      query: historyTitle,
      preset,
      targetLaw: workbenchContext.meta?.primaryLawName || targetLaw,
      documentName,
      reviewData: responsePayload
    });

    responsePayload.historyId = historyId;

    res.json(responsePayload);
  } catch (err) {
    console.error('[LawApi] workbench 에러:', err);
    res.status(500).json(formatErrorResponse(err));
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
      const buffer = await generateDocx({ title, contentMarkdown: content });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanTitle)}.docx`);
      return res.send(buffer);
    } else if (format === 'pdf') {
      const buffer = await generatePdf({ title, contentMarkdown: content });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanTitle)}.pdf`);
      return res.send(buffer);
    } else if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanTitle)}.md`);
      return res.send(content);
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
    res.json({ ok: true, query, page, total: items.length, items });
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
