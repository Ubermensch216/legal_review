// test/advancedParsers.test.js - 고도화 파서, 계층 청킹 및 컨텍스트 최적화 단위 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkLegalDocument } from '../server/parsers/legalDocChunker.js';
import { optimizeDocumentContext } from '../server/parsers/contextOptimizer.js';
import { parseDocument } from '../server/parsers/index.js';
import { generateHwpx } from '../server/export/exportFiles.js';

test('계층적 조항 분할 및 위험 조항 태깅 (legalDocChunker)', () => {
  const sampleLawDoc = `
# [내부규정] 개인정보 관리 지침

제1조(목적) 본 지침은 개인정보를 보호함을 목적으로 한다.
제7조(생체정보 수집) 1. 안면인식 특징점을 수집한다.
2. 제1항의 수집 시 정보주체의 사전 동의를 생략할 수 있다.
제12조(음성녹음) 관제 효율을 위해 음성 녹음 기능을 상시 활성화한다.
제22조(면책) 고의가 없는 한 일체의 손해배상 책임을 지지 아니한다.
  `;

  const chunks = chunkLegalDocument(sampleLawDoc);
  assert.ok(chunks.length >= 4, `청크 수가 4개 이상이어야 함 (실제: ${chunks.length})`);

  const art7 = chunks.find(c => c.articleNo === '제7조');
  assert.ok(art7, '제7조가 추출되어야 함');
  assert.equal(art7.isRiskClause, true, '제7조는 동의생략 위험 조항으로 태깅되어야 함');

  const art12 = chunks.find(c => c.articleNo === '제12조');
  assert.ok(art12 && art12.isRiskClause, '제12조는 음성녹음 위험 조항으로 태깅되어야 함');

  const art22 = chunks.find(c => c.articleNo === '제22조');
  assert.ok(art22 && art22.isRiskClause, '제22조는 면책 독소조항으로 태깅되어야 함');
});

test('대용량 장문 문서 쟁점 중심 컨텍스트 최적화 (contextOptimizer)', () => {
  let longDoc = '전문: 본 계약은 표준 계약서입니다.\n';
  for (let i = 1; i <= 30; i++) {
    if (i === 5) {
      longDoc += `제5조(위약벌) 위반 시 1일당 10%의 위약벌을 배액으로 배상한다.\n`;
    } else if (i === 15) {
      longDoc += `제15조(음성 녹음) 대화내용을 녹음할 수 있다.\n`;
    } else {
      longDoc += `제${i}조(일반사항) 일반적인 계약 관리 규정 사항입니다. 내용이 길어집니다. ${'가나다라 '.repeat(20)}\n`;
    }
  }

  const res = optimizeDocumentContext({
    documentText: longDoc,
    query: '위약벌 및 음성 녹음 리스크 검토',
    maxChars: 1500
  });

  assert.ok(res.totalChunks >= 20, '전체 청크가 분할되어야 함');
  assert.ok(res.omittedCount > 0, '일반 조항이 압축 생략되어야 함');
  assert.ok(res.optimizedText.includes('제5조'), '위험 조항인 제5조는 반드시 유지되어야 함');
  assert.ok(res.optimizedText.includes('제15조'), '위험 조항인 제15조는 반드시 유지되어야 함');
});

test('HWPX 생성 및 표(Table) 마크다운 변환 역파싱 무결성 검증', async () => {
  const sampleMarkdown = `# 신구 조문 대비표 보고서\n\n| 조항 | 현행 문구 | 수정 권고안 |\n|---|---|---|\n| 제7조 | 사전동의 생략 | 사전동의 획득 필수 |\n| 제12조 | 음성녹음 허용 | 음성녹음 일체 금지 |\n`;

  const hwpxBuf = await generateHwpx({
    title: '신구조문대비표',
    contentMarkdown: sampleMarkdown,
    reviewData: {
      review: {
        facts: '대비표 검토',
        redlineDiffs: [
          { clauseNo: '제7조', originalText: '사전동의 생략', revisedText: '사전동의 필수', reason: '법령 위반' }
        ]
      }
    }
  });

  const parsed = await parseDocument(hwpxBuf, 'table_test.hwpx');
  assert.equal(parsed.ext, 'hwpx');
  assert.ok(parsed.text.length > 50, 'HWPX 텍스트가 정상 추출되어야 함');
  assert.ok(parsed.chunks.length > 0, '조항 청킹이 정상 수행되어야 함');
});
