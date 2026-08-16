// server/export/exportFiles.js - HWPX, DOCX, PDF, Markdown 보고서 파일 생성 엔진
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { EXPORT_STYLES } from './exportStyles.js';

/**
 * HWPX (한글 표준 포맷) 파일 생성
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.contentMarkdown
 * @param {object} options.reviewData
 * @returns {Promise<Buffer>}
 */
export async function generateHwpx({ title = '법률검토의견서', contentMarkdown = '', reviewData = {} }) {
  const zip = new JSZip();

  // 1. mimetype (압축 없이 첫 번째 파일로 저장)
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });

  // 2. META-INF/container.xml
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/>
  </ocf:rootfiles>
</ocf:container>`);

  // 3. Contents/content.hpf
  zip.file('Contents/content.hpf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.hancom.co.kr/hwpml/2011/package" version="1.0">
  <metadata>
    <title>${escapeXml(title)}</title>
    <creator>Legal Reviewer Standalone</creator>
    <date>${new Date().toISOString()}</date>
  </metadata>
  <manifest>
    <item id="header" href="header.xml" media-type="application/xml"/>
    <item id="section0" href="section0.xml" media-type="application/xml"/>
  </manifest>
  <spine>
    <itemref idref="section0"/>
  </spine>
</package>`);

  // 4. Contents/header.xml
  zip.file('Contents/header.xml', `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.0">
  <hh:docInfo>
    <hh:title>${escapeXml(title)}</hh:title>
  </hh:docInfo>
</hh:head>`);

  // 5. Contents/section0.xml (본문 문단 생성)
  const lines = (contentMarkdown || '').split('\n');
  const paragraphsXml = [];

  // 문서 메인 타이틀
  paragraphsXml.push(`
    <hp:p id="p0">
      <hp:run>
        <hp:secPr/>
        <hp:t>${escapeXml(title)}</hp:t>
      </hp:run>
    </hp:p>
    <hp:p id="p1"><hp:run><hp:t></hp:t></hp:run></hp:p>
  `);

  let pId = 2;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphsXml.push(`<hp:p id="p${pId++}"><hp:run><hp:t></hp:t></hp:run></hp:p>`);
      continue;
    }

    const safeText = escapeXml(trimmed);
    paragraphsXml.push(`
      <hp:p id="p${pId++}">
        <hp:run>
          <hp:t>${safeText}</hp:t>
        </hp:run>
      </hp:p>
    `);
  }

  const sectionXml = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
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
        <w:t xml:space="preserve">${escapeXml(line)}</w:t>
      </w:r>
    </w:p>
  `).join('\n');

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="44"/></w:rPr><w:t>${escapeXml(title)}</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t></w:t></w:r></w:p>
    ${docxParagraphs}
  </w:body>
</w:document>`);

  return await zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * PDF 문서 생성 (PDFKit 기반)
 */
export async function generatePdf({ title = '법률검토의견서', contentMarkdown = '' }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const buffers = [];

      doc.on('data', b => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      // 제목
      doc.fontSize(18).text(title, { align: 'center' });
      doc.moveDown(1.5);

      // 본문 텍스트
      const lines = contentMarkdown.split('\n');
      for (const line of lines) {
        if (line.startsWith('# ')) {
          doc.moveDown(0.5);
          doc.fontSize(15).text(line.replace('# ', ''), { underline: true });
          doc.moveDown(0.3);
        } else if (line.startsWith('## ')) {
          doc.moveDown(0.4);
          doc.fontSize(12).text(line.replace('## ', ''));
          doc.moveDown(0.2);
        } else if (line.startsWith('### ')) {
          doc.fontSize(10.5).text(line.replace('### ', ''));
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          doc.fontSize(9.5).text(`  • ${line.substring(2)}`);
        } else if (line.startsWith('> ')) {
          doc.fontSize(9).fillColor('#475569').text(`   ${line.substring(2)}`);
          doc.fillColor('#000000');
        } else {
          doc.fontSize(9.5).text(line);
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
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
