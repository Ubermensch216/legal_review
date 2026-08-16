// test/verifySampleDocs.js
import fs from 'fs';
import path from 'path';
import { parseDocument } from '../server/parsers/index.js';
import { extractArticleReferences } from '../server/law/lawArticleRef.js';

async function verify() {
  const hwpxPath = path.join(process.cwd(), 'test', 'docs', 'test_cctv_guideline.hwpx');
  const pdfPath = path.join(process.cwd(), 'test', 'docs', 'test_mobility_ordinance.pdf');

  console.log('[Verify] 1. HWPX 파싱 검증...');
  const hwpxBuf = fs.readFileSync(hwpxPath);
  const hwpxRes = await parseDocument(hwpxBuf, 'test_cctv_guideline.hwpx');
  console.log(`- HWPX 포맷: ${hwpxRes.format}, 텍스트 길이: ${hwpxRes.text.length}자`);
  console.log(`- 미리보기: ${hwpxRes.text.slice(0, 120)}...`);

  const hwpxRefs = extractArticleReferences(hwpxRes.text);
  console.log(`- 추출된 조문 인용 수: ${hwpxRefs.length}건 (예: ${hwpxRefs.map(r => r.fullRef).join(', ')})`);

  console.log('\n[Verify] 2. PDF 파싱 검증...');
  const pdfBuf = fs.readFileSync(pdfPath);
  const pdfRes = await parseDocument(pdfBuf, 'test_mobility_ordinance.pdf');
  console.log(`- PDF 포맷: ${pdfRes.format}, 텍스트 길이: ${pdfRes.text.length}자`);
  console.log(`- 미리보기: ${pdfRes.text.slice(0, 120)}...`);

  const pdfRefs = extractArticleReferences(pdfRes.text);
  console.log(`- 추출된 조문 인용 수: ${pdfRefs.length}건 (예: ${pdfRefs.map(r => r.fullRef).join(', ')})`);

  console.log('\n✅ 복합 테스트 문서 파싱 및 조문 추출 검증 완료!');
}

verify().catch(e => console.error(e));
