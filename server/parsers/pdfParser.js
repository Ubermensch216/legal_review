// server/parsers/pdfParser.js - PDF 텍스트 파서
import pdfParse from 'pdf-parse';

/**
 * PDF 버퍼에서 텍스트 및 페이지 정보 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, numPages: number, info: object}>}
 */
export async function parsePdf(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 PDF 파일 버퍼가 아닙니다.');
  }

  const data = await pdfParse(buffer);

  return {
    text: (data.text || '').trim(),
    numPages: data.numpages || 1,
    info: data.info || {}
  };
}

export default {
  parsePdf
};
