import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceRegistry, formatArticleNo, splitNumberedPropositions, splitProviso, unitNumber } from '../server/reasoning/evidenceRegistry.js';

const OFFICIAL = { source: 'OFFICIAL_API' };
const law = '공유재산 및 물품 관리법';
const article20 = { ...OFFICIAL, lawName: law, fullArticleNo: '20', title: '사용허가', enforceDate: '20200101',
  content: '제20조(사용허가)',
  paragraphs: [
    { paragraphNo: '①', content: '지방자치단체의 장은 행정재산의 사용 또는 수익을 허가할 수 있다.', items: [] },
    { paragraphNo: '②', content: '사용·수익허가는 일반입찰로 하여야 한다. 다만, 필요하다고 인정되면 수의의 방법으로 할 수 있다.',
      items: [{ itemNo: '1.', content: '공용으로 사용하는 경우. 다만, 영리 목적은 제외한다.' }, { itemNo: '2.', content: '재해 복구' }] }
  ] };
const article27 = { ...OFFICIAL, lawName: law, fullArticleNo: '27', title: '관리위탁', enforceDate: '20200101',
  content: '관리위탁을 받은 자는 사용허가를 받은 것으로 본다. 다만, 조례로 달리 정할 수 있다.', paragraphs: [] };
const future = { ...OFFICIAL, lawName: law, fullArticleNo: '15의2', title: '특례', enforceDate: '20991231', content: '미래 시행 조문', paragraphs: [] };
const mock = { lawName: law, fullArticleNo: '99', content: '목업', isMockData: true, source: 'MOCK', paragraphs: [] };

const context = () => ({
  meta: { primaryLawName: law, asOfDate: '20260923' },
  officialEvidence: {
    lawDetail: { ...OFFICIAL, lawName: law },
    articles: [article20, article27, future, mock],
    cascadingHierarchy: { act: { ...OFFICIAL, lawName: law, articles: [article20] } },
    ordinanceArticles: [{ ...OFFICIAL, lawName: '가상시 공유재산 관리 조례', fullArticleNo: '9', title: '대상', content: '대상은 다음과 같다.', paragraphs: [], orgName: '가상시' }],
    adminRuleDetails: [{ ...OFFICIAL, name: '공유재산 운영기준', ruleType: '고시', articles: [{ fullArticleNo: '4', title: '산정', content: '사용료는 재산가액에 요율을 곱한다.' }] }],
    precedents: [
      { ...OFFICIAL, contentStatus: 'FULL_TEXT', courtName: '대법원', judgeDate: '20190101', caseNo: '2018두12345', caseName: '사용료부과처분취소',
        holding: '[1] 관리위탁의 법적 성질 [2] 사용허가 의제 범위', summary: '[1] 관리위탁은 사용허가와 구별된다. [2] 수탁자의 제3자 사용은 별도 허가가 필요하다.',
        referencedArticles: `[1] ${law} 제27조 / [2] ${law} 제20조 제1항, 민법 제750조` },
      { ...OFFICIAL, contentStatus: 'LIST_ONLY', caseNo: '2020두1', summary: '본문 없음' },
      { contentStatus: 'FULL_TEXT', isMockData: true, source: 'MOCK', caseNo: '9999두9', summary: '가짜' }
    ],
    interpretations: [{ ...OFFICIAL, contentStatus: 'FULL_TEXT', orgName: '법제처', title: '관리위탁 해석', answer: '별도 허가가 필요합니다.', reason: '위탁과 허가는 다릅니다.' }]
  },
  learningKnowledge: [{ id: 'k1', title: '외부 전문가 카드', card: { issue: '징수권' }, source: 'USER_APPROVED_HUMAN_EXPERT' }]
});

test('항·호·단서를 결정적 ID로 나누고 법 → 수집 조문 순으로 중복 없이 싣는다', () => {
  const r = buildEvidenceRegistry(context());
  assert.deepEqual(r.ids(e => e.kind === 'ARTICLE'), ['A1', 'A2', 'A3'], '연쇄의 법 조문과 수집 조문이 같으면 한 번만, 목업은 제외');
  assert.equal(r.get('A1').label, `${law} 제20조`);
  assert.equal(r.get('A3').label, `${law} 제15조의2`);
  assert.deepEqual(r.children('A1').map(u => u.id), ['A1.1', 'A1.2', 'A1.2x', 'A1.2.1', 'A1.2.1x', 'A1.2.2']);
  assert.equal(r.get('A1.2').text, '사용·수익허가는 일반입찰로 하여야 한다.');
  assert.match(r.get('A1.2x').text, /^다만, 필요하다고 인정되면/);
  assert.equal(r.get('A1.2x').isException, true);
  assert.equal(r.get('A1.2.1x').label, `${law} 제20조 제2항 제1호 단서`);
  // 항이 없는 조문도 본문의 단서를 나눈다.
  assert.match(r.get('A2x').text, /조례로 달리/);
  assert.equal(r.get('A1.2x').textHash, buildEvidenceRegistry(context()).get('A1.2x').textHash, '같은 원문은 같은 해시');
});

test('기준일에 효력이 없는 조문은 등록하되 인용 가능 목록에서 뺀다', () => {
  const r = buildEvidenceRegistry(context());
  assert.equal(r.get('A3').inForce, false);
  assert.ok(!r.citableIds().includes('A3'));
  assert.match(r.renderIndex().text, /\[A3\].*기준일 효력 없음/);
});

