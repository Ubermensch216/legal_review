// server/parsers/excelParser.js - Excel / CSV 파서
import * as XLSX from 'xlsx';

/**
 * Excel / CSV 버퍼에서 텍스트 및 시트 데이터 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, sheets: object}>}
 */
export async function parseExcel(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 Excel 파일 버퍼가 아닙니다.');
  }

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = {};
  const textParts = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    sheets[sheetName] = csv;
    textParts.push(`[시트: ${sheetName}]\n${csv}`);
  }

  return {
    text: textParts.join('\n\n'),
    sheets
  };
}

export default {
  parseExcel
};
