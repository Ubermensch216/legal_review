// server/parsers/index.js - 멀티포맷 첨부문서 파서 및 계층 구조 복원 진입점
import path from 'path';
import { parseHwpx } from './hwpxParser.js';
import { parsePdf } from './pdfParser.js';
import { parseDocx } from './docxParser.js';
import { parseExcel } from './excelParser.js';
import { chunkLegalDocument } from './legalDocChunker.js';
import { optimizeDocumentContext } from './contextOptimizer.js';

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
    throw new Error('빈 파일이거나 파일 버퍼가 유효하지 않습니다.');
  }

  const ext = path.extname(originalname).toLowerCase().replace('.', '');
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
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      const res = await parseExcel(buffer);
      parsedText = res.text;
      format = 'Excel/CSV 스프레드시트';
      details = res;
    } else if (ext === 'txt' || ext === 'md' || ext === 'json') {
      parsedText = buffer.toString('utf8');
      format = '텍스트 문서';
      details = { length: parsedText.length };
    } else {
      parsedText = buffer.toString('utf8');
      format = '일반 파일';
      details = { length: parsedText.length };
    }

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
    console.error(`[DocParser] 파일 파싱 실패 (${originalname}):`, err.message);
    throw new Error(`[${originalname}] 문서 파싱 중 오류가 발생했습니다: ${err.message}`);
  }
}

export default {
  parseDocument,
  parseHwpx,
  parsePdf,
  parseDocx,
  parseExcel,
  chunkLegalDocument,
  optimizeDocumentContext
};
