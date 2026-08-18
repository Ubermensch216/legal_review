// server/parsers/pdfParser.js - PDF 텍스트 및 조항 구조 파서
import pdfParse from 'pdf-parse';

/**
 * PDF 버퍼에서 텍스트 및 조항 구조 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, numPages: number, info: object}>}
 */
export async function parsePdf(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 PDF 파일 버퍼가 아닙니다.');
  }

  const data = await pdfParse(buffer);
  const rawText = data.text || '';
  const cleanedText = normalizePdfText(rawText);

  return {
    text: cleanedText,
    rawText: rawText.trim(),
    numPages: data.numpages || 1,
    info: data.info || {}
  };
}

/**
 * PDF 특유의 행 바꿈 오류 및 조항 구조 정상화
 */
function normalizePdfText(text) {
  if (!text) return '';

  const lines = text.split(/\r?\n/);
  const normalizedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      normalizedLines.push('');
      continue;
    }

    // 헤더/푸터 페이지 번호 패턴 제거 (예: - 1 -, [2], 12/45 등)
    if (/^[-—–]\s*\d+\s*[-—–]$/.test(line) || /^\d+\s*\/\s*\d+$/.test(line)) {
      continue;
    }

    // 조항 시작 라인(제O조, 1., 가., ■) 앞에 공백 줄 삽입하여 가독성 증대
    if (/^(?:제\s*\d+\s*조|###|■|[①②③④⑤⑥⑦⑧⑨⑩])/.test(line)) {
      if (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] !== '') {
        normalizedLines.push('');
      }
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export default {
  parsePdf
};
