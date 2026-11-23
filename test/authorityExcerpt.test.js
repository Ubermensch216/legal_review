import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorityExcerpt, buildRelevanceContext, cleanLegalMarkup, renderAuthorityExcerptHtml, splitLegalParagraphs } from '../public/js/authorityExcerpt.js';
import { parsePrecedentDetail } from '../server/law/decisionsApiParser.js';

test('HTML 태그는 지우고 법령의 꺾쇠 표기는 보존한다', () => {
  assert.equal(cleanLegalMarkup('<br/> 첫 문장<br/><br/>둘째 <개정 2020. 1. 1.>'), '첫 문장\n둘째 <개정 2020. 1. 1.>');
  assert.equal(cleanLegalMarkup('&lt;br/&gt;본문'), '본문');
});

test('번호가 붙은 판결요지를 명제 단위로 나눈다', () => {
  const parts = splitLegalParagraphs('<br/>[1] 첫째 법리<br/><br/>[2] 둘째 사례<br/>');
  assert.deepEqual(parts, [{ no: 1, text: '첫째 법리' }, { no: 2, text: '둘째 사례' }]);
});

test('문장 중간의 줄바꿈은 잇고 항목 기호의 줄바꿈은 유지한다', () => {
  const parts = splitLegalParagraphs('○ 연차휴가제도는 소정의\n근로를 한 근로자에게 부여한다.\n○ 둘째 항목이다.');
  assert.deepEqual(parts.map(p => p.text), ['○ 연차휴가제도는 소정의 근로를 한 근로자에게 부여한다.', '○ 둘째 항목이다.']);
});

test('공식 응답 파싱 단계에서 태그를 제거한다', () => {
  const parsed = parsePrecedentDetail({ PrecService: { 판례정보일련번호: '1', 사건번호: '2019다1', 판결요지: '&lt;br/&gt;[1] 법리&lt;br/&gt;' } });
  assert.equal(parsed.summary, '[1] 법리');
});

test('의뢰 쟁점과 맞닿는 명제만 발췌하고 무관한 명제는 뺀다', () => {
  const context = buildRelevanceContext({ meta: { query: '' }, review: { reasoning: { evidence: [], issues: [{ question: '포괄임금 약정은 유효한가?', searchTerms: ['포괄임금'] }] } } });
  const excerpt = buildAuthorityExcerpt([{ label: '판결요지', text: '[1] 포괄임금 약정의 성립 기준을 판단한다. [2] 해고 예고의 절차를 판단한다.' }], context);
  assert.equal(excerpt.passages.length, 1);
  assert.equal(excerpt.passages[0].no, 1);
});

test('발췌한 원칙 바로 뒤의 단서는 함께 싣는다', () => {
  const excerpt = buildAuthorityExcerpt([{ label: '회답', text: '채용계획은 협의하여야 한다. 다만, 긴급한 때에는 사후에 협의할 수 있다. 기타 사항은 별도로 정한다.' }], { strong: ['채용계획'], weak: [] });
  assert.match(excerpt.passages[0].text, /다만, 긴급한 때/);
  assert.doesNotMatch(excerpt.passages[0].text, /기타 사항/);
});

test('일치하는 부분이 없으면 임의 문장을 발췌하지 않는다', () => {
  const excerpt = buildAuthorityExcerpt([{ label: '판결요지', text: '전혀 다른 내용을 판단한다.' }], { strong: ['포괄임금'], weak: [] });
  assert.equal(excerpt.matched, false);
  assert.match(renderAuthorityExcerptHtml(excerpt, '판결요지 전문'), /판결요지 전문에서 확인/);
});

test('발췌 렌더링은 본문을 이스케이프한다', () => {
  const html = renderAuthorityExcerptHtml({ matched: true, passages: [{ label: '회답', no: null, text: '협의 <img src=x>', terms: ['협의'] }] });
  assert.match(html, /<mark>협의<\/mark> &lt;img/);
});
