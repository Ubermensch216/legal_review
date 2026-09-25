import { reportText, sanitizeExportText } from './reportSafety.js';
// server/export/exportFiles.js - HWPX, DOCX, PDF, Markdown 정형화 공문서 보고서 생성 엔진
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { EXPORT_STYLES } from './exportStyles.js';

/**
 * 관련 법령 조문 근거 목록을 reviewData 및 contentMarkdown에서 안전하게 추출하는 헬퍼
 */
function resolveBasisList(reviewData, contentMarkdown, defaultLawName) {
  return (Array.isArray(reviewData?.review?.legalBasis) ? reviewData.review.legalBasis : []).map(b => ({
    lawName: b.lawName || defaultLawName, articleNo: b.articleNo || '', title: b.title || '',
    relevance: `${b.verificationStatus === 'VERIFIED' ? '[조문 존재 확인]' : '[미검증]'} ${b.relevance || ''} ${b.verificationNote || ''}`.trim()
  }));
}

/**
 * HWPX (한글 표준 OWPML 포맷) 파일 생성 - 한컴오피스 2014~2024 완벽 호환 표준 스펙
 */
export async function generateHwpx({ title = '법률검토의견서', contentMarkdown = '', reviewData = {} }) {
  const zip = new JSZip();
  const docTitle = cleanText((reviewData?.review?.isFallback || (reviewData?.review?.reviewStatus && reviewData.review.reviewStatus !== 'COMPLETE') ? '[검토 미완료] ' : '') + reportTitle(title, reviewData));
  const review = reviewData?.review || {};
  const meta = reviewData?.meta || {};

  const query = cleanText(meta.query || review.facts || docTitle);
  const lawName = cleanText(reportLawName(meta, review));
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const docNo = `LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const basisList = resolveBasisList(reviewData, contentMarkdown, lawName);
  const recommendations = review.recommendations || [];
  const opinionText = reportText(reviewData, contentMarkdown);

  // 공통 네임스페이스 선언 (한컴 정품 HWPX와 동일 세트 — 누락 시 손상 파일로 판정됨)
  const HWPX_NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // 1. mimetype (압축 없이 STORE, 첫 번째 파일)
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });

  // 2. version.xml (루트 엘리먼트는 반드시 HCFVersion)
  zip.file('version.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Legal Reviewer Standalone" appVersion="1.0"/>`);

  // 3. META-INF/container.xml (rootfile media-type은 application/hwpml-package+xml)
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>`);

  // 4. META-INF/manifest.xml (한컴 정품과 동일하게 빈 매니페스트)
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`);

  // 5. settings.xml
  zip.file('settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`);

  // 6. Preview/PrvText.txt (container.xml이 rootfile로 참조하므로 반드시 존재해야 함)
  zip.file('Preview/PrvText.txt', cleanText(`${docTitle}\n${query}`).slice(0, 1000));

  // 7. Contents/content.hpf (href는 패키지 루트 기준, spine에 header 포함)
  zip.file('Contents/content.hpf', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package ${HWPX_NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${escapeXml(docTitle)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">Legal Reviewer Standalone</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">Legal Reviewer Standalone</opf:meta><opf:meta name="CreatedDate" content="text">${nowIso}</opf:meta><opf:meta name="ModifiedDate" content="text">${nowIso}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`);

  // 8. Contents/header.xml
  // 주의: OWPML 스키마의 열거형 값은 모두 대문자다. 소문자로 쓰면 한글이 손상 파일로 판정한다.
  const FONT_LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const fontfacesXml = FONT_LANGS
    .map(lang => `<hh:fontface lang="${lang}" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="5" proportion="3" contrast="2" strokeVariation="0" armStyle="0" letterform="2" midline="0" xHeight="4"/></hh:font></hh:fontface>`)
    .join('');

  const borderFillXml = (id, type, color) =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="${type}" width="0.1 mm" color="${color}"/><hh:rightBorder type="${type}" width="0.1 mm" color="${color}"/><hh:topBorder type="${type}" width="0.1 mm" color="${color}"/><hh:bottomBorder type="${type}" width="0.1 mm" color="${color}"/><hh:diagonal type="SOLID" width="0.1 mm" color="${color}"/></hh:borderFill>`;

  // charPr: 0 본문(10pt) / 1 대제목(20pt 굵게) / 2 섹션제목(13pt 굵게) / 3 중제목(10.5pt 굵게) / 4 면책(9pt 회색)
  const charPrXml = (id, height, textColor, bold) =>
    `<hh:charPr id="${id}" height="${height}" textColor="${textColor}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"><hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>${bold ? '<hh:bold/>' : ''}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>`;

  const charPropertiesXml = [
    charPrXml(0, 1000, '#1E293B', false),
    charPrXml(1, 2000, '#1E3A8A', true),
    charPrXml(2, 1300, '#1E3A8A', true),
    charPrXml(3, 1050, '#0F172A', true),
    charPrXml(4, 900, '#64748B', false)
  ].join('');

  // paraPr: 0 본문 / 1 타이틀(중앙) / 2 섹션제목 / 3 중제목 / 4 면책(중앙)
  const paraPrXml = (id, align, prev, next, lineSpacing) =>
    `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="AUTO"><hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${lineSpacing}" unit="HWPUNIT"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;

  const paraPropertiesXml = [
    paraPrXml(0, 'JUSTIFY', 0, 0, 160),
    paraPrXml(1, 'CENTER', 1000, 1000, 130),
    paraPrXml(2, 'LEFT', 1400, 400, 150),
    paraPrXml(3, 'LEFT', 800, 200, 150),
    paraPrXml(4, 'CENTER', 1600, 400, 140)
  ].join('');

  zip.file('Contents/header.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head ${HWPX_NS} version="1.5" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="7">${fontfacesXml}</hh:fontfaces><hh:borderFills itemCnt="2">${borderFillXml(1, 'NONE', '#000000')}${borderFillXml(2, 'SOLID', '#CBD5E1')}</hh:borderFills><hh:charProperties itemCnt="5">${charPropertiesXml}</hh:charProperties><hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties><hh:numberings itemCnt="1"><hh:numbering id="1" start="0"><hh:paraHead start="1" level="1" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead></hh:numbering></hh:numberings><hh:bullets itemCnt="0"/><hh:paraProperties itemCnt="5">${paraPropertiesXml}</hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles></hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="0"/></hh:head>`);

  // 8. Contents/section0.xml
  const paragraphsXml = [];
  let pId = 0;

  // 메인 타이틀 문단
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="1" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="1">
      <hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">
        <hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>
        <hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="5669" right="5669" top="4252" bottom="4252"/></hp:pagePr>
        <hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.1 mm" color="#000000"/><hp:noteSpacing betweenNotes="850" belowLine="567" aboveLine="567"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>
        <hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.1 mm" color="#000000"/><hp:noteSpacing betweenNotes="850" belowLine="567" aboveLine="567"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>
        <hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>
        <hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>
        <hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>
      </hp:secPr>
      <hp:t>${escapeXml(docTitle)}</hp:t>
    </hp:run>
  </hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>
  `);

  // 상단 메타 정보
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="3"><hp:t>[문서번호] </hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>${escapeXml(docNo)}   |   </hp:t></hp:run><hp:run charPrIDRef="3"><hp:t>[검토일자] </hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>${escapeXml(todayStr)}</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="3"><hp:t>[검토대상] </hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>${escapeXml(query)}</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="3"><hp:t>[주요법령] </hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>${escapeXml(lawName)}</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>
  `);

  // 1. 검토 배경 및 질의 요지
  if (meta.preset !== 'contract_risk') {
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="2"><hp:t>1. 검토 배경 및 질의 요지</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>  • ${escapeXml(cleanText(meta.preset === 'contract_risk' ? query : review.facts || query))}</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>
  `);

  // 2. 법률적 쟁점 및 심층 검토 의견
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="2"><hp:t>2. 법률적 쟁점 및 심층 검토 의견</hp:t></hp:run></hp:p>
  `);
  }

  const opinionParagraphs = cleanText(opinionText).split('\n\n').filter(Boolean);
  for (const block of opinionParagraphs) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('[') || line.startsWith('■') || /^[0-9]\./.test(line)) {
        paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="3" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="3"><hp:t>${escapeXml(line)}</hp:t></hp:run></hp:p>`);
      } else {
        paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${escapeXml(line)}</hp:t></hp:run></hp:p>`);
      }
    }
  }
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>
  `);

  if (meta.preset !== 'contract_risk') {
  // 3. 리스크 평가 및 보완 조치 사항
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="2"><hp:t>3. 리스크 평가 및 보완 조치 사항</hp:t></hp:run></hp:p>
  `);

  if (recommendations.length > 0) {
    recommendations.forEach((rec, idx) => {
      paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="3"><hp:t>  [조치 ${idx + 1}] </hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>${escapeXml(cleanText(rec))}</hp:t></hp:run></hp:p>`);
    });
  } else {
    paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>  • 상위 법령 위임 범위 준수 및 사전 증빙 체계 정비 필요</hp:t></hp:run></hp:p>`);
  }
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>
  `);

  // 4. 관련 법령 및 조문 근거표 (항상 내용 보장)
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="2"><hp:t>4. 관련 법령 및 조문 근거표</hp:t></hp:run></hp:p>
  `);

  basisList.forEach(b => {
    paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="3" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="3"><hp:t>■ ${escapeXml(b.lawName || lawName)} ${escapeXml(b.articleNo || '')} (${escapeXml(b.title || '')})</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>   - 적용 및 연계성: ${escapeXml(cleanText(b.relevance || '본 사안의 적법성 검토 기준 조항'))}</hp:t></hp:run></hp:p>`);
  });

  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>
  `);

  }
  // 면책 고지
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="4" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="4"><hp:t>${escapeXml(review.disclaimer || '※ 본 검토의견서는 AI 법령검토 시스템에 의해 작성된 참고자료이며, 최종 법적 분쟁 및 처분에 대해서는 법률전문가의 자문을 받으시기 바랍니다.')}</hp:t></hp:run></hp:p>
  `);

  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec ${HWPX_NS}>
  ${paragraphsXml.join('\n')}
</hs:sec>`;

  zip.file('Contents/section0.xml', sectionXml);

  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

