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
    const { sectionText, tables } = parseSectionXml(xmlContent);
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

// ── 본문 XML 해석 ────────────────────────────────────────────
// 문단(hp:p) 안에 표·글상자·각주가 들어가고, 그 안에 다시 문단이 들어간다.
// 정규식으로 첫 </hp:p>에서 끊으면 안쪽 문단이 끝나는 자리에서 바깥 문단이 잘려 뒷글이 사라진다.
// 그래서 태그를 트리로 세운 뒤 순서대로 걷는다.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeText = value => String(value)
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
const localName = name => name.replace(/^[^:]*:/, '');

/** 태그 열기·닫기·글자를 트리로 만든다. 주석·처리 지시문·CDATA는 건너뛰고, 짝이 안 맞는 닫는 태그는 무시한다. */
function buildTree(xml) {
  const root = { name: '#root', children: [] };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = token.exec(xml)) !== null) {
    const [, cdata, closing, rawName, , selfClosing, text] = match;
    const top = stack[stack.length - 1];
    if (cdata !== undefined) { top.children.push({ text: cdata }); continue; }
    if (text !== undefined) { top.children.push({ text }); continue; }
    if (!rawName) continue;
    const name = localName(rawName);
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      continue;
    }
    const node = { name, children: [] };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const isText = node => typeof node.text === 'string';
// 본문에 반복되는 쪽 머리말·꼬리말은 문서 내용이 아니므로 읽지 않는다.
const SKIP = new Set(['header', 'footer', 'secPr', 'pagePr']);

/** t 요소 안의 글자. 줄바꿈·탭 표시는 글자로 바꾼다. */
function textOf(node) {
  let out = '';
  for (const child of node.children) {
    if (isText(child)) out += decodeText(child.text);
    else if (child.name === 'lineBreak') out += '\n';
    else if (child.name === 'tab' || child.name === 'fwSpace' || child.name === 'nbSpace') out += ' ';
    else out += textOf(child);
  }
  return out;
}

/** 어떤 요소 아래의 모든 글자를 문서 순서대로 한 줄로 모은다(표 칸 안의 중첩 표·문단 포함). */
function flatText(node) {
  const parts = [];
  const walk = current => {
    for (const child of current.children) {
      if (isText(child) || SKIP.has(child.name)) continue;
      if (child.name === 't') { const value = textOf(child).replace(/\s+/g, ' ').trim(); if (value) parts.push(value); }
      else walk(child);
    }
  };
  walk(node);
  return parts.join(' ');
}

/** tr·tc 구조에서 행을 읽는다. 칸 안의 중첩 표는 칸 글자로 합쳐 잃지 않게 한다. */
function tableRows(tbl) {
  const rows = [];
  const findRows = node => {
    for (const child of node.children) {
      if (isText(child)) continue;
      if (child.name === 'tr') {
        const cells = child.children.filter(c => !isText(c) && c.name === 'tc')
          .map(cell => flatText(cell).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
        if (cells.length) rows.push(cells);
      } else if (child.name !== 'tbl') findRows(child);
    }
  };
  findRows(tbl);
  return rows;
}

function tableToMarkdown(tbl) {
  const rows = tableRows(tbl);
  if (!rows.length) return null;
  const colCount = Math.max(...rows.map(r => r.length));
  const normalized = rows.map(r => [...r, ...new Array(colCount - r.length).fill('')]);
  const markdown = [`| ${normalized[0].join(' | ')} |`, `| ${new Array(colCount).fill('---').join(' | ')} |`,
    ...normalized.slice(1).map(r => `| ${r.join(' | ')} |`)].join('\n');
  return { markdown, rows: normalized, rowCount: normalized.length, colCount };
}

/**
 * 구역 XML에서 본문 블록과 표를 순서대로 뽑는다.
 * - 문단의 글자는 한 문단으로 잇는다(문장이 중간에 끊기지 않게).
 * - 표는 그 자리에서 문단을 끊고 마크다운으로 넣는다.
 * - 글상자·각주 안의 문단은 바깥 문단 뒤에 이어 붙인다.
 */
function parseSectionXml(xml) {
  if (!xml) return { sectionText: '', tables: [] };
  const blocks = [];
  const tables = [];

  const readParagraph = paragraph => {
    let inline = [];
    const nested = [];
    const flush = () => { const value = inline.join('').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim(); if (value) blocks.push(value); inline = []; };
    const walk = node => {
      for (const child of node.children) {
        if (isText(child) || SKIP.has(child.name)) continue;
        if (child.name === 't') inline.push(textOf(child));
        else if (child.name === 'tbl') {
          flush();
          const table = tableToMarkdown(child);
          if (table) { tables.push(table); blocks.push(table.markdown); }
        } else if (child.name === 'p') nested.push(child);
        else walk(child);
      }
    };
    walk(paragraph);
    flush();
    for (const inner of nested) readParagraph(inner);
  };

  const findParagraphs = node => {
    for (const child of node.children) {
      if (isText(child) || SKIP.has(child.name)) continue;
      if (child.name === 'p') readParagraph(child);
      else if (child.name === 'tbl') {
        const table = tableToMarkdown(child);
        if (table) { tables.push(table); blocks.push(table.markdown); }
      } else findParagraphs(child);
    }
  };
  findParagraphs(buildTree(xml));

  // 문단 구조를 찾지 못한 비표준 파일은 t 요소의 글자만이라도 건진다.
  if (!blocks.length) {
    const rescue = [...xml.matchAll(/<(?:hp:)?t(?:\s[^>]*)?>([^<]*)<\/(?:hp:)?t>/gi)].map(m => decodeText(m[1]).trim()).filter(Boolean);
    if (rescue.length) blocks.push(rescue.join(' '));
  }
  return { sectionText: blocks.join('\n\n'), tables };
}

export default {
  parseHwpx
};
