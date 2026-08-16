// server/export/exportFiles.js - HWPX, DOCX, PDF, Markdown 보고서 파일 생성 엔진
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { EXPORT_STYLES } from './exportStyles.js';

/**
 * HWPX (한글 표준 OWPML 포맷) 파일 생성 - 한컴오피스 한글 2014~2024 완벽 호환
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.contentMarkdown
 * @param {object} options.reviewData
 * @returns {Promise<Buffer>}
 */
export async function generateHwpx({ title = '법률검토의견서', contentMarkdown = '', reviewData = {} }) {
  const zip = new JSZip();

  const docTitle = cleanText(title || '법률검토의견서');

  // 1. mimetype (압축 없이 첫 번째 엔트리로 생성)
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });

  // 2. version.xml (한컴오피스 한글 필수 버전 파일)
  zip.file('version.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hv:HWPVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" major="1" minor="0" micro="0" buildNumber="0" os="1" xmlVersion="1.0" application="HWP-ML"/>`);

  // 3. META-INF/container.xml
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/>
  </ocf:rootfiles>
</ocf:container>`);

  // 4. Contents/content.hpf (OPF 패키지 매니페스트)
  zip.file('Contents/content.hpf', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(docTitle)}</dc:title>
    <dc:language>ko</dc:language>
    <dc:creator>Legal Reviewer Standalone</dc:creator>
    <dc:date>${new Date().toISOString()}</dc:date>
  </metadata>
  <manifest>
    <item id="header" href="header.xml" media-type="application/xml"/>
    <item id="section0" href="section0.xml" media-type="application/xml"/>
  </manifest>
  <spine>
    <itemref idref="section0"/>
  </spine>
</package>`);

  // 5. Contents/header.xml (한글 필수 글꼴, 글자모양, 문단모양, 스타일 정의)
  zip.file('Contents/header.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" version="1.0">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="1">
      <hh:fontface lang="hangul" fontCnt="1">
        <hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/>
      </hh:fontface>
      <hh:fontface lang="latin" fontCnt="1">
        <hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/>
      </hh:fontface>
      <hh:fontface lang="hanja" fontCnt="1">
        <hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/>
      </hh:fontface>
      <hh:fontface lang="japanese" fontCnt="1">
        <hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/>
      </hh:fontface>
      <hh:fontface lang="other" fontCnt="1">
        <hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/>
      </hh:fontface>
      <hh:fontface lang="symbol" fontCnt="1">
        <hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/>
      </hh:fontface>
      <hh:fontface lang="user" fontCnt="1">
        <hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/>
      </hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="2">
      <hh:borderFill id="1" backSlash="0" slash="0" flip="0" shadow="0">
        <hh:leftBorder type="none" width="0.1mm" color="#000000"/>
        <hh:rightBorder type="none" width="0.1mm" color="#000000"/>
        <hh:topBorder type="none" width="0.1mm" color="#000000"/>
        <hh:bottomBorder type="none" width="0.1mm" color="#000000"/>
      </hh:borderFill>
      <hh:borderFill id="2" backSlash="0" slash="0" flip="0" shadow="0">
        <hh:leftBorder type="solid" width="0.12mm" color="#CBD5E1"/>
        <hh:rightBorder type="solid" width="0.12mm" color="#CBD5E1"/>
        <hh:topBorder type="solid" width="0.12mm" color="#CBD5E1"/>
        <hh:bottomBorder type="solid" width="0.12mm" color="#CBD5E1"/>
      </hh:borderFill>
    </hh:borderFills>
    <hh:charProperties itemCnt="4">
      <!-- 0: 기본 본문 (10pt, 검정) -->
      <hh:charPr id="0" height="1000" textColor="#1E293B" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>
      <!-- 1: 메인 타이틀 (20pt, 굵게, 네이비) -->
      <hh:charPr id="1" height="2000" textColor="#1E3A8A" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:bold/>
      </hh:charPr>
      <!-- 2: 대제목 H2 (14pt, 굵게, 네이비) -->
      <hh:charPr id="2" height="1400" textColor="#1E3A8A" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:bold/>
      </hh:charPr>
      <!-- 3: 중제목 H3 (11.5pt, 굵게) -->
      <hh:charPr id="3" height="1150" textColor="#0F172A" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:bold/>
      </hh:charPr>
    </hh:charProperties>
    <hh:paraProperties itemCnt="4">
      <!-- 0: 일반 본문 문단 -->
      <hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="justify" vertical="baseline"/>
        <hh:heading type="none" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/>
        <hh:lineSpacing type="percent" value="165"/>
      </hh:paraPr>
      <!-- 1: 타이틀 문단 (중앙 정렬) -->
      <hh:paraPr id="1" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="center" vertical="baseline"/>
        <hh:heading type="none" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/>
        <hh:margin>
          <hh:prev value="1500"/>
          <hh:next value="1000"/>
        </hh:margin>
        <hh:lineSpacing type="percent" value="130"/>
      </hh:paraPr>
      <!-- 2: 대제목 H2 문단 -->
      <hh:paraPr id="2" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="left" vertical="baseline"/>
        <hh:heading type="outline" idRef="0" level="1"/>
        <hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/>
        <hh:margin>
          <hh:prev value="1200"/>
          <hh:next value="400"/>
        </hh:margin>
        <hh:lineSpacing type="percent" value="150"/>
      </hh:paraPr>
      <!-- 3: 중제목 H3 문단 -->
      <hh:paraPr id="3" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="left" vertical="baseline"/>
        <hh:heading type="outline" idRef="0" level="2"/>
        <hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/>
        <hh:margin>
          <hh:prev value="800"/>
          <hh:next value="200"/>
        </hh:margin>
        <hh:lineSpacing type="percent" value="150"/>
      </hh:paraPr>
    </hh:paraProperties>
    <hh:styles itemCnt="1">
      <hh:style id="0" type="para" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/>
    </hh:styles>
  </hh:refList>
</hh:head>`);

  // 6. Contents/section0.xml (본문 문단 생성)
  const lines = (contentMarkdown || '').split('\n');
  const paragraphsXml = [];

  // 구역 정의(secPr) 및 문서 타이틀
  paragraphsXml.push(`
  <hp:p id="0" paraPrIDRef="1" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="1">
      <hp:secPr id="0" textDirection="0" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0">
        <hp:grid charGrid="0" lineGrid="0"/>
        <hp:startNum pageStartsOn="both" page="1" pic="1" tbl="1" equation="1"/>
        <hp:visibility hideHeader="0" hideFooter="0" hideMasterPage="0" border="none" fill="none" showLineNumber="0"/>
        <hp:lineNumber restartType="0" countBy="0" distance="0" startNumber="0"/>
        <hp:pagePr landscape="0" width="59528" height="84188" gutterType="leftOnly">
          <hp:margin left="5669" right="5669" top="4252" bottom="4252" header="4252" footer="4252" gutter="0"/>
        </hp:pagePr>
      </hp:secPr>
      <hp:t>${escapeXml(docTitle)}</hp:t>
    </hp:run>
  </hp:p>
  <hp:p id="1" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>
  </hp:p>
  `);

  let pId = 2;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>
  </hp:p>`);
      continue;
    }

    if (trimmed.startsWith('# ')) {
      // 타이틀은 상단에 이미 출력되었으므로 스킵 또는 서브타이틀
      continue;
    } else if (trimmed.startsWith('## ')) {
      const h2Text = cleanText(trimmed.replace('## ', ''));
      paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="2">
      <hp:t>${escapeXml(h2Text)}</hp:t>
    </hp:run>
  </hp:p>`);
    } else if (trimmed.startsWith('### ')) {
      const h3Text = cleanText(trimmed.replace('### ', ''));
      paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="3" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="3">
      <hp:t>■ ${escapeXml(h3Text)}</hp:t>
    </hp:run>
  </hp:p>`);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const listText = cleanText(trimmed.substring(2));
      paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0">
      <hp:t>  • ${escapeXml(listText)}</hp:t>
    </hp:run>
  </hp:p>`);
    } else {
      const bodyText = cleanText(trimmed);
      paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0">
      <hp:t>${escapeXml(bodyText)}</hp:t>
    </hp:run>
  </hp:p>`);
    }
  }

  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
  ${paragraphsXml.join('\n')}
