// server/parsers/index.js - 멀티포맷 첨부문서 파서 및 계층 구조 복원 진입점
import path from 'path';
import { parseHwpx } from './hwpxParser.js';
import { parsePdf } from './pdfParser.js';
import { parseDocx } from './docxParser.js';
import { parseExcel } from './excelParser.js';
import { chunkLegalDocument } from './legalDocChunker.js';
import { optimizeDocumentContext } from './contextOptimizer.js';

/** 사용자가 고칠 수 있는 입력 문제. 서버 오류가 아니므로 400으로 안내한다. */
export class DocumentInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentInputError';
    this.code = 'INVALID_DOCUMENT';
    this.statusCode = 400;
  }
}

export const SUPPORTED_EXTENSIONS = Object.freeze(['hwpx', 'pdf', 'docx', 'xlsx', 'csv', 'txt', 'md', 'json']);
const ZIP_EXTENSIONS = new Set(['hwpx', 'docx', 'xlsx']);
const TEXT_EXTENSIONS = new Set(['csv', 'txt', 'md', 'json']);
const OLE_SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const startsWith = (buffer, bytes) => bytes.every((byte, i) => buffer[i] === byte);
const MIN_PDF_CHARS = 20;

/**
 * 확장자와 파일 머리(시그니처)로 이 파서가 읽을 수 있는 파일인지 확인한다.
 * 읽을 수 없는 파일을 글자로 풀어 분석하면 깨진 글자가 법률 검토 입력이 된다.
 */
export function assertSupportedDocument(buffer, ext) {
  if (ext === 'hwp') throw new DocumentInputError('구형 한글(.hwp) 파일은 직접 읽을 수 없습니다. 한글에서 .hwpx 또는 .pdf로 다시 저장한 뒤 첨부해 주세요.');
  if (ext === 'xls') throw new DocumentInputError('구형 엑셀(.xls) 파일은 직접 읽을 수 없습니다. 엑셀에서 .xlsx 또는 .csv로 다시 저장한 뒤 첨부해 주세요.');
  if (ext === 'doc') throw new DocumentInputError('구형 워드(.doc) 파일은 직접 읽을 수 없습니다. 워드에서 .docx 또는 .pdf로 다시 저장한 뒤 첨부해 주세요.');
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new DocumentInputError(`지원하지 않는 파일 형식(.${ext || '확장자 없음'})입니다. ${SUPPORTED_EXTENSIONS.map(e => `.${e}`).join(', ')} 파일을 첨부해 주세요.`);
  }
  if (startsWith(buffer, OLE_SIGNATURE)) {
    throw new DocumentInputError('구형 문서 형식(OLE)으로 저장된 파일입니다. 최신 형식(.hwpx, .docx, .xlsx) 또는 .pdf로 다시 저장해 주세요.');
  }
  if (ZIP_EXTENSIONS.has(ext) && !startsWith(buffer, [0x50, 0x4B, 0x03, 0x04])) {
    throw new DocumentInputError(`.${ext} 파일이 아니거나 손상되었습니다. 파일을 다시 저장한 뒤 첨부해 주세요.`);
  }
  if (ext === 'pdf' && !startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {
    throw new DocumentInputError('PDF 파일이 아니거나 손상되었습니다. 파일을 다시 저장한 뒤 첨부해 주세요.');
  }
}

/** 분석에 쓸 글자가 실제로 있는지 본다. 비어 있거나 깨진 글자가 많으면 빈 문서로 검토가 진행되지 않게 한다. */
export function assertReadableText(text, ext) {
  const visible = String(text || '').replace(/\s/g, '');
  if (!visible.length) {
    throw new DocumentInputError(ext === 'pdf'
      ? 'PDF에서 글자를 읽지 못했습니다. 스캔한 이미지 PDF일 수 있습니다. 글자가 포함된 PDF로 다시 저장하거나 한글(.hwpx)·워드(.docx)로 첨부해 주세요.'
      : '문서에서 읽을 수 있는 글자를 찾지 못했습니다. 내용이 비어 있거나 손상된 파일일 수 있습니다.');
  }
  if (ext === 'pdf' && visible.length < MIN_PDF_CHARS) {
    throw new DocumentInputError(`PDF에서 읽은 글자가 ${visible.length}자뿐입니다. 스캔한 이미지 PDF일 수 있습니다. 글자가 포함된 PDF로 다시 저장해 주세요.`);
  }
  const broken = (String(text).match(/�/g) || []).length;
  if (broken / Math.max(1, visible.length) > 0.02) {
    throw new DocumentInputError('문서의 글자가 깨져 있어 분석할 수 없습니다. 파일 형식이나 인코딩(UTF-8)을 확인해 다시 첨부해 주세요.');
  }
}

