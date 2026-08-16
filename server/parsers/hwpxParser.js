// server/parsers/hwpxParser.js - HWPX (한글 표준 문서) XML 파서
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true
});

/**
 * HWPX 버퍼 또는 Base64에서 텍스트와 표 추출
 * @param {Buffer} buffer 
 * @returns {Promise<{text: string, tables: Array<any>, metadata: object}>}
 */
export async function parseHwpx(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('유효한 HWPX 파일 버퍼가 아닙니다.');
  }

  const zip = await JSZip.loadAsync(buffer);
  const textParts = [];
  const tables = [];

  // 1. 메타데이터 파싱 (header.xml 또는 version.xml)
  let metadata = { format: 'HWPX' };
  const headerFile = zip.file('Contents/header.xml');
  if (headerFile) {
    const headerXml = await headerFile.async('text');
    try {
      const headerObj = xmlParser.parse(headerXml);
      metadata.header = headerObj;
    } catch {
      // ignore
    }
  }

  // 2. 본문 섹션 파싱 (Contents/section0.xml, section1.xml ...)
  const sectionFiles = Object.keys(zip.files).filter(name => 
    name.startsWith('Contents/section') && name.endsWith('.xml')
  ).sort();

  for (const filename of sectionFiles) {
    const file = zip.file(filename);
    if (!file) continue;

    const xmlContent = await file.async('text');
    const sectionText = extractTextFromSectionXml(xmlContent);
    if (sectionText) {
      textParts.push(sectionText);
    }
  }

  const fullText = textParts.join('\n\n');

  return {
    text: fullText,
    tables,
    metadata
  };
}

/**
 * Section XML 내의 <hp:t> (텍스트 노드) 추출
 */
function extractTextFromSectionXml(xml) {
  if (!xml) return '';

  // 정규식을 사용한 빠른 텍스트 태그 추출 (<hp:t> ... </hp:t> or <t> ... </t>)
  const matches = xml.match(/<(?:hp:)?t(?:[^>]*)>([^<]*)<\/(?:hp:)?t>/gi);
  if (!matches) {
    // 태그 제거 후 fallback
    return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const lines = [];
  let currentLine = '';

  for (const m of matches) {
    const textVal = m.replace(/<[^>]+>/g, '').trim();
    if (textVal) {
      lines.push(textVal);
    }
  }

  return lines.join(' ');
}

export default {
  parseHwpx
};
