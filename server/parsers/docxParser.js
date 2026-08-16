// server/parsers/docxParser.js - MS Word (DOCX) 파서
import mammoth from 'mammoth';

/**
 * DOCX 버퍼에서 텍스트 및 HTML 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, html: string}>}
 */
export async function parseDocx(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 DOCX 파일 버퍼가 아닙니다.');
  }

  const textResult = await mammoth.extractRawText({ buffer });
  const htmlResult = await mammoth.convertToHtml({ buffer });

  return {
    text: (textResult.value || '').trim(),
    html: htmlResult.value || ''
  };
}

export default {
  parseDocx
};