/**
 * 업로드된 파일 버퍼와 파일명을 기반으로 텍스트, 표, 조항 계층 및 위험 태그 추출
 * @param {Buffer} buffer 
 * @param {string} originalname 
 * @param {object} options
 * @param {string} options.query - 검토 질의어 (컨텍스트 최적화 시 활용)
 * @param {boolean} options.optimize - 컨텍스트 최적화 실행 여부
 * @returns {Promise<{text: string, ext: string, format: string, details: object, chunks: Array<object>, riskClauses: Array<object>, tables: Array<object>}>}
 */
export async function parseDocument(buffer, originalname = '', options = {}) {
  if (!buffer || buffer.length === 0) {
    throw new DocumentInputError('빈 파일이거나 파일을 읽지 못했습니다. 파일을 다시 첨부해 주세요.');
  }

  const ext = path.extname(originalname).toLowerCase().replace('.', '');
  assertSupportedDocument(buffer, ext);
  let parsedText = '';
  let format = '일반 파일';
  let details = {};
  let tables = [];

  try {
    if (ext === 'hwpx') {
      const res = await parseHwpx(buffer);
      parsedText = res.text;
      format = '한글 HWPX 문서';
      tables = res.tables || [];
      details = res;
    } else if (ext === 'pdf') {
      const res = await parsePdf(buffer);
      parsedText = res.text;
      format = 'PDF 문서';
      details = res;
    } else if (ext === 'docx') {
      const res = await parseDocx(buffer);
      parsedText = res.text;
      format = 'MS Word 문서';
      tables = res.tables || [];
      details = res;
    } else if (ext === 'xlsx' || ext === 'csv') {
      const res = await parseExcel(buffer);
      parsedText = res.text;
      format = 'Excel/CSV 스프레드시트';
      details = res;
    } else if (TEXT_EXTENSIONS.has(ext)) {
      parsedText = buffer.toString('utf8');
      format = '텍스트 문서';
      details = { length: parsedText.length };
    } else {
      throw new DocumentInputError(`지원하지 않는 파일 형식(.${ext})입니다.`);
    }
    assertReadableText(parsedText, ext);

    // 2. 조항 단위 계층적 청킹
    const chunks = chunkLegalDocument(parsedText);
    const riskClauses = chunks.filter(c => c.isRiskClause);

    // 3. 컨텍스트 최적화 (대용량인 경우)
    let optimized = null;
    if (options.optimize || parsedText.length > 4000) {
      optimized = optimizeDocumentContext({
        documentText: parsedText,
        query: options.query || '',
        maxChars: 4500
      });
    }

    return {
      text: parsedText,
      optimizedText: optimized ? optimized.optimizedText : parsedText,
      ext: ext || 'unknown',
      format,
      chunks,
      riskClauses,
      tables,
      details: {
        ...details,
        chunkCount: chunks.length,
        riskClauseCount: riskClauses.length,
        tableCount: tables.length,
        isOptimized: Boolean(optimized && optimized.omittedCount > 0)
      }
    };
  } catch (err) {
    // 사용자가 고칠 수 있는 입력 문제는 그대로 전달한다(원인과 해결 방법이 문장에 들어 있다).
    if (err instanceof DocumentInputError) throw err;
    console.error(`[DocParser] 파일 파싱 실패 (${originalname}):`, err.message);
    throw new DocumentInputError(`[${originalname}] 문서를 읽는 중 오류가 발생했습니다. 파일이 손상되었거나 지원하지 않는 구조일 수 있습니다. (${err.message})`);
  }
}

export default {
  parseDocument,
  assertSupportedDocument,
  assertReadableText,
  parseHwpx,
  parsePdf,
  parseDocx,
  parseExcel,
  chunkLegalDocument,
  optimizeDocumentContext
};
