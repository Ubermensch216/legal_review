// test/export.test.js - HWPX, DOCX, PDF 생성 및 OWPML 표준 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { generateHwpx, generateDocx, generatePdf } from '../server/export/exportFiles.js';

test('HWPX 생성 및 OCF/OWPML 표준 구조 무결성 검증', async () => {
  const buffer = await generateHwpx({
    title: '테스트 법률검토서',
    contentMarkdown: '## 1. 검토배경\n본문 내용입니다.\n- 항목 1\n- 항목 2'
  });

  assert.ok(buffer instanceof Buffer, '버퍼가 생성되어야 함');
  assert.ok(buffer.length > 500, '유효한 크기의 HWPX 압축 파일이어야 함');

  // ZIP 내부 표준 구조 확인
  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('mimetype'), 'mimetype 파일이 존재해야 함');
  assert.ok(zip.file('version.xml'), 'version.xml 파일이 존재해야 함');
  assert.ok(zip.file('META-INF/container.xml'), 'META-INF/container.xml이 존재해야 함');
  assert.ok(zip.file('META-INF/manifest.xml'), 'META-INF/manifest.xml이 존재해야 함');
  assert.ok(zip.file('settings.xml'), 'settings.xml이 존재해야 함');
  assert.ok(zip.file('Contents/content.hpf'), 'Contents/content.hpf가 존재해야 함');
  assert.ok(zip.file('Contents/header.xml'), 'header.xml이 존재해야 함');
  assert.ok(zip.file('Contents/section0.xml'), 'section0.xml이 존재해야 함');

  // header.xml 필수 요소 검증
  const headerXml = await zip.file('Contents/header.xml').async('string');
  assert.ok(headerXml.includes('<hh:tabProperties'), 'tabProperties가 선언되어야 함');
  assert.ok(headerXml.includes('<hh:fontfaces'), 'fontfaces가 선언되어야 함');
  assert.ok(headerXml.includes('<hh:paraProperties'), 'paraProperties가 선언되어야 함');
  assert.ok(headerXml.includes('<hh:charProperties'), 'charProperties가 선언되어야 함');

  // section0.xml 구역(secPr) 속성 검증
  const sectionXml = await zip.file('Contents/section0.xml').async('string');
  assert.ok(sectionXml.includes('<hp:secPr'), 'secPr이 존재해야 함');
  assert.ok(sectionXml.includes('<hp:pagePr'), 'pagePr이 존재해야 함');
  assert.ok(sectionXml.includes('<hp:footNotePr>'), 'footNotePr이 존재해야 함');
});

test('HWPX 한글(HWP) 호환성 - 손상 파일 판정 유발 요소 검증', async () => {
  const buffer = await generateHwpx({ title: '호환성 검증', contentMarkdown: '본문' });
  const zip = await JSZip.loadAsync(buffer);
  const read = name => zip.file(name).async('string');

  // 1) version.xml의 루트는 반드시 HCFVersion (HWPVersion이면 한글이 열지 못함)
  const versionXml = await read('version.xml');
  assert.ok(versionXml.includes('<hv:HCFVersion'), 'version.xml 루트는 hv:HCFVersion이어야 함');
  assert.ok(!versionXml.includes('HWPVersion'), 'HWPVersion은 한글이 인식하지 못하는 비표준 요소임');

  // 2) container.xml의 rootfile media-type
  const containerXml = await read('META-INF/container.xml');
  assert.ok(
    containerXml.includes('media-type="application/hwpml-package+xml"'),
    'content.hpf의 media-type은 application/hwpml-package+xml이어야 함'
  );

  // 3) content.hpf의 href는 패키지 루트 기준이며 spine에 header가 포함되어야 함
  const hpf = await read('Contents/content.hpf');
  assert.ok(hpf.includes('href="Contents/header.xml"'), 'header href는 패키지 루트 기준이어야 함');
  assert.ok(hpf.includes('href="Contents/section0.xml"'), 'section0 href는 패키지 루트 기준이어야 함');
  assert.ok(hpf.includes('href="settings.xml"'), 'settings href는 패키지 루트 기준이어야 함');
  assert.ok(!hpf.includes('href="../'), 'href에 상위 경로(../)를 쓰면 안 됨');
  assert.ok(hpf.includes('idref="header"'), 'spine에 header가 포함되어야 함');

  // 4) container.xml이 참조하는 Preview/PrvText.txt가 실제로 존재해야 함
  assert.ok(zip.file('Preview/PrvText.txt'), 'Preview/PrvText.txt가 존재해야 함');

  // 5) header.xml 루트 속성 및 스키마상 필수 요소
  const headerXml = await read('Contents/header.xml');
  assert.match(headerXml, /<hh:head[^>]+secCnt="1"/, 'hh:head에 secCnt 속성이 있어야 함');
  assert.ok(headerXml.includes('<hh:compatibleDocument'), 'compatibleDocument가 있어야 함');
  assert.ok(headerXml.includes('<hh:docOption>'), 'docOption이 있어야 함');
  assert.ok(!headerXml.includes('<hh:docInfo>'), 'hh:docInfo는 스키마에 없는 요소임');
  assert.ok(headerXml.includes('lang="HANGUL"'), 'fontface lang은 대문자여야 함');
  assert.ok(headerXml.includes('<hh:diagonal'), 'borderFill에 diagonal이 있어야 함');

  // 6) OWPML 열거형 값은 모두 대문자여야 함 (소문자면 한글이 손상으로 판정)
  const sectionXml = await read('Contents/section0.xml');
  for (const [name, badValue] of [
    ['align horizontal', 'horizontal="justify"'],
    ['align vertical', 'vertical="baseline"'],
    ['lineSpacing type', 'type="percent"'],
    ['style type', 'type="para"'],
    ['font type', 'type="ttf"']
  ]) {
    assert.ok(!headerXml.includes(badValue), `${name} 열거형 값은 대문자여야 함`);
  }
  assert.ok(!sectionXml.includes('gutterType="leftOnly"'), 'gutterType 열거형 값은 대문자여야 함');
  assert.ok(sectionXml.includes('<hp:lineNumberShape'), 'hp:lineNumber가 아니라 hp:lineNumberShape여야 함');

  // 7) 모든 XML 파트가 well-formed여야 함
  for (const name of [
    'version.xml', 'settings.xml', 'META-INF/container.xml', 'META-INF/manifest.xml',
    'Contents/content.hpf', 'Contents/header.xml', 'Contents/section0.xml'
  ]) {
    const xml = await read(name);
    assert.equal(XMLValidator.validate(xml), true, `${name}이 well-formed XML이어야 함`);
  }

  // 8) mimetype은 압축 없이(STORE) 첫 번째 엔트리로 저장되어야 함
  assert.equal(await read('mimetype'), 'application/hwp+zip');
  assert.equal(
    buffer.slice(30, 38).toString(), 'mimetype',
    'mimetype이 ZIP의 첫 엔트리이며 비압축(STORE)이어야 함'
  );
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
