// server/parsers/excelParser.js - Excel / CSV 파서
import readXlsxFile from 'read-excel-file/node';

/**
 * Excel / CSV 버퍼에서 텍스트 및 시트 데이터 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, sheets: object}>}
 */
export async function parseExcel(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 Excel 파일 버퍼가 아닙니다.');
  }

  let sheetList = [];
  try {
    sheetList = await readXlsxFile(buffer);
  } catch {
    // xlsx 포맷이 아닌 경우 UTF-8 텍스트(CSV)로 처리
    const rawText = buffer.toString('utf8');
    return {
      text: rawText,
      sheets: { 'Sheet1': rawText }
    };
  }

  const sheets = {};
  const textParts = [];

  for (const item of (sheetList || [])) {
    const sheetName = item.sheet || 'Sheet1';
    const rows = item.data || [];
    const csvRows = rows.map(row => 
      (row || []).map(cell => {
        if (cell === null || cell === undefined) return '';
        const str = String(cell);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(',')
    );
    const csv = csvRows.join('\n');
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
