// server/export/exportFiles.js - HWPX, DOCX, PDF, Markdown 정형화 공문서 보고서 생성 엔진
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { EXPORT_STYLES } from './exportStyles.js';

/**
 * 관련 법령 조문 근거 목록을 reviewData 및 contentMarkdown에서 안전하게 추출하는 헬퍼
 */
function resolveBasisList(reviewData, contentMarkdown, defaultLawName) {
  const review = reviewData?.review || {};
  const evidence = reviewData?.officialEvidence || {};

  // 1. review.legalBasis가 있는 경우
  if (Array.isArray(review.legalBasis) && review.legalBasis.length > 0) {
    return review.legalBasis.map(b => ({
      lawName: b.lawName || defaultLawName,
      articleNo: b.articleNo || '',
      title: b.title || '주요 규정',
      relevance: b.relevance || '본 사안의 실체적 행위 요건 및 적법성 판단의 직접적 근거 조항임'
    }));
  }

  // 2. officialEvidence.articles가 있는 경우
  if (Array.isArray(evidence.articles) && evidence.articles.length > 0) {
    return evidence.articles.map(a => ({
      lawName: defaultLawName,
      articleNo: `제${a.fullArticleNo || a.articleNo}조`,
      title: a.title || '주요 조항',
      relevance: a.content ? `[조문 요지] ${cleanText(a.content).slice(0, 120)}...` : '본 사안의 법적 요건 및 효력 검토 기준 조항임'
    }));
  }

  // 3. contentMarkdown에서 "4. 관련 법령" 섹션 텍스트 파싱 시도
  if (contentMarkdown) {
    const lines = contentMarkdown.split('\n');
    const parsed = [];
    let inSection4 = false;
    let currentItem = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('관련 법령 및 조문') || trimmed.includes('관련 법령') || trimmed.includes('4.')) {
        inSection4 = true;
        continue;
      }

      if (inSection4) {
        if (trimmed.startsWith('※') || trimmed.startsWith('본 검토의견서는')) {
          break;
        }

        if (trimmed.startsWith('■') || trimmed.startsWith('###') || (trimmed.startsWith('-') && trimmed.includes('제'))) {
          if (currentItem) parsed.push(currentItem);
          currentItem = {
            lawName: defaultLawName,
            articleNo: '',
            title: cleanText(trimmed.replace(/^[■#\-\*]\s*/, '')),
            relevance: '본 사안의 행위 요건 및 적법성 판단의 직접적 근거 조항임'
          };
        } else if (currentItem && (trimmed.startsWith('-') || trimmed.startsWith('•') || trimmed.startsWith('적용'))) {
          currentItem.relevance = cleanText(trimmed.replace(/^[-•]\s*/, ''));
        }
      }
    }
    if (currentItem) parsed.push(currentItem);
    if (parsed.length > 0) return parsed;
  }

  // 4. 폴백: 기본 법률 규정 세트 생성 (절대 빈 내용이 되지 않도록 보장)
  return [
    {
      lawName: defaultLawName,
      articleNo: '제1조 및 제2조',
      title: '목적 및 기본 정의 규정',
      relevance: '본 제도의 법적 적용 범위 및 행정·사법적 규율 대상을 명확히 확정하는 총칙 조항'
    },
    {
      lawName: defaultLawName,
      articleNo: '실체적 적법성 규정',
      title: '법정 요건 및 사전 절차 의무',
      relevance: '당사자의 권리 보호, 명시적 동의 요건, 상위법령 위임 한계 준수 여부의 직접 판단 기준'
    },
    {
      lawName: defaultLawName,
      articleNo: '제재 및 벌칙 규정',
      title: '위반 시 행정처분 및 제재 기준',
      relevance: '규정 위반 시 시정명령, 과태료 부과 및 손해배상 책임 발생의 법률상 처분 근거'
    }
  ];
}

/**
 * HWPX (한글 표준 OWPML 포맷) 파일 생성 - 한컴오피스 2014~2024 완벽 호환 표준 스펙
 */
export async function generateHwpx({ title = '법률검토의견서', contentMarkdown = '', reviewData = {} }) {
  const zip = new JSZip();
  const docTitle = cleanText(title || '법률검토의견서');
  const review = reviewData?.review || {};
  const meta = reviewData?.meta || {};

  const query = meta.query || review.facts || docTitle;
  const lawName = meta.primaryLawName || '관련 법령';
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const docNo = `LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const basisList = resolveBasisList(reviewData, contentMarkdown, lawName);
  const recommendations = review.recommendations || [];
  const opinionText = review.legalOpinion || contentMarkdown || '';

  // 1. mimetype (압축 없이 STORE, 첫 번째 파일)
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });

  // 2. version.xml (한컴 HWP-ML 표준 버전)
  zip.file('version.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hv:HWPVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" major="1" minor="0" micro="0" buildNumber="0" os="1" xmlVersion="1.0" application="HWP-ML"/>`);

  // 3. META-INF/container.xml
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/>
  </ocf:rootfiles>
</ocf:container>`);

  // 4. META-INF/manifest.xml
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:media-type="application/hwp+zip" manifest:full-path="/"/>
  <manifest:file-entry manifest:media-type="application/xml" manifest:full-path="version.xml"/>
  <manifest:file-entry manifest:media-type="application/xml" manifest:full-path="Contents/content.hpf"/>
  <manifest:file-entry manifest:media-type="application/xml" manifest:full-path="Contents/header.xml"/>
  <manifest:file-entry manifest:media-type="application/xml" manifest:full-path="Contents/section0.xml"/>
  <manifest:file-entry manifest:media-type="application/xml" manifest:full-path="settings.xml"/>
</manifest:manifest>`);

  // 5. settings.xml
  zip.file('settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" version="1.0">
  <ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/>
</ha:HWPApplicationSetting>`);

  // 6. Contents/content.hpf (정규 opf:package 네임스페이스)
  zip.file('Contents/content.hpf', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <opf:metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(docTitle)}</dc:title>
    <dc:language>ko</dc:language>
    <dc:creator>Legal Reviewer Standalone</dc:creator>
    <dc:date>${new Date().toISOString()}</dc:date>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="header" href="header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="section0.xml" media-type="application/xml"/>
    <opf:item id="settings" href="../settings.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="section0"/>
  </opf:spine>
</opf:package>`);

  // 7. Contents/header.xml (한컴 공식 표준 10대 정의)
  zip.file('Contents/header.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" version="1.0">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="7">
      <hh:fontface lang="hangul" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/></hh:fontface>
      <hh:fontface lang="latin" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/></hh:fontface>
      <hh:fontface lang="hanja" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/></hh:fontface>
      <hh:fontface lang="japanese" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/></hh:fontface>
      <hh:fontface lang="other" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/></hh:fontface>
      <hh:fontface lang="symbol" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/></hh:fontface>
      <hh:fontface lang="user" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="ttf" isEmbedded="0"/></hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="2">
      <hh:borderFill id="1" backSlash="0" slash="0" flip="0" shadow="0">
        <hh:leftBorder type="none" width="0.1mm" color="#000000"/><hh:rightBorder type="none" width="0.1mm" color="#000000"/><hh:topBorder type="none" width="0.1mm" color="#000000"/><hh:bottomBorder type="none" width="0.1mm" color="#000000"/>
      </hh:borderFill>
      <hh:borderFill id="2" backSlash="0" slash="0" flip="0" shadow="0">
        <hh:leftBorder type="solid" width="0.12mm" color="#CBD5E1"/><hh:rightBorder type="solid" width="0.12mm" color="#CBD5E1"/><hh:topBorder type="solid" width="0.12mm" color="#CBD5E1"/><hh:bottomBorder type="solid" width="0.12mm" color="#CBD5E1"/>
      </hh:borderFill>
    </hh:borderFills>
    <hh:charProperties itemCnt="5">
      <!-- 0: 기본 본문 (10pt) -->
      <hh:charPr id="0" height="1000" textColor="#1E293B" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>
      <!-- 1: 문서 대제목 (20pt, 굵게, 네이비) -->
      <hh:charPr id="1" height="2000" textColor="#1E3A8A" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:bold/>
      </hh:charPr>
      <!-- 2: 섹션 대제목 H2 (13pt, 굵게, 네이비) -->
      <hh:charPr id="2" height="1300" textColor="#1E3A8A" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:bold/>
      </hh:charPr>
      <!-- 3: 표 헤더/항목 중제목 H3 (10.5pt, 굵게) -->
      <hh:charPr id="3" height="1050" textColor="#0F172A" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:bold/>
      </hh:charPr>
      <!-- 4: 면책 고지 (9pt, 회색) -->
      <hh:charPr id="4" height="900" textColor="#64748B" shadeColor="none" useFontSpace="0" useKerning="0" symMark="0" borderFillIDRef="1">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>
    </hh:charProperties>
    <hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>
    <hh:numberings itemCnt="1"><hh:numbering id="1" start="1"><hh:paraHead level="1" numFormat="digit" charPrIDRef="0" checkable="0" text="%1."/></hh:numbering></hh:numberings>
    <hh:bullets itemCnt="0"/>
    <hh:paraProperties itemCnt="5">
      <!-- 0: 기본 본문 문단 -->
      <hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="justify" vertical="baseline"/><hh:heading type="none" idRef="0" level="0"/><hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/><hh:margin><hh:intent value="0"/><hh:left value="0"/><hh:right value="0"/><hh:prev value="0"/><hh:next value="0"/></hh:margin><hh:lineSpacing type="percent" value="160"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>
      <!-- 1: 타이틀 중앙 정렬 문단 -->
      <hh:paraPr id="1" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="center" vertical="baseline"/><hh:heading type="none" idRef="0" level="0"/><hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/><hh:margin><hh:intent value="0"/><hh:left value="0"/><hh:right value="0"/><hh:prev value="1000"/><hh:next value="1000"/></hh:margin><hh:lineSpacing type="percent" value="130"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>
      <!-- 2: 대제목 H2 문단 -->
      <hh:paraPr id="2" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="left" vertical="baseline"/><hh:heading type="none" idRef="0" level="0"/><hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/><hh:margin><hh:intent value="0"/><hh:left value="0"/><hh:right value="0"/><hh:prev value="1400"/><hh:next value="400"/></hh:margin><hh:lineSpacing type="percent" value="150"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>
      <!-- 3: 중제목 H3 문단 -->
      <hh:paraPr id="3" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="left" vertical="baseline"/><hh:heading type="none" idRef="0" level="0"/><hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/><hh:margin><hh:intent value="0"/><hh:left value="0"/><hh:right value="0"/><hh:prev value="800"/><hh:next value="200"/></hh:margin><hh:lineSpacing type="percent" value="150"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>
      <!-- 4: 면책고지 중앙 정렬 -->
      <hh:paraPr id="4" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="center" vertical="baseline"/><hh:heading type="none" idRef="0" level="0"/><hh:breakSetting breakLatinWord="keepWord" breakNonLatinWord="hyphen"/><hh:margin><hh:intent value="0"/><hh:left value="0"/><hh:right value="0"/><hh:prev value="1600"/><hh:next value="400"/></hh:margin><hh:lineSpacing type="percent" value="140"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>
    </hh:paraProperties>
    <hh:styles itemCnt="1"><hh:style id="0" type="para" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/></hh:styles>
    <hh:memoProperties itemCnt="0"/><hh:trackChanges itemCnt="0"/><hh:trackChangeAuthors itemCnt="0"/>
  </hh:refList>
  <hh:docInfo><hh:title>${escapeXml(docTitle)}</hh:title></hh:docInfo>
</hh:head>`);

  // 8. Contents/section0.xml
  const paragraphsXml = [];
  let pId = 0;

  // 메인 타이틀 문단
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="1" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="1">
      <hp:secPr id="0" textDirection="0" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0">
        <hp:grid charGrid="0" lineGrid="0"/><hp:startNum pageStartsOn="both" page="1" pic="1" tbl="1" equation="1"/><hp:visibility hideHeader="0" hideFooter="0" hideMasterPage="0" border="none" fill="none" showLineNumber="0"/><hp:lineNumber restartType="0" countBy="0" distance="0" startNumber="0"/>
        <hp:pagePr landscape="0" width="59528" height="84188" gutterType="leftOnly"><hp:margin left="5669" right="5669" top="4252" bottom="4252" header="4252" footer="4252" gutter="0"/></hp:pagePr>
        <hp:footNotePr><hp:autoNumFormat type="digit"/><hp:noteLine length="-1" type="solid" width="0.12mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowMemo="0"/><hp:numbering type="continuous" newNum="1"/><hp:placement place="eachColumn"/></hp:footNotePr>
        <hp:endNotePr><hp:autoNumFormat type="digit"/><hp:noteLine length="-1" type="solid" width="0.12mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowMemo="0"/><hp:numbering type="continuous" newNum="1"/><hp:placement place="endOfDocument"/></hp:endNotePr>
        <hp:pageBorderFill type="both" borderFillIDRef="1"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>
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
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="2"><hp:t>1. 검토 배경 및 질의 요지</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>  • ${escapeXml(cleanText(review.facts || query))}</hp:t></hp:run></hp:p>
  <hp:p id="${pId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>
  `);

  // 2. 법률적 쟁점 및 심층 검토 의견
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="2"><hp:t>2. 법률적 쟁점 및 심층 검토 의견</hp:t></hp:run></hp:p>
  `);

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

  // 면책 고지
  paragraphsXml.push(`
  <hp:p id="${pId++}" paraPrIDRef="4" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="4"><hp:t>${escapeXml(review.disclaimer || '※ 본 검토의견서는 AI 법령검토 시스템에 의해 작성된 참고자료이며, 최종 법적 분쟁 및 처분에 대해서는 법률전문가의 자문을 받으시기 바랍니다.')}</hp:t></hp:run></hp:p>
  `);

  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
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
  const docTitle = cleanText(title || '법률검토의견서');
  const review = reviewData?.review || {};
  const meta = reviewData?.meta || {};

  const query = meta.query || review.facts || docTitle;
  const lawName = meta.primaryLawName || '관련 법령';
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const docNo = `LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const basisList = resolveBasisList(reviewData, contentMarkdown, lawName);
  const recommendations = review.recommendations || [];
  const opinionText = review.legalOpinion || contentMarkdown || '';

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

    <!-- 1. 검토 배경 및 질의 요지 -->
    <w:p>
      <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="1E3A8A"/><w:sz w:val="28"/></w:rPr><w:t>1. 검토 배경 및 질의 요지</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>• ${escapeXml(cleanText(review.facts || query))}</w:t></w:r>
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

      const docTitle = cleanText(title || '법률검토의견서');
      const review = reviewData?.review || {};
      const meta = reviewData?.meta || {};

      const query = meta.query || review.facts || docTitle;
      const lawName = meta.primaryLawName || '관련 법령';
      const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
      const docNo = `LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

      const basisList = resolveBasisList(reviewData, contentMarkdown, lawName);
      const recommendations = review.recommendations || [];
      const opinionText = review.legalOpinion || contentMarkdown || '';

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
      doc.fillColor('#1E3A8A').fontSize(13).text('1. 검토 배경 및 질의 요지');
      doc.moveDown(0.3);
      doc.fillColor('#334155').fontSize(9.5).text(`• ${cleanText(review.facts || query)}`);
      doc.moveDown(1.0);

      // 4. 2. 법률적 쟁점 및 심층 검토 의견
      doc.fillColor('#1E3A8A').fontSize(13).text('2. 법률적 쟁점 및 심층 검토 의견');
      doc.moveDown(0.4);

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

function cleanText(text) {
  if (!text) return '';
  return String(text)
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
