// test/inspectHwpxBinary.js
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { generateHwpx } from '../server/export/exportFiles.js';

async function inspect() {
  const buf = await generateHwpx({
    title: '바이너리 검증 법률검토의견서',
    contentMarkdown: '1. 검토배경\n내용입니다.',
    reviewData: {
      review: {
        facts: '사안 사실관계',
        legalOpinion: '[쟁점 1: 적법성]\n세부 법리 분석',
        recommendations: ['조치 1', '조치 2'],
        legalBasis: [{ lawName: '개인정보 보호법', articleNo: '제15조', title: '동의 요건', relevance: '기준 조항' }]
      }
    }
  });

  console.log(`[Inspect] HWPX 전체 크기: ${buf.length} bytes`);
  console.log(`[Inspect] 처음 60 bytes (Hex):`);
  console.log(buf.subarray(0, 60).toString('hex'));

  // 바이트 단위 헤더 검증
  const sig = buf.subarray(0, 4).toString('hex');
  const compMethod = buf.readUInt16LE(8);
  const fnLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const fileName = buf.subarray(30, 30 + fnLen).toString('utf-8');
  const contentStart = 30 + fnLen + extraLen;
  const content = buf.subarray(contentStart, contentStart + 19).toString('utf-8');

  console.log(`- Signature: ${sig} (기대: 504b0304)`);
  console.log(`- Compression Method: ${compMethod} (기대: 0 = STORE)`);
  console.log(`- File Name Length: ${fnLen} (기대: 8)`);
  console.log(`- Extra Field Length: ${extraLen} (기대: 0)`);
  console.log(`- File Name: '${fileName}' (기대: 'mimetype')`);
  console.log(`- Content: '${content}' (기대: 'application/hwp+zip')`);

  const zip = await JSZip.loadAsync(buf);
  console.log(`\n[Inspect] ZIP 내부 파일 목록:`);
  Object.keys(zip.files).forEach(f => console.log(`  - ${f}`));

  console.log('\n[Inspect] Contents/content.hpf 내용:');
  console.log(await zip.file('Contents/content.hpf').async('string'));

  console.log('\n[Inspect] Contents/header.xml 내용:');
  console.log(await zip.file('Contents/header.xml').async('string'));

  console.log('\n[Inspect] Contents/section0.xml 내용:');
  console.log(await zip.file('Contents/section0.xml').async('string'));
}

inspect().catch(e => console.error(e));
