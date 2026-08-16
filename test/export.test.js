// test/export.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generateHwpx, generateDocx, generatePdf } from '../server/export/exportFiles.js';

test('HWPX 생성 및 OCF 구조 무결성 검증', async () => {
  const buffer = await generateHwpx({
    title: '테스트 법률검토서',
    contentMarkdown: '# 제목\n\n본문 내용입니다.\n- 항목 1\n- 항목 2'
  });

  assert.ok(buffer instanceof Buffer, '버퍼가 생성되어야 함');
  assert.ok(buffer.length > 500, '유효한 크기의 HWPX 압축 파일이어야 함');

  // ZIP 내부 구조 확인
  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('mimetype'), 'mimetype 파일이 존재해야 함');
  assert.ok(zip.file('Contents/section0.xml'), 'section0.xml이 존재해야 함');
  assert.ok(zip.file('Contents/header.xml'), 'header.xml이 존재해야 함');
});

test('DOCX 생성 및 구조 검증', async () => {
  const buffer = await generateDocx({
    title: 'DOCX 검토서',
    contentMarkdown: '테스트 내용'
  });

  assert.ok(buffer instanceof Buffer);
  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('word/document.xml'));
});

test('PDF 생성 검증', async () => {
  const buffer = await generatePdf({
    title: 'PDF 검토서',
    contentMarkdown: '# 제목\n본문'
  });

  assert.ok(buffer instanceof Buffer);
  assert.ok(buffer.length > 100);
  assert.equal(buffer.slice(0, 4).toString(), '%PDF');
});
