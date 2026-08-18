// server/parsers/hwpxParser.js - HWPX (한글 표준 OWPML) 정밀 파서 및 표/문단 구조 복원기
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  isArray: (name) => ['hp:p', 'hp:run', 'hp:tr', 'hp:tc', 'hp:tbl', 'p', 'run', 'tr', 'tc', 'tbl'].includes(name)
});

/**
 * HWPX 버퍼에서 텍스트와 표(Markdown 변환) 및 구조 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, tables: Array<any>, metadata: object}>}
 */
export async function parseHwpx(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 HWPX 파일 버퍼가 아닙니다.');
  }

  const zip = await JSZip.loadAsync(buffer);
  const textParts = [];
  const extractedTables = [];

  // 1. 메타데이터 파싱 (header.xml)
  let metadata = { format: 'HWPX' };
  const headerFile = zip.file('Contents/header.xml');
  if (headerFile) {
    try {
      const headerXml = await headerFile.async('text');
      metadata.header = xmlParser.parse(headerXml);
    } catch {
      // ignore
    }
  }

  // 2. 본문 섹션 파일 탐색 (Contents/section0.xml ...)
  const sectionFiles = Object.keys(zip.files).filter(name => 
    name.startsWith('Contents/section') && name.endsWith('.xml')
  ).sort();

  for (const filename of sectionFiles) {
    const file = zip.file(filename);
    if (!file) continue;

    const xmlContent = await file.async('text');
    const { sectionText, tables } = parseSectionXmlWithTables(xmlContent);
    if (sectionText) {
      textParts.push(sectionText);
    }
    if (tables && tables.length > 0) {
      extractedTables.push(...tables);
    }
  }

  const fullText = textParts.join('\n\n');

  return {
    text: fullText,
    tables: extractedTables,
    metadata
  };
}

/**
 * Section XML 내의 표(<hp:tbl>) 및 문단(<hp:p>) 계층 구조 파싱
 */
function parseSectionXmlWithTables(xml) {
  if (!xml) return { sectionText: '', tables: [] };

  const tables = [];

  // 1. XML 내의 <hp:tbl> 태그를 정규식/매칭으로 탐색하여 Markdown Table로 치환
  const tableRegex = /<(?:hp:)?tbl[\s>]([\s\S]*?)<\/(?:hp:)?tbl>/gi;
  
  const processedXml = xml.replace(tableRegex, (match) => {
    const mdTable = convertHwpxTableToMarkdown(match);
    if (mdTable) {
      tables.push(mdTable);
      return `<hp:p><hp:run><hp:t>\n\n${mdTable.markdown}\n\n</hp:t></hp:run></hp:p>`;
    }
    return '';
  });

  // 2. 문단 단위(<hp:p>)로 텍스트 추출 및 조립
  const paragraphRegex = /<(?:hp:)?p[\s>]([\s\S]*?)<\/(?:hp:)?p>/gi;
  const paragraphs = [];
  let pMatch;

  while ((pMatch = paragraphRegex.exec(processedXml)) !== null) {
    const pContent = pMatch[1];
    const textNodes = pContent.match(/<(?:hp:)?t(?:[^>]*)>([\s\S]*?)<\/(?:hp:)?t>/gi);

    if (textNodes) {
      const pText = textNodes
        .map(tNode => tNode.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join(' ');

      if (pText) {
        paragraphs.push(pText);
      }
    }
  }

  // 문단이 정상 추출되지 않은 경우 정규식 fallback
  if (paragraphs.length === 0) {
    const fallbackMatches = xml.match(/<(?:hp:)?t(?:[^>]*)>([^<]*)<\/(?:hp:)?t>/gi);
    if (fallbackMatches) {
      paragraphs.push(fallbackMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join(' '));
    }
  }

  return {
    sectionText: paragraphs.join('\n\n'),
    tables
  };
}

/**
 * HWPX 표 XML 문자열을 마크다운 표로 변환
 */
function convertHwpxTableToMarkdown(tblXml) {
  const rowRegex = /<(?:hp:)?tr[\s>]([\s\S]*?)<\/(?:hp:)?tr>/gi;
  const rows = [];
  let rMatch;

  while ((rMatch = rowRegex.exec(tblXml)) !== null) {
    const trContent = rMatch[1];
    const cellRegex = /<(?:hp:)?tc[\s>]([\s\S]*?)<\/(?:hp:)?tc>/gi;
    const cells = [];
    let cMatch;

    while ((cMatch = cellRegex.exec(trContent)) !== null) {
      const tcContent = cMatch[1];
      const textMatches = tcContent.match(/<(?:hp:)?t(?:[^>]*)>([\s\S]*?)<\/(?:hp:)?t>/gi);
      const cellText = textMatches 
        ? textMatches.map(t => t.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join(' ')
        : '';
      cells.push(cellText.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return null;

  // 최대 컬럼 수 계산
  const colCount = Math.max(...rows.map(r => r.length));
  if (colCount === 0) return null;

  // 균일한 컬럼으로 정규화
  const normalizedRows = rows.map(r => {
    while (r.length < colCount) r.push('');
    return r;
  });

  // 마크다운 표 문자열 생성
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
  parseHwpx
};
