import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseHwpx } from '../server/parsers/hwpxParser.js';

const t = s => `<hp:run><hp:t>${s}</hp:t></hp:run>`;
async function parse(sectionBody) {
  const zip = new JSZip();
  zip.file('Contents/header.xml', '<h/>');
  zip.file('Contents/section0.xml', `<hs:sec xmlns:hp="x" xmlns:hs="y">${sectionBody}</hs:sec>`);
  return parseHwpx(await zip.generateAsync({ type: 'nodebuffer' }));
}

test('글상자·각주가 들어간 문단도 앞뒤 글이 모두 남고 문장이 이어진다', async () => {
  const { text } = await parse(`<hp:p>${t('앞문장')}<hp:run><hp:rect><hp:drawText><hp:subList><hp:p>${t('글상자문장')}</hp:p></hp:subList></hp:drawText></hp:rect></hp:run>${t('뒷문장')}</hp:p><hp:p>${t('다음문단')}</hp:p>`);
  for (const word of ['앞문장', '글상자문장', '뒷문장', '다음문단']) assert.ok(text.includes(word), word);
  assert.ok(text.includes('앞문장뒷문장'), '바깥 문단의 글은 한 문단으로 이어져야 한다');
  assert.ok(text.indexOf('앞문장뒷문장') < text.indexOf('글상자문장'));
});

test('문단 안의 표는 표로 뽑고 표 뒤의 글도 잃지 않는다', async () => {
  const { text, tables } = await parse(`<hp:p>${t('표앞')}<hp:run><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p>${t('칸내용')}</hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run>${t('표뒤')}</hp:p>`);
  assert.equal(tables.length, 1);
  for (const word of ['표앞', '칸내용', '표뒤']) assert.ok(text.includes(word), word);
  assert.ok(text.indexOf('표앞') < text.indexOf('칸내용') && text.indexOf('칸내용') < text.indexOf('표뒤'));
});

test('표 칸 안의 중첩 표와 그 뒤의 글이 칸 글자로 보존된다', async () => {
  const { tables } = await parse(`<hp:tbl><hp:tr><hp:tc><hp:p>${t('바깥칸A')}</hp:p><hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:p>${t('안쪽칸')}</hp:p></hp:tc></hp:tr></hp:tbl></hp:run>${t('안쪽표뒤')}</hp:p></hp:tc><hp:tc><hp:p>${t('바깥칸B')}</hp:p></hp:tc></hp:tr></hp:tbl>`);
  const row = tables[0].rows[0];
  assert.match(row[0], /바깥칸A.*안쪽칸.*안쪽표뒤/);
  assert.equal(row[1], '바깥칸B');
});

test('엔티티·줄바꿈·접두사 없는 태그·머리말 처리', async () => {
  const { text } = await parse(`<p><run><t>갑 &amp; 을 &lt;별표&gt;<lineBreak/>둘째 줄</t></run></p><hp:p><hp:run><hp:header><hp:p>${t('반복되는머리말')}</hp:p></hp:header></hp:run>${t('본문')}</hp:p>`);
  assert.match(text, /갑 & 을 <별표>\n둘째 줄/);
  assert.ok(text.includes('본문'));
  assert.ok(!text.includes('반복되는머리말'));
});

test('문단 구조가 없는 비표준 파일도 t 요소의 글자는 건진다', async () => {
  const { text } = await parse('<x:y><hp:t>구조없는글</hp:t></x:y>');
  assert.ok(text.includes('구조없는글'));
});
