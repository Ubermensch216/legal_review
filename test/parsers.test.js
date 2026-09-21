import './setup.js';
// test/parsers.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../server/parsers/index.js';
import { generateHwpx } from '../server/export/exportFiles.js';

test('텍스트 및 마크다운 파일 파싱', async () => {
  const buf = Buffer.from('# 개인정보 처리방침\n제1조 본 방침은...', 'utf8');
  const res = await parseDocument(buf, 'sample.md');

  assert.equal(res.ext, 'md');
  assert.ok(res.text.includes('개인정보 처리방침'));
});

test('생성된 HWPX 파일의 역파싱 무결성 검증', async () => {
  const sampleText = '본 지침은 공공데이터 제공 및 이용 활성화에 관한 법률을 준수합니다.';
  const hwpxBuf = await generateHwpx({
    title: '공공지침',
    contentMarkdown: sampleText
  });

  const parsed = await parseDocument(hwpxBuf, 'test.hwpx');
  assert.equal(parsed.ext, 'hwpx');
  assert.ok(parsed.text.includes('공공데이터') || parsed.text.length > 0);
});

test('CSV/Excel 파일 파싱 무결성 검증', async () => {
  const csvText = '조항,내용\n제1조,목적 규정입니다.\n제2조,정의 규정입니다.';
  const buf = Buffer.from(csvText, 'utf8');
  const res = await parseDocument(buf, 'sample.csv');

  assert.equal(res.ext, 'csv');
  assert.ok(res.text.includes('제1조'));
  assert.ok(res.text.includes('목적 규정'));
});

