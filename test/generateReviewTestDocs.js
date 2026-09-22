// test/generateReviewTestDocs.js
// 검토 시스템 E2E 점검용 샘플 문서 5종 생성기
// 지원 입력 포맷 전체(hwpx / pdf / docx / xlsx / csv / txt)를 한 번에 커버한다.
//   실행: node test/generateReviewTestDocs.js
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { generateHwpx, generatePdf } from '../server/export/exportFiles.js';

const targetDir = path.join(process.cwd(), 'test', 'docs', 'review-samples');
fs.mkdirSync(targetDir, { recursive: true });

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* ------------------------------------------------------------------ */
/* DOCX 라이터 (mammoth 파싱 대상 최소 OOXML)                          */
/* ------------------------------------------------------------------ */
async function buildDocx({ paragraphs = [], table = null }) {
  const zip = new JSZip();
  const p = (text, style) => {
    const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
    return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  };
  const body = paragraphs.map((item) => (
    typeof item === 'string' ? p(item) : p(item.text, item.style)
  )).join('');

  let tableXml = '';
  if (table) {
    const rows = table.rows.map((row) => {
      const cells = row.map((cell) => (
        `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${p(cell)}</w:tc>`
      )).join('');
      return `<w:tr>${cells}</w:tr>`;
    }).join('');
    tableXml = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>'
      + '<w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/>'
      + '<w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/>'
      + '<w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/>'
      + `</w:tblBorders></w:tblPr>${rows}</w:tbl>`;
  }

  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>');

  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');

  zip.file('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>');

  const styleDef = (id, name, outline) => (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>`
    + `<w:pPr><w:outlineLvl w:val="${outline}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`
  );
  zip.file('word/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + styleDef('Heading1', 'heading 1', 0)
    + styleDef('Heading2', 'heading 2', 1)
    + styleDef('Heading3', 'heading 3', 2)
    + '</w:styles>');

  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}${tableXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>`
    + '</w:document>');

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ------------------------------------------------------------------ */
/* XLSX 라이터 (read-excel-file 파싱 대상 최소 OOXML)                  */
/* ------------------------------------------------------------------ */
function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

async function buildXlsx({ sheetName = 'Sheet1', rows = [] }) {
  const shared = [];
  const sharedIndex = new Map();
  const sharedId = (value) => {
    if (sharedIndex.has(value)) return sharedIndex.get(value);
    const id = shared.length;
    shared.push(value);
    sharedIndex.set(value, id);
    return id;
  };

  const rowsXml = rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      const ref = `${colName(c)}${r + 1}`;
      if (cell === null || cell === undefined || cell === '') return '';
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        return `<c r="${ref}"><v>${cell}</v></c>`;
      }
      return `<c r="${ref}" t="s"><v>${sharedId(String(cell))}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const maxCols = rows.reduce((m, row) => Math.max(m, row.length), 1);
  const dimension = `A1:${colName(maxCols - 1)}${Math.max(rows.length, 1)}`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>');

  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>');

  zip.file('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);

  zip.file('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>');

  zip.file('xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/></font></fonts>'
    + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    + '</styleSheet>');

  zip.file('xl/sharedStrings.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">`
    + shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
    + '</sst>');

  zip.file('xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="${dimension}"/><sheetData>${rowsXml}</sheetData></worksheet>`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const toCsv = (rows) => rows.map((row) => row.map((cell) => {
  const str = cell === null || cell === undefined ? '' : String(cell);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}).join(',')).join('\r\n');