/**
 * DOCX 포맷 파일 생성
 */
export async function generateDocx({ title = '법률검토의견서', contentMarkdown = '', reviewData = {} }) {
  const zip = new JSZip();
  const docTitle = cleanText((reviewData?.review?.isFallback || (reviewData?.review?.reviewStatus && reviewData.review.reviewStatus !== 'COMPLETE') ? '[검토 미완료] ' : '') + reportTitle(title, reviewData));
  const review = reviewData?.review || {};
  const meta = reviewData?.meta || {};

  const query = cleanText(meta.query || review.facts || docTitle);
  const lawName = cleanText(reportLawName(meta, review));
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const docNo = `LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const basisList = resolveBasisList(reviewData, contentMarkdown, lawName);
  const recommendations = review.recommendations || [];
  const opinionText = reportText(reviewData, contentMarkdown);

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

  let docxBody = `
    <!-- 타이틀 -->
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="300"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="42"/></w:rPr><w:t>${escapeXml(docTitle)}</w:t></w:r>
    </w:p>

    <!-- 상단 메타 -->
    <w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t>[문서번호] </w:t></w:r><w:r><w:t>${escapeXml(docNo)}    </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>[검토일자] </w:t></w:r><w:r><w:t>${escapeXml(todayStr)}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t>[검토대상] </w:t></w:r><w:r><w:t>${escapeXml(query)}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t>[주요법령] </w:t></w:r><w:r><w:rPr><w:color w:val="1E3A8A"/><w:b/></w:rPr><w:t>${escapeXml(lawName)}</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t></w:t></w:r></w:p>
  `;
  if (meta.preset !== 'contract_risk') docxBody += `

    <!-- 1. 검토 배경 및 질의 요지 -->
    <w:p>
      <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="28"/></w:rPr><w:t>1. 검토 배경 및 질의 요지</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>• ${escapeXml(cleanText(meta.preset === 'contract_risk' ? query : review.facts || query))}</w:t></w:r>
    </w:p>

    <!-- 2. 법률적 쟁점 및 심층 검토 의견 -->
    <w:p>
      <w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="28"/></w:rPr><w:t>2. 법률적 쟁점 및 심층 검토 의견</w:t></w:r>
    </w:p>
  `;

  const opinionParas = cleanText(opinionText).split('\n\n').filter(Boolean);
  for (const block of opinionParas) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('[') || line.startsWith('■') || /^[0-9]\./.test(line)) {
        docxBody += `
        <w:p>
          <w:pPr><w:spacing w:before="160" w:after="60"/></w:pPr>
          <w:r><w:rPr><w:b/><w:color w:val="0F172A"/><w:sz w:val="24"/></w:rPr><w:t>${escapeXml(line)}</w:t></w:r>
        </w:p>`;
      } else {
        docxBody += `
        <w:p>
          <w:pPr><w:spacing w:after="100"/></w:pPr>
          <w:r><w:rPr><w:color w:val="334155"/><w:sz w:val="21"/></w:rPr><w:t>${escapeXml(line)}</w:t></w:r>
        </w:p>`;
      }
    }
  }

  if (meta.preset !== 'contract_risk') {
  // 3. 리스크 평가 및 보완 조치 사항
  docxBody += `
    <w:p>
      <w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="28"/></w:rPr><w:t>3. 리스크 평가 및 보완 조치 사항</w:t></w:r>
    </w:p>
  `;

  if (recommendations.length > 0) {
    recommendations.forEach((rec, idx) => {
      docxBody += `
      <w:p>
        <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/></w:rPr><w:t>[조치 ${idx + 1}] </w:t></w:r>
        <w:r><w:t>${escapeXml(cleanText(rec))}</w:t></w:r>
      </w:p>`;
    });
  } else {
    docxBody += `<w:p><w:r><w:t>• 내부 규정 정비 및 법정 절차 준수 요망</w:t></w:r></w:p>`;
  }

  // 4. 관련 법령 및 조문 근거표 (항상 내용 보장)
  docxBody += `
    <w:p>
      <w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="28"/></w:rPr><w:t>4. 관련 법령 및 조문 근거표</w:t></w:r>
    </w:p>
  `;

  basisList.forEach(b => {
    docxBody += `
    <w:p>
      <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/></w:rPr><w:t>■ ${escapeXml(b.lawName || lawName)} ${escapeXml(b.articleNo || '')} (${escapeXml(b.title || '')})</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>   - 적용 및 연계성: ${escapeXml(cleanText(b.relevance || '본 사안의 적법성 검토 기준 조항'))}</w:t></w:r>
    </w:p>`;
  });

  }
  // 면책 고지
  docxBody += `
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="400"/></w:pPr>
      <w:r><w:rPr><w:color w:val="64748B"/><w:sz w:val="18"/></w:rPr><w:t>${escapeXml(review.disclaimer || '※ 본 검토의견서는 AI 법령검토 시스템에 의해 작성된 참고자료입니다.')}</w:t></w:r>
    </w:p>
  `;

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${docxBody}
  </w:body>
</w:document>`);

  return await zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * PDF 문서 생성
 */
