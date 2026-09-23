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


// DOCX 회귀 시험. mammoth는 xmldom의 parseFromString을 mimeType 없이 호출하므로,
// 0.9 계열이 섞이면 모든 DOCX 업로드가 "the provided mimeType \"undefined\" is not valid"로 실패한다.
// package.json overrides가 mammoth에만 보안 패치된 0.8 계열(^0.8.15)을 쓰도록 고정한다.
test('샘플 DOCX 계약서의 조항 본문과 대금 지급 일정표를 추출한다', async () => {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(new URL('./docs/review-samples/02_정보시스템_구축_용역계약서.docx', import.meta.url));
  const res = await parseDocument(buf, '02_정보시스템_구축_용역계약서.docx');

  assert.equal(res.ext, 'docx');
  assert.match(res.text, /정보시스템 구축 용역계약서/);
  assert.match(res.text, /제1조 \(계약의 목적\)/);
  assert.match(res.text, /차세대 통합업무시스템/);
  for (const clause of ['제7조', '제11조', '제14조', '제17조', '제19조', '제22조']) {
    assert.ok(res.chunks.some(c => c.articleNo === clause), `${clause} 조항이 청크로 분리되어야 한다`);
  }

  assert.equal(res.tables.length, 1);
  const [table] = res.tables;
  assert.equal(table.rowCount, 5);
  assert.equal(table.colCount, 5);
  assert.deepEqual(table.rows[0], ['구분', '지급 시기', '지급 비율', '금액(원)', '지급 조건']);
  assert.deepEqual(table.rows.slice(1).map(r => r[0]), ['선금', '1차 기성', '2차 기성', '잔금']);
  assert.deepEqual(table.rows.slice(1).map(r => r[2]), ['10%', '20%', '30%', '40%']);
});
