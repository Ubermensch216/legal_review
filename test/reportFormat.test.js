import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import pdfParse from 'pdf-parse';
import { parseReportBlocks, renderReportBlocksHtml } from '../public/js/reportFormat.js';
import { generateDocx, generateHwpx, generatePdf } from '../server/export/exportFiles.js';
import { stripFalseDocumentAbsence } from '../server/reasoning/contractReview.js';

const sample = `### 1. 주요 쟁점

**검토 결과**를 확인합니다.

| 항목 | 판단 | 권고 |
| --- | --- | --- |
| 지급 조건 | 검토 필요 | 기한 명시 |

- 계약서 원문 확인
- 조문 대조`;

test('의견서 Markdown을 화면용 제목·표·목록으로 안전하게 변환한다', () => {
  const blocks = parseReportBlocks(sample);
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'table', 'list']);
  assert.deepEqual(blocks[2].headers, ['항목', '판단', '권고']);
  const html = renderReportBlocksHtml(blocks);
  assert.match(html, /<h4[^>]*>1\. 주요 쟁점<\/h4>/);
  assert.match(html, /<table[^>]*>/);
  assert.match(html, /<li>계약서 원문 확인<\/li>/);
  assert.doesNotMatch(html, /###|\| ---|\*\*/);
  assert.doesNotMatch(renderReportBlocksHtml(parseReportBlocks('### <script>alert(1)</script>')), /<script>/);
});

test('기존 한 줄 저장본의 제목을 복원하고 새 보고서의 줄바꿈은 보존한다', () => {
  const old = '# 계약서 법률검토의견서 ## 1. 검토 요약 주요 결과입니다. ## 2. 핵심 위험 - 지급 조건: 기한 확인';
  assert.deepEqual(parseReportBlocks(old).map(block => block.type), ['heading', 'heading', 'paragraph', 'heading', 'list']);
  const source = '## 1. 검토 요약\n\n내용\n\n| 항목 | 판단 |\n| --- | --- |';
  assert.equal(stripFalseDocumentAbsence(source, { get: () => null }).text, source);
});

test('DOCX·HWPX·PDF 다운로드가 구조와 한글 내용을 유지한다', async () => {
  const args = { contentMarkdown: sample, reviewData: { review: { reviewStatus: 'COMPLETE' }, meta: { preset: 'contract_risk' } } };
  const docx = await JSZip.loadAsync(await generateDocx(args));
  const wordXml = await docx.file('word/document.xml').async('string');
  assert.match(wordXml, /<w:tbl>/);
  assert.match(wordXml, /<w:b\/>/);
  assert.match(wordXml, /지급 조건/);
  assert.doesNotMatch(wordXml, /###|\| ---|\*\*/);

  const hwpx = await JSZip.loadAsync(await generateHwpx(args));
  const sectionXml = await hwpx.file('Contents/section0.xml').async('string');
  assert.match(sectionXml, /지급 조건/);
  assert.match(sectionXml, /권고: 기한 명시/);
  assert.doesNotMatch(sectionXml, /###|\| ---|\*\*/);

  const pdf = await pdfParse(await generatePdf(args));
  assert.match(pdf.text, /1\. 주요 쟁점/);
  assert.match(pdf.text, /기한 명시/);
  assert.doesNotMatch(pdf.text, /###|\| ---|\*\*/);
});