/* ------------------------------------------------------------------ */
/* HWPX 표 주입기                                                       */
/*  generateHwpx()는 마크다운 표를 표 객체로 만들지 않으므로,            */
/*  생성된 패키지의 section0.xml에 hp:tbl 블록을 직접 끼워 넣어          */
/*  hwpxParser의 표 추출 경로까지 테스트되도록 한다.                     */
/* ------------------------------------------------------------------ */
async function injectHwpxTable(hwpxBuffer, rows) {
  const zip = await JSZip.loadAsync(hwpxBuffer);
  const sectionPath = 'Contents/section0.xml';
  const sectionXml = await zip.file(sectionPath).async('text');

  const cellXml = (text, col, row) =>
    `<hp:tc name="" header="${row === 0 ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="2">`
    + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
    + `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`
    + `<hp:run charPrIDRef="${row === 0 ? 3 : 0}"><hp:t>${esc(text)}</hp:t></hp:run></hp:p></hp:subList>`
    + `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/>`
    + `<hp:cellSz width="14000" height="2000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;

  const trXml = rows.map((row, r) =>
    `<hp:tr>${row.map((cell, c) => cellXml(cell, c, r)).join('')}</hp:tr>`
  ).join('');

  const tableXml =
    `<hp:p id="9000" paraPrIDRef="3" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`
    + `<hp:run charPrIDRef="3"><hp:t>[별표] 신·구 조문 대비표</hp:t></hp:run></hp:p>`
    + `<hp:p id="9001" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">`
    + `<hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" `
    + `dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${rows[0].length}" cellSpacing="0" borderFillIDRef="2" noAdjust="0">`
    + `<hp:sz width="42000" widthRelTo="ABSOLUTE" height="${rows.length * 2000}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" `
    + `vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>`
    + `${trXml}</hp:tbl></hp:run></hp:p>`;

  // 면책 고지 문단 앞(= 마지막 문단 앞)에 삽입
  const lastParaIdx = sectionXml.lastIndexOf('<hp:p ');
  const patched = sectionXml.slice(0, lastParaIdx) + tableXml + '\n' + sectionXml.slice(lastParaIdx);

  zip.file(sectionPath, patched);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export { buildDocx, buildXlsx, toCsv, injectHwpxTable };

/* ================================================================== */
/* 시나리오 1 — HWPX : 취업규칙 전부개정(안)                            */
/*  프리셋: 인사/노무/근로기준                                          */
/*  기대 탐지: 포괄임금, 주52시간 초과, 청문 없는 즉시 징계해고, 면책조항 */
/* ================================================================== */
const employmentRulesMarkdown = `# [취업규칙 전부개정(안)] 주식회사 OO테크 취업규칙

## 제1장 총칙

### 제1조 (목적)
이 규칙은 근로기준법 제93조에 따라 주식회사 OO테크(이하 「회사」라 한다) 소속 근로자의 근로조건, 복무규율 및 징계에 관한 사항을 정함을 목적으로 한다.

### 제2조 (적용 범위)
이 규칙은 회사에 근로를 제공하는 모든 근로자에게 적용한다. 다만, 연구개발직 및 프로젝트 수행직에 대하여는 제3장의 근로시간 규정을 적용하지 아니한다.

---

## 제2장 임금

### 제18조 (포괄임금제)
1. 회사는 연구개발직 및 프로젝트 수행직 근로자에 대하여 월 고정연장근로 80시간분의 수당을 기본급에 포함하여 지급하는 포괄임금제를 적용한다.
2. 제1항의 포괄임금을 지급받는 근로자는 실제 연장·야간·휴일근로시간이 고정연장근로시간을 초과하더라도 추가 수당의 지급을 청구하거나 이의를 제기할 수 없다.
3. 근로자는 입사와 동시에 제1항의 포괄임금제에 동의한 것으로 본다.

### 제20조 (연차유급휴가 미사용수당)
연차유급휴가를 사용하지 아니한 경우 그 미사용 휴가는 회계연도 말일에 자동 소멸하며, 미사용수당은 지급하지 아니한다.

---

## 제3장 근로시간

### 제23조 (연장근로)
1. 회사는 프로젝트 납기 준수를 위하여 필요한 경우 근로자 개별 동의 없이 1주 12시간을 초과하는 연장근로를 명할 수 있으며, 이 경우 1주 최대 근로시간은 68시간으로 한다.
2. 제1항의 연장근로 지시를 정당한 사유 없이 거부한 근로자에 대하여는 제31조에 따른 징계를 할 수 있다.

### 제25조 (휴게시간)
휴게시간은 근로시간 도중에 부여함을 원칙으로 하되, 업무 특성상 부득이한 경우 근로시간 종료 후에 일괄하여 부여할 수 있다.

---

## 제4장 징계 및 해고

### 제31조 (징계해고)
1. 회사는 근로자가 다음 각 호의 어느 하나에 해당하는 경우 청문 절차 없이 즉시 해고할 수 있다.
   1. 무단결근이 2일 이상 계속된 경우
   2. 회사의 명예를 훼손하였다고 대표이사가 판단한 경우
   3. 제23조의 연장근로 지시를 2회 이상 거부한 경우
2. 제1항의 해고는 서면 통지를 갈음하여 구두 또는 사내 메신저 통보로 할 수 있다.
3. 징계해고된 근로자는 해고의 효력에 대하여 이의를 제기할 수 없다.

### 제34조 (경업금지 및 위약벌)
퇴직 후 2년간 동종업계에 취업한 근로자는 최종 연봉의 3배에 해당하는 금액을 위약벌로 회사에 지급한다.

---

## 제5장 보칙

### 제40조 (면책)
업무상 재해 및 직장 내 괴롭힘 사건과 관련하여 회사는 고의가 없는 한 민·형사상 책임을 일체 부담하지 아니한다.

### 제41조 (규칙의 변경)
이 규칙의 변경은 근로자 과반수의 의견 청취로 갈음하며, 불이익 변경의 경우에도 별도 동의 없이 시행할 수 있다.

## 검토 요청 사항
1. 제18조 포괄임금제 및 제23조 연장근로 조항의 근로기준법 제50조·제53조·제56조 위반 여부
2. 제31조 징계해고 절차의 근로기준법 제27조(해고의 서면통지) 및 제23조(정당한 이유) 저촉 여부
3. 제41조 불이익 변경 절차의 근로기준법 제94조 위반 여부 및 개정안 수정 대안
`;


/* 시나리오 1 부속 — HWPX 본문에 주입할 신·구 조문 대비표 */
const employmentRulesDiffTable = [
  ['조문', '현    행', '개 정 안', '비고'],
  ['제18조', '연장근로수당은 실근로시간에 따라 지급한다.', '월 고정연장근로 80시간분을 기본급에 포함하여 지급하고, 초과분은 청구할 수 없다.', '근로기준법 제56조 저촉 검토'],
  ['제23조', '연장근로는 당사자 간 합의로 1주 12시간을 한도로 한다.', '근로자 개별 동의 없이 1주 68시간까지 연장근로를 명할 수 있다.', '근로기준법 제53조 저촉 검토'],
  ['제31조', '징계해고는 인사위원회 의결과 서면 통지를 거친다.', '청문 절차 없이 즉시 해고할 수 있고 구두 통보로 갈음한다.', '근로기준법 제27조 저촉 검토'],
  ['제34조', '(신설)', '퇴직 후 2년간 동종업계 취업 시 최종 연봉의 3배를 위약벌로 지급한다.', '근로기준법 제20조 위약 예정 금지 검토'],
  ['제41조', '불이익 변경 시 근로자 과반수 동의를 받는다.', '의견 청취로 갈음하고 별도 동의 없이 시행한다.', '근로기준법 제94조 저촉 검토']
];

/* ================================================================== */
/* 시나리오 2 — DOCX : 정보시스템 구축 용역계약서(갑 우위 초안)          */
/*  프리셋: 계약서 리스크 분석                                          */
/*  기대 탐지: 위약벌 3배, 일방적 면책, 최고 없는 즉시 해지, 표 파싱      */
/* ================================================================== */
const serviceContractDocx = {
  paragraphs: [
    { text: '정보시스템 구축 용역계약서 (갑 제시 초안)', style: 'Heading1' },
    '발주기관 OO공공기관(이하 "갑"이라 한다)과 수급인 주식회사 OO SI(이하 "을"이라 한다)는 차세대 통합업무시스템 구축에 관하여 다음과 같이 계약을 체결한다.',
    { text: '제1조 (계약의 목적)', style: 'Heading2' },
    '본 계약은 갑이 발주하는 차세대 통합업무시스템의 분석·설계·개발·이행 및 안정화 용역의 수행에 관한 갑과 을의 권리와 의무를 정함을 목적으로 한다.',
    { text: '제2조 (계약기간 및 총 계약금액)', style: 'Heading2' },
    '계약기간은 2026년 1월 5일부터 2026년 12월 31일까지로 하고, 총 계약금액은 금 일십이억원(₩1,200,000,000, 부가가치세 포함)으로 한다.',
    { text: '제7조 (과업 범위의 변경)', style: 'Heading2' },
    '갑은 계약금액의 증액 없이 과업내용의 추가·변경을 을에게 요구할 수 있으며, 을은 이에 대하여 이의를 제기할 수 없다. 과업 변경에 따른 추가 투입 인건비는 을이 부담한다.',
    { text: '제11조 (지체상금 및 위약벌)', style: 'Heading2' },
    '을이 납기를 준수하지 못한 경우 지체일수 1일당 계약금액의 1천분의 3에 해당하는 지체상금을 부과하고, 이와 별도로 총 계약금액의 3배에 해당하는 금액을 위약벌로 갑에게 지급한다. 지체상금과 위약벌의 합계액에는 상한을 두지 아니한다.',
    { text: '제14조 (계약의 해지)', style: 'Heading2' },
    '갑은 을의 귀책사유를 불문하고 갑의 예산 사정, 사업계획 변경 또는 갑이 필요하다고 인정하는 경우 최고 없이 해지할 수 있으며, 이 경우 을이 이미 투입한 비용 및 기성 부분에 대한 대가는 지급하지 아니한다.',
    { text: '제17조 (손해배상 및 면책)', style: 'Heading2' },
    '본 시스템의 하자, 장애 또는 정보 유출로 제3자에게 손해가 발생한 경우 갑은 귀책사유를 불문하고 일체의 손해배상 책임을 지지 아니하며, 을이 전액 배상한다. 을의 배상 한도는 제한하지 아니한다.',
    { text: '제19조 (지식재산권 및 산출물)', style: 'Heading2' },
    '본 용역 수행 과정에서 을이 기존에 보유하던 범용 모듈 및 라이브러리를 포함한 모든 산출물과 그 지식재산권은 갑에게 원시적으로 귀속하며, 을은 이를 타 사업에 재사용하지 아니한다.',
    { text: '제22조 (하도급 대금 및 인력 관리)', style: 'Heading2' },
    '을은 갑의 사전 서면 승인 없이 하도급을 할 수 없으며, 갑은 을의 투입인력에 대하여 직접 근태를 지시·관리하고 부적격하다고 판단되는 인력의 즉시 교체를 요구할 수 있다.',
    { text: '제25조 (분쟁의 해결)', style: 'Heading2' },
    '본 계약에 관한 분쟁은 갑의 주된 사무소 소재지 관할 법원을 전속 관할로 하며, 을은 국가를 당사자로 하는 계약에 관한 법률에 따른 이의신청 및 분쟁조정 절차를 진행하지 아니한다.',
    { text: '[별표] 대금 지급 일정', style: 'Heading2' }
  ],
  table: {
    rows: [
      ['구분', '지급 시기', '지급 비율', '금액(원)', '지급 조건'],
      ['선금', '착수일로부터 30일', '10%', '120,000,000', '갑이 필요하다고 인정하는 경우에만 지급'],
      ['1차 기성', '분석·설계 완료', '20%', '240,000,000', '갑의 검사 합격 시'],
      ['2차 기성', '개발 완료', '30%', '360,000,000', '갑의 검사 합격 시'],
      ['잔금', '검수 완료 후 90일', '40%', '480,000,000', '하자보수보증금 공제 후 지급']
    ]
  }
};

/* ================================================================== */
/* 시나리오 3 — PDF : 행정처분 사전통지 및 의견제출서                    */
/*  프리셋: 행정처분/민원 대응 + 검토 기준 시점(2023-11-15) 테스트       */
/* ================================================================== */
const adminDispositionMarkdown = `# [행정처분 사전통지서 및 의견제출서] 식품접객업 영업정지 처분 사전통지

## 1. 처분 개요

- **처분청**: OO시 OO구청장
- **수범자(영업자)**: 주식회사 OO푸드 (영업소 명칭: OO다이닝)
- **위반 적발일**: 2023년 11월 15일
- **사전통지 발송일**: 2023년 12월 4일
- **처분 예정 내용**: 영업정지 2개월 및 과징금 부과
- **처분 근거**: 식품위생법 제44조(영업자 등의 준수사항), 제75조(허가취소 등), 같은 법 시행규칙 제89조 [별표 23] 행정처분 기준

> 본 건은 **2023년 11월 15일 적발 당시 시행 중이던 법령**을 기준으로 검토되어야 한다. 이후 시행된 개정 조문은 처분의 근거가 될 수 없다.

---

## 2. 처분청이 적시한 위반 사실

### ■ 위반사실 1 — 유통기한 경과 원료 보관
2023년 11월 15일 위생 점검 당시 주방 냉장고에서 유통기한이 12일 경과한 소스류 3종이 조리 목적으로 보관 중인 것으로 확인되었다.

### ■ 위반사실 2 — 조리장 위생 상태 불량
조리장 바닥 및 배수구의 오염이 확인되었으며, 종업원 2명의 건강진단 결과서가 비치되어 있지 아니하였다.

### ■ 위반사실 3 — 영업신고 사항 미변경
영업장 면적을 32㎡ 확장하였음에도 변경신고를 하지 아니하였다.

---

## 3. 절차적 쟁점 (영업자 의견)

### ■ 쟁점 1 — 의견제출 기간의 부여
사전통지서에 기재된 의견제출 기한은 통지서 수령일로부터 7일이었다. 행정절차법 제21조 제3항이 정한 상당한 기간에 미달하는지 여부가 문제된다.

### ■ 쟁점 2 — 청문 절차의 생략
처분청은 영업정지 처분에 대하여 청문 절차 없이 의견제출만으로 처분을 진행하려 하고 있다. 식품위생법 제81조 및 행정절차법 제22조상 청문 실시 대상 여부에 대한 검토가 필요하다.

### ■ 쟁점 3 — 처분기준 적용의 적정성
처분청은 위반사실 1·2·3을 병합하여 가중 처분(영업정지 2개월)을 예고하였다. 시행규칙 [별표 23]의 1차 위반 기준 및 차수 가중 규정, 감경 사유(식품위생법 시행규칙 [별표 23] 일반기준의 감경 규정) 적용 여부가 쟁점이다.

### ■ 쟁점 4 — 과징금 대체 가능성
식품위생법 제82조에 따른 영업정지 처분에 갈음하는 과징금 부과 신청이 가능한지, 가능하다면 그 산정 기준과 제외 사유(같은 법 시행령 [별표 1]) 해당 여부.

---

## 4. 검토 요청 사항

1. **2023년 11월 15일 시점**에 시행 중이던 식품위생법·시행령·시행규칙 3단 체계를 기준으로 위 처분의 실체적·절차적 적법성을 판단할 것.
2. 청문 절차 생략 및 7일의 의견제출 기간 부여가 절차적 하자에 해당하여 처분의 취소사유가 되는지 여부(대법원 판례 근거 포함).
3. 위반사실 3(면적 변경 미신고)이 영업정지 사유에 병합될 수 있는지, 별도 과태료 사안인지 구분할 것.
4. 감경 또는 과징금 전환을 전제로 한 의견제출서 문안과 행정심판 청구 시 방어 논리를 함께 제시할 것.
5. 부칙 및 경과조치에 따라 적용 법령이 달라질 여지가 있으면 그 제한 사항을 명시할 것.

---

## 5. 처분청이 적용한 조문 (사전통지서 별지 발췌)

### 제44조 (영업자 등의 준수사항)
식품접객영업자는 유통기한이 경과된 원료 또는 완제품을 조리·판매의 목적으로 소분·운반·진열·보관하거나 이를 판매하여서는 아니 된다.

### 제75조 (허가취소 등)
식품의약품안전처장 또는 특별자치시장·특별자치도지사·시장·군수·구청장은 영업자가 제44조를 위반한 경우 영업허가 또는 등록을 취소하거나 6개월 이내의 기간을 정하여 그 영업의 전부 또는 일부를 정지할 수 있다.

### 제81조 (청문)
처분청은 제75조에 따른 영업허가 또는 등록의 취소 처분을 하려면 청문을 하여야 한다.

### 제82조 (영업정지 등의 처분에 갈음하여 부과하는 과징금 처분)
처분청은 영업자가 제75조에 해당하여 영업정지 처분을 하여야 하는 경우에는 대통령령으로 정하는 바에 따라 영업정지 처분을 갈음하여 10억원 이하의 과징금을 부과할 수 있다.

### 제89조 (행정처분의 기준)
제75조에 따른 행정처분의 세부기준은 그 위반 행위의 유형과 위반 횟수 등을 고려하여 [별표 23]으로 정한다.
`;

/* ================================================================== */
/* 시나리오 4 — XLSX + CSV : 개인정보 처리현황표 / 수탁사 목록           */
/*  프리셋: 개인정보/보안 규제                                          */
/*  기대 탐지: 영구 보관, 비식별 조치 없이, 제3자 제공, 간주 동의        */
/* ================================================================== */
const privacyInventoryRows = [
  ['연번', '처리 업무', '수집 항목', '민감정보 포함', '수집 근거', '보유기간', '제3자 제공', '국외 이전', '안전성 확보조치', '점검 의견'],
  [1, '회원 가입 및 본인확인', '성명, 생년월일, 휴대전화번호, 이메일, 주민등록번호', '아니오', '이용약관 동의(가입 시 동의한 것으로 본다)', '영구 보관', '없음', '없음', '주민등록번호 암호화 처리를 갈음하여 접근통제로 대체', '수집 근거 및 암호화 조치 적정성 검토 필요'],
  [2, '얼굴인식 출입관리', '얼굴 특징벡터, 출입기록, 재직정보', '예', '사내 규정(정보주체 별도 동의 없이 수집)', '퇴직 후 10년', '보안 관제 협력사에 제공', '없음', '평문 저장(DB 암호화 미적용)', '민감정보 별도 동의 및 암호화 여부 검토'],
  [3, '마케팅 광고 발송', '성명, 휴대전화번호, 구매이력, 접속 로그', '아니오', '회원가입 시 포괄적 동의', '탈퇴 후 5년', '광고 대행사 3개사에 제공', '없음', '전송구간 암호화 적용', '포괄 동의의 유효성 및 수신동의 별도 획득 여부'],
  [4, 'AI 추천모델 학습', '구매이력, 접속 로그, 위치정보', '아니오', '정당한 이익(별도 동의 없이 활용)', '영구 보관', '민간 솔루션 개발 협력업체에 비식별 조치 없이 제공', '미국(AWS us-east-1)', '가명처리 미적용', '가명정보 처리 요건 및 국외이전 고지 여부 검토'],
  [5, '채용 지원자 관리', '성명, 학력, 경력, 건강검진 결과, 가족관계', '예', '지원서 제출로 동의 간주', '불합격 후 3년', '없음', '없음', '지원서 파일 공유 폴더 보관', '민감정보 수집 최소화 및 파기 절차 검토'],
  [6, '고객 상담 녹취', '통화 음성녹음, 성명, 연락처', '아니오', '상담 개시 안내 음성(동의를 생략)', '5년', '외주 콜센터 위탁', '없음', '녹취파일 접근권한 미분리', '수집 동의 방식 및 위탁 고지 여부 검토'],
  [7, 'CCTV 영상 관제', '영상정보, 음성 녹음, 차량번호', '아니오', '안내판 게시', '3년', '관할 경찰서 요청 시 제공', '없음', '음성 녹음 기능 상시 활성화', '개인정보 보호법 제25조 음성녹음 금지 저촉 여부'],
  ['', '', '', '', '', '', '', '', '', ''],
  ['[검토 요청]', '위 처리현황표 각 행에 대하여 개인정보 보호법 제15조·제17조·제22조·제23조·제24조의2·제25조·제28조의2·제28조의8 및 같은 법 시행령 저촉 여부를 행별로 판정하고, 위반 항목은 조치사항과 개선 문안을 제시할 것.', '', '', '', '', '', '', '', '']
];

const processorListRows = [
  ['수탁사명', '위탁 업무', '제공 항목', '계약 체결일', '재위탁 여부', '동의/고지 방식', '파기 조항', '비고'],
  ['OO데이터테크', '회원 DB 운영·유지보수', '성명, 연락처, 주민등록번호', '2024-03-02', '있음(재위탁 사전 승인 조항 없음)', '홈페이지 처리방침 게시', '계약 종료 후 즉시 파기', '재위탁 승인 절차 부재'],
  ['OO애드컴', '광고 발송 대행', '성명, 휴대전화번호, 구매이력', '2024-05-20', '없음', '별도 고지 없음', '없음', '위탁 사실 고지 누락 의심'],
  ['OO AI랩', '추천모델 학습 데이터 제공', '구매이력, 접속 로그, 위치정보', '2025-01-15', '있음', '별도 동의 없이 제공', '영구 보관', '비식별 조치 없이 제공, 국외 재이전 가능성'],
  ['OO콜센터', '고객 상담 및 녹취 관리', '음성녹음, 성명, 연락처', '2023-09-01', '없음', '상담 개시 안내 음성', '3년 후 파기', '수탁사 교육·감독 기록 미비'],
  ['OO시큐리티', '출입 보안 관제', '얼굴 특징벡터, 출입기록', '2025-06-30', '있음', '사내 공지', '없음', '민감정보 위탁, 안전성 확보조치 점검 필요']
];

/* ================================================================== */
/* 시나리오 5 — TXT : 사전 컨설팅감사 신청서(갑설·을설)                  */
/*  프리셋: 사전 컨설팅감사 의견 + 검토 기준 시점(2021-03-02) 테스트     */
/* ================================================================== */
const consultingAuditText = `[사전 컨설팅감사 신청서]

1. 신청 기관 : OO군 지역경제과
2. 신 청 일 : 2021년 3월 2일
3. 검토 기준 시점 : 2021-03-02 (사업 공고일 기준)
4. 제 목 : 군 자체 재원 소상공인 경영안정자금의 지원 대상에 관내 사업장을 둔 비거주 사업자를 포함할 수 있는지 여부

5. 신청 배경
OO군은 「OO군 소상공인 지원에 관한 조례」 제9조에 따라 경영안정자금(이자 차액 보전)을 지원하고 있다. 위 조례 제9조 제1항은 "군에 주소를 두고 관내에서 6개월 이상 영업 중인 소상공인"을 지원 대상으로 규정하고 있다. 그런데 관내에 사업장을 두고 실제 영업을 하면서도 인접 시에 주민등록을 둔 사업자들로부터 지원 배제가 부당하다는 민원이 지속 제기되고 있다.

6. 쟁점
관내 사업장을 두었으나 군에 주민등록을 두지 아니한 소상공인을 조례 개정 없이 지침(사업 공고)으로 지원 대상에 포함할 수 있는지 여부.

7. 대립 견해

가. 갑설 (포함 가능 — 적극행정 추진 의견)
 1) 조례 제9조의 "주소를 두고"는 사업장 소재를 의미하는 것으로 목적론적 해석이 가능하다.
 2) 지원 목적이 관내 상권 활성화에 있으므로 실제 영업지가 관내이면 조례의 목적에 부합한다.
 3) 수익적 행정행위의 대상 확대는 주민의 권리를 제한하거나 의무를 부과하는 것이 아니므로, 지방자치법상 법률유보 원칙이 적용되지 아니하고 집행기관의 재량 범위 내에서 지침으로 정할 수 있다.
 4) 유사 사례로 인접 지자체가 사업 공고만으로 대상을 확대한 사례가 있다.

나. 을설 (포함 불가 — 소극 의견)
 1) 조례 제9조는 "군에 주소를 두고"라고 명시하고 있어 문언상 주민등록 요건이 명확하며, 지침으로 조례의 명문 요건을 배제하는 것은 조례 위반이다.
 2) 예산의 배분 기준을 집행기관이 임의로 확대하는 것은 「지방재정법」 제3조(예산의 효율적 운용) 및 군 의회의 예산 심의·의결권을 침해할 소지가 있다.
 3) 수익적 행정이라 하더라도 한정된 재원의 배분 기준은 조례로 정한다는 것이 조례 제정 취지이며, 지침으로 이를 변경하면 다른 탈락자와의 평등원칙 문제가 발생한다.
 4) 사후 감사에서 지적될 경우 담당자의 책임 문제가 발생할 수 있다.

8. 신청 기관 의견
갑설이 타당하다고 판단되나, 조례 문언과의 충돌 가능성이 있어 사전 컨설팅감사를 신청한다.

9. 검토 요청 사항
 1) 2021년 3월 2일 시점에 시행 중이던 「지방자치법」, 「지방재정법」, 「소상공인 보호 및 지원에 관한 법률」 및 관련 시행령을 기준으로 갑설·을설의 타당성을 비교할 것.
 2) 자치법규(조례·규칙) 및 행정규칙(지침·공고)의 규율 한계 관점에서 지침에 의한 대상 확대의 적법성을 판정할 것.
 3) 수용 또는 반려 처리 의견을 명시하고, 수용하는 경우 조건(조례 개정 병행 여부, 공고 문안 수정안, 소급 적용 범위)을 제시할 것.
 4) 반려하는 경우 신청 기관이 취할 수 있는 대안(조례 개정 절차와 소요 기간, 한시적 구제 방안)을 제시할 것.
 5) 적극행정 면책(「적극행정 운영규정」) 적용 가능성과 그 요건 충족 여부를 함께 검토할 것.
 6) 부칙·경과조치로 인하여 적용 법령이 달라질 여지가 있으면 제한 사항으로 명시할 것.

10. 참고 — 관련 자치법규 조문 발췌 (OO군 소상공인 지원에 관한 조례)

제9조 (지원 대상)
 1. 경영안정자금의 지원 대상은 군에 주소를 두고 관내에서 6개월 이상 계속하여 영업 중인 소상공인으로 한다.
 2. 제1항의 요건에 관한 세부 사항은 군수가 따로 정하는 지침으로 정한다.

제10조 (신청 및 심사)
 1. 지원을 받으려는 자는 군수가 정하는 서식에 따라 신청하여야 한다.
 2. 군수는 심사위원회의 심사를 거쳐 지원 여부와 지원 규모를 결정한다.

제12조 (지원금의 환수)
 1. 거짓이나 그 밖의 부정한 방법으로 지원을 받은 경우 군수는 지원금의 전부 또는 일부를 환수한다.
 2. 제1항에 따른 환수 대상자는 환수 처분에 대하여 이의를 제기할 수 없다.
`;

/* ------------------------------------------------------------------ */
/* 실행부                                                              */
/* ------------------------------------------------------------------ */
const written = [];
function save(fileName, buffer) {
  const filePath = path.join(targetDir, fileName);
  fs.writeFileSync(filePath, buffer);
  written.push({ fileName, size: buffer.length });
  console.log(`  ✓ ${fileName.padEnd(44)} ${(buffer.length / 1024).toFixed(1)} KB`);
}

async function main() {
  console.log('[ReviewSamples] 검토 대상 샘플 문서 생성 중...\n');

  const employmentRulesHwpx = await generateHwpx({
    title: '주식회사 OO테크 취업규칙 전부개정(안)',
    contentMarkdown: employmentRulesMarkdown
  });
  save('01_취업규칙_전부개정안.hwpx', await injectHwpxTable(employmentRulesHwpx, employmentRulesDiffTable));

  save('02_정보시스템_구축_용역계약서.docx', await buildDocx(serviceContractDocx));

  save('03_영업정지_사전통지_의견제출서.pdf', await generatePdf({
    title: '식품접객업 영업정지 처분 사전통지 검토요청서',
    contentMarkdown: adminDispositionMarkdown
  }));

  save('04_개인정보_처리현황표.xlsx', await buildXlsx({
    sheetName: '개인정보 처리현황',
    rows: privacyInventoryRows
  }));

  save('04_개인정보_수탁사목록.csv', Buffer.from('﻿' + toCsv(processorListRows), 'utf8'));

  save('05_사전컨설팅감사_신청서.txt', Buffer.from(consultingAuditText, 'utf8'));

  console.log(`\n[ReviewSamples] 완료 — ${written.length}개 파일: ${targetDir}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith('generateReviewTestDocs.js');
if (isDirectRun) {
  main().catch((err) => {
    console.error('[ReviewSamples Error]', err);
    process.exit(1);
  });
}
