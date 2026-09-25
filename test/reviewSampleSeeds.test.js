import test from 'node:test';
import assert from 'node:assert/strict';
import { expandQueryKeywords, kbArticlesAt } from '../server/law/lawTermKb.js';
import { generatedReportShellWarning } from '../server/parsers/sourceQuality.js';
import { parseDocument } from '../server/parsers/index.js';
import { readFile } from 'node:fs/promises';

test('샘플에서 원문에 드러난 주변 쟁점의 공식 조문 후보를 회수한다', () => {
  const labor = expandQueryKeywords('취업규칙 연차휴가와 휴게시간을 검토한다').suggestedLaws.find(law => law.name === '근로기준법');
  assert.ok(labor.mainArticles.includes('제54조'));
  assert.ok(labor.mainArticles.includes('제60조'));

  const food = expandQueryKeywords('식품접객업 영업장 면적 변경신고').suggestedLaws.find(law => law.name === '식품위생법');
  assert.ok(food.mainArticles.includes('제37조'));

  const privacy = expandQueryKeywords('개인정보 처리 위탁과 국외 이전').suggestedLaws.find(law => law.name === '개인정보 보호법');
  for (const article of ['제26조', '제28조의8']) assert.ok(privacy.mainArticles.includes(article));
});

test('2021년 지방자치법 조례 조문에 현행 번호를 적용하지 않는다', () => {
  const law = { name: '지방자치법', mainArticles: ['제28조', '제29조', '제192조'] };
  assert.deepEqual(kbArticlesAt(law, '20210302'), ['제22조']);
  assert.deepEqual(kbArticlesAt(law, '20260925'), law.mainArticles);
});

test('보고서 생성기가 섞어 넣은 머리말을 사실·공식 근거로 오인하지 않도록 경고한다', async () => {
  for (const name of ['01_취업규칙_전부개정안.hwpx', '03_영업정지_사전통지_의견제출서.pdf']) {
    const parsed = await parseDocument(await readFile(new URL(`./docs/review-samples/${name}`, import.meta.url)), name);
    assert.match(generatedReportShellWarning(parsed.text), /공식 법령 근거가 아닙니다/);
  }
  assert.equal(generatedReportShellWarning('제1조(목적) 이 규칙은 근로조건을 정한다.'), '');
});
