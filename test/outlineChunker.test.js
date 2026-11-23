import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkLegalDocument } from '../server/parsers/legalDocChunker.js';

test('제N조가 없는 개요형 보고서는 개요 번호로 나눈다', () => {
  const report = ['감사 결과 보고', 'Ⅰ. 감사 개요', '  가. 목적: 채용 절차 점검', 'Ⅱ. 지적 사항', '  1) 점수 집계가 부적정하다.', '  2) 위약벌은 3배로 한다.', 'Ⅲ. 조치 계획', '  가. 시정 조치'].join('\n');
  const chunks = chunkLegalDocument(report);
  assert.deepEqual(chunks.map(c => c.articleNo), ['전문', 'Ⅰ.', 'Ⅱ.', 'Ⅲ.']);
  assert.equal(chunks[2].title, '지적 사항');
  assert.ok(chunks[2].content.includes('점수 집계'), '하위 번호는 상위 항목 안에 남는다');
  assert.equal(chunks[2].isRiskClause, true, '위험 키워드는 해당 항목에서만 태그된다');
  assert.equal(chunks[1].isRiskClause, false);
});

test('아라비아 숫자·기호 개요도 나누되, 서술형 번호 목록은 제목으로 보지 않는다', () => {
  const doc = ['1. 사업 개요', '사업의 목적은 시스템 구축이다.', '2. 추진 일정', '1월에 착수한다.', '3. 이 사업은 착수 후 30일 안에 계약을 체결한다.'].join('\n');
  assert.deepEqual(chunkLegalDocument(doc).map(c => c.articleNo), ['1.', '2.']);
});

test('제N조가 있는 문서는 종전처럼 조항으로 나누고, 호(1.)를 항으로 오인하지 않는다', () => {
  const chunks = chunkLegalDocument('제5조(대금)\n① 대금은 다음과 같다.\n1. 선금 30%\n2. 잔금 70%');
  assert.equal(chunks[0].articleNo, '제5조');
  assert.deepEqual(chunks[0].paragraphs.map(p => p.header), ['①']);
  assert.deepEqual(chunks[0].paragraphs[0].items, ['1. 선금 30%', '2. 잔금 70%']);
});

test('개요 표지가 한 개뿐이면 억지로 나누지 않는다', () => {
  assert.deepEqual(chunkLegalDocument('1. 유일한 항목\n본문입니다.').map(c => c.articleNo), ['전문']);
});