test('항 번호 없이 바로 시작하는 호와 본문을 각각 출처 단위로 등록한다', () => {
  const article = { ...OFFICIAL, lawName: '약관의 규제에 관한 법률', fullArticleNo: '7', title: '면책조항의 금지',
    content: '다음 각 호의 어느 하나에 해당하는 조항은 무효로 한다.',
    paragraphs: [{ paragraphNo: '', content: '', items: [
      { itemNo: '1.', content: '사업자의 책임을 배제하는 조항' },
      { itemNo: '2.', content: '사업자의 책임을 제한하는 조항' }
    ] }] };
  const r = buildEvidenceRegistry({ meta: { asOfDate: '20260923' }, officialEvidence: {
    lawDetail: { ...OFFICIAL, lawName: article.lawName }, articles: [article] } });
  assert.deepEqual(r.children('A1').map(e => e.id), ['A1.0', 'A1.0.1', 'A1.0.2']);
  assert.equal(r.get('A1.0.1').text, '사업자의 책임을 배제하는 조항');
  assert.match(r.renderFull(['A1']).text, /\[A1\.0\.2\] 사업자의 책임을 제한하는 조항/);
});

test('판례는 본문을 확보한 공식 자료만, 판시사항·판결요지를 번호 단위 명제로 나누고 참조조문을 잇는다', () => {
  const r = buildEvidenceRegistry(context());
  assert.deepEqual(r.ids(e => e.kind === 'PRECEDENT'), ['P1'], '목록만 있는 판례와 목업 판례는 제외');
  assert.deepEqual(r.children('P1').map(e => e.id), ['P1.h1', 'P1.h2', 'P1.y1', 'P1.y2']);
  assert.equal(r.get('P1.y2').text, '수탁자의 제3자 사용은 별도 허가가 필요하다.');
  assert.deepEqual(r.get('P1').referenceIds, ['A2', 'A1'], '수집한 조문만 연결하고 민법은 연결하지 않는다');
});

test('해석례·자치법규·행정규칙·외부 지식을 각자의 접두어로 등록하고 외부 지식은 비공식으로 둔다', () => {
  const r = buildEvidenceRegistry(context());
  assert.deepEqual(r.children('Q1').map(e => e.id), ['Q1.a', 'Q1.r']);
  assert.equal(r.get('O1').label, '가상시 공유재산 관리 조례 제9조');
  assert.equal(r.get('R1.4').label, '공유재산 운영기준 제4조');
  assert.equal(r.get('K1').official, false);
  assert.ok(!r.citableIds().includes('K1'));
  assert.match(r.renderFull(['K1']).text, /비공식 — 공식 근거로 인용 금지/);
});

test('첨부문서는 조항 단위로 등록하고 긴 조항은 조각을 따로 둔다', () => {
  const doc = `제1조(목적) 이 계약은 시스템 구축을 목적으로 한다.\n제2조(대금) ${'대금 지급 조건을 정한다. '.repeat(30)}\n\n${'지체 시 위약금을 부과한다. '.repeat(30)}`;
  const r = buildEvidenceRegistry(context(), { documentText: doc });
  const docs = r.ids(e => e.kind === 'DOCUMENT');
  assert.equal(docs.length, 2);
  assert.match(r.get('D1').label, /첨부문서 제1조/);
  assert.ok(r.children('D2').length >= 2, '900자를 넘는 조항은 조각으로 나눈다');
  assert.ok(!r.citableIds().some(id => id.startsWith('D')), '첨부문서는 사실의 출처이지 법적 근거가 아니다');
});

test('등록부에 없는 ID는 따로 돌려주고, 예산을 넘는 근거는 잘라 싣지 않고 통째로 뺀다', () => {
  const r = buildEvidenceRegistry(context());
  const { found, unknown } = r.resolve(['A1.2x', '[P1.y2]', 'P9', 'A1.2x', '제20조']);
  assert.deepEqual(found.map(e => e.id), ['A1.2x', 'P1.y2']);
  assert.deepEqual(unknown, ['P9', '제20조']);

  const full = r.renderFull(['A1', 'P1', 'Q1', 'ZZ'], { maxChars: 400 });
  assert.ok(full.included.includes('A1'));
  assert.ok(full.omitted.length > 0);
  assert.deepEqual(full.unknown, ['ZZ']);
  assert.ok(full.text.length <= 400);
  assert.match(full.text, /\[A1\.2x\] \(단서\) 다만/);
  for (const id of full.omitted) assert.doesNotMatch(full.text, new RegExp(`\\[${id}\\]`));
});

test('색인은 최상위 항목 한 줄씩이며 하위 ID를 함께 알려주고 예산을 넘으면 건수를 센다', () => {
  const r = buildEvidenceRegistry(context());
  const index = r.renderIndex();
  assert.match(index.text, /^\[A1\] 공유재산 및 물품 관리법 제20조\(사용허가\) — .* \{A1\.1, A1\.2, A1\.2x/m);
  assert.doesNotMatch(index.text, /^\[A1\.2\]/m);
  const small = r.renderIndex({ maxChars: 200 });
  assert.ok(small.omitted > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(r)).find(e => e.id === 'A1').textChars > 0, true, '직렬화에는 원문 대신 길이만 남긴다');
  const display = r.toJSON().find(e => e.id === 'A1');
  assert.equal(display.text, undefined);
  assert.match(display.preview, /지방자치단체의 장은 행정재산/);
});

test('번호·단서 분해 보조 함수', () => {
  assert.deepEqual([unitNumber('①'), unitNumber('3.'), unitNumber('제12항'), unitNumber('')], ['1', '3', '12', '']);
  assert.equal(splitProviso('원칙만 있다.'), null);
  assert.deepEqual(splitProviso('원칙이다. 다만, 예외다.'), { principle: '원칙이다.', proviso: '다만, 예외다.' });
  assert.deepEqual(splitNumberedPropositions('번호 없는 요지'), [{ no: 1, text: '번호 없는 요지' }]);
  assert.deepEqual(formatArticleNo('15의2'), '제15조의2');
});
