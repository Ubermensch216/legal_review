import './setup.js';
// test/referenceScope.test.js
// 법령명 없는 "제N조"의 귀속 회귀 테스트.
// 직전에 인용한 법령으로 무조건 메우면, 문서 자신의 조문이 상위법 조문으로 둔갑해
// 공식 근거로 실린다. (test/docs/test_mobility_ordinance.pdf 사안에서 12건 중 7건 오귀속)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractArticleReferences, isCitationReference, REFERENCE_SCOPE } from '../server/law/lawArticleRef.js';
import { parseDocument } from '../server/parsers/index.js';

const scopeOf = (text, index = 0) => extractArticleReferences(text)[index];

test('줄머리의 "제N조(제목)"은 문서 자신의 조문으로 보고 어떤 법령에도 귀속시키지 않는다', () => {
  const text = [
    '- 법적 쟁점: 지방자치법 제28조 단서에 위배되는지 여부.',
    '■ 제14조 (주민 통행 제한 및 과태료 부과)'
  ].join('\n');
  const refs = extractArticleReferences(text);
  assert.equal(refs[0].lawName, '지방자치법');
  assert.equal(refs[1].scope, REFERENCE_SCOPE.SELF);
  assert.equal(refs[1].lawName, '', '자기 조문은 직전 법령으로 승계되면 안 된다');
  assert.equal(isCitationReference(refs[1]), false);
});

test("'상기·본 조례안' 지시어가 붙은 인용은 문서 자신의 조문이다", () => {
  for (const text of ['약관의 규제에 관한 법률 제6조 저촉 여부. 상기 제8조가 위법한지',
                      '도로교통법 제15조 참조. 본 조례안 제19조의 면책조항',
                      '지방자치법 제28조. 이 조례 제3조에 따라']) {
    const last = extractArticleReferences(text).pop();
    assert.equal(last.scope, REFERENCE_SCOPE.SELF, text);
    assert.equal(last.lawName, '', text);
  }
});

test("'관련 법령'은 제명이 아니라 서식 빈칸이므로 직전 법령으로 메우지 않는다", () => {
  const text = '약관의 규제에 관한 법률 제6조, 제7조 저촉 여부.\n■ 관련 법령 제1조 및 제2조 (목적 및 기본 정의 규정)';
  const refs = extractArticleReferences(text);
  const placeholders = refs.filter(r => r.scope === REFERENCE_SCOPE.PLACEHOLDER);
  assert.equal(placeholders.length, 2, JSON.stringify(refs.map(r => [r.fullArticleNo, r.scope])));
  for (const r of placeholders) assert.equal(r.lawName, '');
  // 지정 법령이 있으면 사용자의 명시적 의사이므로 그 법령으로 해석한다.
  const withTarget = extractArticleReferences(text, '지방자치법').filter(r => r.scope === REFERENCE_SCOPE.PLACEHOLDER);
  assert.equal(withTarget[0].lawName, '지방자치법');
});

test('열거로 이어진 인용은 앞 인용의 성격을 물려받는다', () => {
  const enumerated = extractArticleReferences('1. 상기 제8조 및 제14조가 상위 법령의 위임 한계를 일탈하여');
  assert.equal(enumerated.length, 2);
  for (const r of enumerated) assert.equal(r.scope, REFERENCE_SCOPE.SELF, JSON.stringify(r));

  const cited = extractArticleReferences('행정대집행법 및 약관의 규제에 관한 법률 제6조, 제7조(면책조항의 무효)');
  assert.equal(cited.length, 2);
  for (const r of cited) assert.equal(r.lawName, '약관의 규제에 관한 법률', JSON.stringify(r));
});

test('어절 중간의 글자를 지시어로 오인하지 않는다', () => {
  // "규정이", "상위"의 끝 글자가 '이', '위'라고 해서 자기 조문이 되면 안 된다.
  for (const text of ['개인정보 보호법 제15조의 규정이 제17조와 충돌하는지',
                      '근로기준법 제56조. 상위 제60조의 위임 범위']) {
    const last = extractArticleReferences(text).pop();
    assert.notEqual(last.scope, REFERENCE_SCOPE.SELF, text);
    assert.ok(last.lawName, text);
  }
});

test('기존의 대용 표현과 명시 인용 처리는 그대로 유지된다', () => {
  const refs = extractArticleReferences('「부동산 가격공시에 관한 법률」 제10조에 따르며, 없으면 같은 법 제8조를 적용한다');
  assert.equal(refs[0].scope, REFERENCE_SCOPE.EXPLICIT);
  assert.equal(refs[1].scope, REFERENCE_SCOPE.ANAPHORIC);
  assert.equal(refs[1].lawName, '부동산 가격공시에 관한 법률');
  for (const r of refs) assert.equal(isCitationReference(r), true);
});

test('같은 법 시행규칙·동법 시행령은 직전 모법의 하위 법령으로 귀속한다', () => {
  const refs = extractArticleReferences('식품위생법 제75조 및 같은 법 시행규칙 제89조. 개인정보 보호법 제15조와 동법 시행령 제14조');
  assert.equal(refs[1].lawName, '식품위생법 시행규칙');
  assert.equal(refs[1].scope, REFERENCE_SCOPE.ANAPHORIC);
  assert.equal(refs[3].lawName, '개인정보 보호법 시행령');
  assert.equal(refs[3].scope, REFERENCE_SCOPE.ANAPHORIC);
  assert.ok(refs.every(isCitationReference));
});

test('행정처분 PDF의 시행규칙 제89조를 식품위생법 제89조로 오인하지 않는다', async () => {
  const buffer = await readFile(new URL('./docs/review-samples/03_영업정지_사전통지_의견제출서.pdf', import.meta.url));
  const parsed = await parseDocument(buffer, '03_영업정지_사전통지_의견제출서.pdf');
  const refs = extractArticleReferences(parsed.text, '식품위생법').filter(ref => ref.fullArticleNo === '89');
  assert.ok(refs.some(ref => ref.lawName === '식품위생법 시행규칙' && ref.scope === REFERENCE_SCOPE.ANAPHORIC));
  assert.ok(refs.some(ref => ref.scope === REFERENCE_SCOPE.SELF));
  assert.ok(!refs.some(ref => ref.lawName === '법 시행규칙' || ref.lawName === '식품위생법'));
});
