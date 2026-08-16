// server/parsers/index.js - 멀티포맷 첨부문서 파서 진입점
import path from 'path';
import { parseHwpx } from './hwpxParser.js';
import { parsePdf } from './pdfParser.js';
import { parseDocx } from './docxParser.js';
import { parseExcel } from './excelParser.js';

/**
 * 업로드된 파일 버퍼와 파일명을 기반으로 텍스트 및 구조 추출
 * @param {Buffer} buffer 
 * @param {string} originalname 
 * @returns {Promise<{text: string, ext: string, format: string, details: object}>}
 */
export async function parseDocument(buffer, originalname = '') {
  if (!buffer || buffer.length === 0) {
    throw new Error('빈 파일이거나 파일 버퍼가 유효하지 않습니다.');
  }

  const ext = path.extname(originalname).toLowerCase().replace('.', '');

  try {
    if (ext === 'hwpx') {
      const res = await parseHwpx(buffer);
      return {
        text: res.text,
        ext: 'hwpx',
        format: '한글 HWPX 문서',
        details: res
      };
    } else if (ext === 'pdf') {
      const res = await parsePdf(buffer);
      return {
        text: res.text,
        ext: 'pdf',
        format: 'PDF 문서',
        details: res
      };
    } else if (ext === 'docx') {
      const res = await parseDocx(buffer);
      return {
        text: res.text,
        ext: 'docx',
        format: 'MS Word 문서',
        details: res
      };
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      const res = await parseExcel(buffer);
      return {
        text: res.text,
        ext,
        format: 'Excel/CSV 스프레드시트',
        details: res
      };
    } else if (ext === 'txt' || ext === 'md' || ext === 'json') {
      const text = buffer.toString('utf8');
      return {
        text,
        ext,
        format: '텍스트 문서',
        details: { length: text.length }
      };
    } else {
      // 기타 파일의 경우 UTF-8 텍스트 변환 시도
      const fallbackText = buffer.toString('utf8');
      return {
        text: fallbackText,
        ext: ext || 'unknown',
        format: '일반 파일',
        details: { length: fallbackText.length }
      };
    }
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
  parseExcel
};