export async function generatePdf({ title = '법률검토의견서', contentMarkdown = '', reviewData = {} }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
      const buffers = [];

      doc.on('data', b => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const fontPath = 'C:\\Windows\\Fonts\\malgun.ttf';
      if (fs.existsSync(fontPath)) {
        doc.font(fontPath);
      }

      const docTitle = cleanText((reviewData?.review?.isFallback || (reviewData?.review?.reviewStatus && reviewData.review.reviewStatus !== 'COMPLETE') ? '[검토 미완료] ' : '') + reportTitle(title, reviewData));
      const review = reviewData?.review || {};
      const meta = reviewData?.meta || {};

      const query = cleanText(meta.query || review.facts || docTitle);
      const lawName = cleanText(reportLawName(meta, review));
      const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
      const docNo = `LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

      const basisList = resolveBasisList(reviewData, contentMarkdown, lawName);
      const recommendations = review.recommendations || [];
      const opinionText = reportText(reviewData, contentMarkdown);

      // 1. 헤더 타이틀
      doc.fillColor('#1E3A8A').fontSize(18).text(docTitle, { align: 'center' });
      doc.moveDown(1.0);

      // 2. 상단 메타 박스
      doc.fillColor('#334155').fontSize(9.5);
      doc.text(`[문서 번호] ${docNo}     |     [검토 일자] ${todayStr}`);
      doc.text(`[검토 대상] ${query}`);
      doc.text(`[주요 법령] ${lawName}`);
      doc.moveDown(0.8);
      doc.strokeColor('#CBD5E1').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(1.0);

      // 3. 1. 검토 배경 및 질의 요지
      if (meta.preset !== 'contract_risk') {
      doc.fillColor('#1E3A8A').fontSize(13).text('1. 검토 배경 및 질의 요지');
      doc.moveDown(0.3);
      doc.fillColor('#334155').fontSize(9.5).text(`• ${cleanText(meta.preset === 'contract_risk' ? query : review.facts || query)}`);
      doc.moveDown(1.0);

      // 4. 2. 법률적 쟁점 및 심층 검토 의견
      doc.fillColor('#1E3A8A').fontSize(13).text('2. 법률적 쟁점 및 심층 검토 의견');
      doc.moveDown(0.4);
      }

      const opinionParas = cleanText(opinionText).split('\n\n').filter(Boolean);
      for (const block of opinionParas) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.startsWith('[') || line.startsWith('■') || /^[0-9]\./.test(line)) {
            doc.moveDown(0.3);
            doc.fillColor('#0F172A').fontSize(10).text(line);
            doc.moveDown(0.2);
          } else {
            doc.fillColor('#334155').fontSize(9.5).text(line, { lineGap: 3 });
          }
        }
      }
      doc.moveDown(1.0);

      // 계약서 본문에는 권고 수정안과 근거 부록이 이미 있으므로 범용 서식을 반복하지 않는다.
      if (meta.preset !== 'contract_risk') {
      // 5. 3. 리스크 평가 및 보완 조치 사항
      doc.fillColor('#1E3A8A').fontSize(13).text('3. 리스크 평가 및 보완 조치 사항');
      doc.moveDown(0.4);

      if (recommendations.length > 0) {
        recommendations.forEach((rec, idx) => {
          doc.fillColor('#1E3A8A').fontSize(9.5).text(`[조치 ${idx + 1}] `, { continued: true });
          doc.fillColor('#334155').text(cleanText(rec));
          doc.moveDown(0.2);
        });
      } else {
        doc.fillColor('#334155').fontSize(9.5).text('• 상위 법령 위임 한계 준수 및 서식 체계 정비 필요');
      }
      doc.moveDown(1.0);

      // 6. 4. 관련 법령 및 조문 근거표 (항상 내용 보장)
      doc.fillColor('#1E3A8A').fontSize(13).text('4. 관련 법령 및 조문 근거표');
      doc.moveDown(0.4);

      basisList.forEach(b => {
        doc.fillColor('#1E3A8A').fontSize(10).text(`■ ${b.lawName || lawName} ${b.articleNo || ''} (${b.title || ''})`);
        doc.fillColor('#475569').fontSize(9).text(`   - 적용 및 연계성: ${cleanText(b.relevance || '본 사안의 적법성 검토 기준 조항')}`);
        doc.moveDown(0.3);
      });

      doc.moveDown(1.5);
      }

      // 7. 면책 고지문
      doc.fillColor('#64748B').fontSize(8.5).text(
        review.disclaimer || '※ 본 검토의견서는 AI 법령검토 시스템에 의해 작성된 참고자료이며, 최종 법적 분쟁 및 처분에 대해서는 법률전문가의 자문을 받으시기 바랍니다.',
        { align: 'center' }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function reportTitle(title, data) {
  const value = title || '법률검토의견서';
  if (data?.meta?.preset === 'contract_risk' && /^(?:법률검토의견서|.+ 검토의견서)$/.test(value))
    return '계약서 법률검토의견서';
  return value;
}

function reportLawName(meta, review) {
  if (meta.preset !== 'contract_risk') return meta.primaryLawName || '관련 법령';
  const applied = [...new Set((review.legalBasis || []).filter(item => item.verificationStatus !== 'UNVERIFIED')
    .map(item => item.lawName).filter(Boolean))];
  return (applied.length ? applied : meta.governingLaws || []).join(', ') || '계약 관련 법령';
}

function cleanText(text) {
  if (!text) return '';
  return sanitizeExportText(String(text))
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
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
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
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