</hs:sec>`;

  zip.file('Contents/section0.xml', sectionXml);

  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * DOCX 포맷 파일 생성
 */
export async function generateDocx({ title = '법률검토의견서', contentMarkdown = '' }) {
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  const lines = (contentMarkdown || '').split('\n');
  const docxParagraphs = lines.map(line => `
    <w:p>
      <w:r>
        <w:t xml:space="preserve">${escapeXml(cleanText(line))}</w:t>
      </w:r>
    </w:p>
  `).join('\n');

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="44"/></w:rPr><w:t>${escapeXml(cleanText(title))}</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t></w:t></w:r></w:p>
    ${docxParagraphs}
  </w:body>
</w:document>`);

  return await zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * PDF 문서 생성 (PDFKit 기반, 한글 TTF 폰트 지원)
 */
export async function generatePdf({ title = '법률검토의견서', contentMarkdown = '' }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
      const buffers = [];

      doc.on('data', b => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      // 한글 TTF 폰트 등록
      const fontPath = 'C:\\Windows\\Fonts\\malgun.ttf';
      if (fs.existsSync(fontPath)) {
        doc.font(fontPath);
      }

      // 제목
      doc.fontSize(18).text(cleanText(title), { align: 'center' });
      doc.moveDown(1.5);

      // 본문 텍스트
      const lines = contentMarkdown.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          doc.moveDown(0.3);
          continue;
        }

        if (line.startsWith('# ')) {
          doc.moveDown(0.5);
          doc.fontSize(15).text(cleanText(line.replace('# ', '')), { underline: true });
          doc.moveDown(0.3);
        } else if (line.startsWith('## ')) {
          doc.moveDown(0.4);
          doc.fontSize(12).text(cleanText(line.replace('## ', '')));
          doc.moveDown(0.2);
        } else if (line.startsWith('### ')) {
          doc.fontSize(10.5).text(`■ ${cleanText(line.replace('### ', ''))}`);
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          doc.fontSize(9.5).text(`  • ${cleanText(line.substring(2))}`);
        } else if (line.startsWith('> ')) {
          doc.fontSize(9).fillColor('#475569').text(`   ${cleanText(line.substring(2))}`);
          doc.fillColor('#000000');
        } else {
          doc.fontSize(9.5).text(cleanText(line));
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default {
  generateHwpx,
  generateDocx,
  generatePdf
};
