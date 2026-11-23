import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, DocumentInputError } from '../server/parsers/index.js';
import { formatErrorResponse } from '../server/law/lawErrors.js';

const OLE = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(300, 7)]);

test('구형 .hwp·.xls·.doc는 깨진 글자로 분석하지 않고 해결 방법을 안내한다', async () => {
  for (const [name, hint] of [['계약서.hwp', /hwpx/], ['명단.xls', /xlsx/], ['공문.doc', /docx/]]) {
    await assert.rejects(parseDocument(OLE, name), err => err instanceof DocumentInputError && hint.test(err.message) && err.statusCode === 400, name);
  }
});

test('지원하지 않는 확장자와 확장자만 바꾼 파일을 거절한다', async () => {
  await assert.rejects(parseDocument(Buffer.from('abc'), '그림.png'), /지원하지 않는 파일 형식/);
  await assert.rejects(parseDocument(Buffer.from('평문 내용입니다. '.repeat(10)), '가짜.hwpx'), /hwpx 파일이 아니거나 손상/);
  await assert.rejects(parseDocument(Buffer.from('평문 내용입니다. '.repeat(10)), '가짜.pdf'), /PDF 파일이 아니거나 손상/);
  await assert.rejects(parseDocument(OLE, '위장.hwpx'), /구형 문서 형식/);
});

test('읽을 글자가 없거나 깨진 문서로는 검토를 시작하지 않는다', async () => {
  await assert.rejects(parseDocument(Buffer.from('  \n\t  \n'), '빈문서.txt'), /읽을 수 있는 글자를 찾지 못했습니다/);
  await assert.rejects(parseDocument(Buffer.from('�'.repeat(40) + '가나다라마바사', 'utf8'), '깨짐.txt'), /글자가 깨져/);
});

test('정상 텍스트·CSV는 그대로 읽는다', async () => {
  const txt = await parseDocument(Buffer.from('제1조(목적) 이 규정은 근로조건을 정한다.', 'utf8'), '규정.txt');
  assert.equal(txt.chunks[0].articleNo, '제1조');
  const csv = await parseDocument(Buffer.from('번호,항목,내용\n1,수집,이름\n', 'utf8'), '표.csv');
  assert.match(csv.text, /수집/);
});

test('입력 문제는 사용자에게 읽히는 메시지와 400으로 응답한다', () => {
  const body = formatErrorResponse(new DocumentInputError('구형 한글(.hwp) 파일은 직접 읽을 수 없습니다.'));
  assert.equal(body.statusCode, 400);
  assert.equal(body.code, 'INVALID_DOCUMENT');
  assert.match(body.message, /hwp/);
});
