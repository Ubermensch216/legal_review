// server/parsers/docxParser.js - MS Word (DOCX) 정밀 파서 및 표/문단 구조 복원기
import mammoth from 'mammoth';

/**
 * DOCX 버퍼에서 텍스트 및 Markdown 표/계층 구조 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, html: string, tables: Array<any>}>}
 */
export async function parseDocx(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 DOCX 파일 버퍼가 아닙니다.');
  }

  const htmlResult = await mammoth.convertToHtml({ buffer });
  const html = htmlResult.value || '';

  // HTML에서 표(<table>)를 파싱하여 Markdown Table로 변환 및 텍스트 구조화
  const { textWithTables, tables } = extractMarkdownFromDocxHtml(html);

  return {
    text: textWithTables || (await mammoth.extractRawText({ buffer })).value.trim(),
    html,
    tables
  };
}

/**
 * DOCX HTML에서 Table을 Markdown 표로 치환하고 문단 줄바꿈 보존
 */
function extractMarkdownFromDocxHtml(html) {
  if (!html) return { textWithTables: '', tables: [] };

  const tables = [];
  const tableRegex = /<table[\s>]([\s\S]*?)<\/table>/gi;

  let processed = html.replace(tableRegex, (match) => {
    const mdTable = convertHtmlTableToMarkdown(match);
    if (mdTable) {
      tables.push(mdTable);
      return `\n\n${mdTable.markdown}\n\n`;
    }
    return '';
  });

  // 문단 태그 정리 (<p> -> \n\n, <h1>~<h6> -> ### , <br> -> \n)
  processed = processed
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n### $1\n\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    textWithTables: processed,
    tables
  };
}

/**
 * HTML <table> 문자열을 Markdown 표로 변환
 */
function convertHtmlTableToMarkdown(tableHtml) {
  const rowRegex = /<tr[\s>]([\s\S]*?)<\/tr>/gi;
  const rows = [];
  let rMatch;

  while ((rMatch = rowRegex.exec(tableHtml)) !== null) {
    const trContent = rMatch[1];
    const cellRegex = /<(?:td|th)[\s>]([\s\S]*?)<\/(?:td|th)>/gi;
    const cells = [];
    let cMatch;

    while ((cMatch = cellRegex.exec(trContent)) !== null) {
      const cellContent = cMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      cells.push(cellContent.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return null;

  const colCount = Math.max(...rows.map(r => r.length));
  if (colCount === 0) return null;

  const normalizedRows = rows.map(r => {
    while (r.length < colCount) r.push('');
    return r;
  });

  const headerRow = normalizedRows[0];
  const headerLine = `| ${headerRow.join(' | ')} |`;
  const separatorLine = `| ${new Array(colCount).fill('---').join(' | ')} |`;
  const bodyLines = normalizedRows.slice(1).map(r => `| ${r.join(' | ')} |`);

  const markdown = [headerLine, separatorLine, ...bodyLines].join('\n');

  return {
    markdown,
    rows: normalizedRows,
    rowCount: normalizedRows.length,
    colCount
  };
}

export default {
  parseDocx
};
