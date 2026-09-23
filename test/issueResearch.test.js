import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { planResearchQueries, runResearchQueries, selectIssueEvidence } from '../server/reasoning/stages/issueResearch.js';

const OFFICIAL = { source: 'OFFICIAL_API' };
const law = '공유재산 및 물품 관리법';
const context = () => ({
  meta: { primaryLawName: law, asOfDate: '20260923' },
  officialEvidence: {
    lawDetail: { ...OFFICIAL, lawName: law },
    articles: [
      { ...OFFICIAL, lawName: law, fullArticleNo: '20', title: '사용허가', enforceDate: '20200101', content: '',
        paragraphs: [{ paragraphNo: '①', content: '행정재산의 사용을 허가할 수 있다.' }, { paragraphNo: '②', content: '일반입찰로 한다. 다만, 수의의 방법으로 할 수 있다.' }] },
      { ...OFFICIAL, lawName: law, fullArticleNo: '27', title: '관리위탁', enforceDate: '20200101', content: '관리위탁을 받은 자는 사용허가를 받은 것으로 본다.', paragraphs: [] }
    ],
    precedents: [{ ...OFFICIAL, id: '100', contentStatus: 'FULL_TEXT', courtName: '대법원', caseNo: '2018두1', caseName: '기존 판례',
      holding: '[1] 관리위탁의 성질', summary: '[1] 관리위탁은 사용허가와 구별된다.', referencedArticles: `${law} 제27조` }],
    interpretations: []
  }
});

const issue = (overrides = {}) => ({ id: 'I1', question: '수탁자의 제3자 사용에 별도 사용허가가 필요한가?', type: 'PRIMARY', priority: 'HIGH',
  dependsOn: [], factIds: ['F1'], evidenceIds: ['A1.2', 'A2'], searchTerms: ['관리위탁', '사용허가 의제'], ...overrides });

test('쟁점별 검색어는 검색어와 조문 번호로 만들고, 쟁점 간 겹치는 검색어는 한 번만 조회하며 전체 상한을 지킨다', () => {
  const registry = buildEvidenceRegistry(context());
  const plan = planResearchQueries([issue(), issue({ id: 'I2', searchTerms: ['관리위탁', '위탁료'], evidenceIds: ['A2'] })], registry,
    { termsPerIssue: 2, articleQueries: 1, totalQueries: 4, perQuery: 3, candidatesPerIssue: 4 });
  assert.deepEqual(plan.byIssue.I1, ['관리위탁', '사용허가 의제', `${law} 제20조`]);
  assert.deepEqual(plan.queries, ['관리위탁', '사용허가 의제', `${law} 제20조`, '위탁료']);
  assert.deepEqual(plan.byIssue.I2, ['관리위탁', '위탁료'], '상한 밖의 조문 검색은 빠진다');
  assert.deepEqual(plan.skipped, [`${law} 제27조`]);
});

test('조사 결과 중 공식 본문 자료만 기존 자료 뒤에 덧붙여 기존 번호를 지키고, 조회 실패는 경고로 남긴다', async () => {
  const calls = [];
  const clients = {
    searchPrecedents: async q => { calls.push(['prec', q]); return q === '관리위탁'
      ? [{ ...OFFICIAL, id: '100', contentStatus: 'FULL_TEXT', caseNo: '2018두1' },
        { ...OFFICIAL, id: '200', contentStatus: 'FULL_TEXT', courtName: '대법원', caseNo: '2021두2', summary: '수탁자의 제3자 사용은 별도 허가가 필요하다.', referencedArticles: `${law} 제20조` },
        { ...OFFICIAL, id: '300', contentStatus: 'LIST_ONLY', caseNo: '2022두3' }]
      : Object.assign([], { fetchStatus: 'ERROR' }); },
    searchInterpretations: async () => [{ ...OFFICIAL, id: '9', contentStatus: 'FULL_TEXT', title: '위탁 해석', answer: '허가가 필요합니다.' }]
  };
  const registry = buildEvidenceRegistry(context());
  const plan = planResearchQueries([issue()], registry);
  const result = await runResearchQueries(context(), plan, { clients });
  assert.deepEqual(result.added, { precedents: 1, interpretations: 1 });
  assert.deepEqual(result.context.officialEvidence.precedents.map(p => p.caseNo), ['2018두1', '2021두2']);
  assert.ok(result.warnings.some(w => /'사용허가 의제' 판례 조회 미완료/.test(w)));
  assert.deepEqual(result.hits['관리위탁'], ['prec:100', 'prec:200', 'expc:9']);
  const rebuilt = buildEvidenceRegistry(result.context);
  assert.equal(rebuilt.get('P1').caseNo, '2018두1', '기존 판례 번호는 그대로다');
  assert.equal(rebuilt.get('P2').caseNo, '2021두2');
  assert.equal(calls.length, 3);
});

test('후보 근거는 특징을 따로 남기고 정렬하며, 판례는 쟁점에 가장 가까운 명제만 싣고 조문 단서를 반대 후보로 붙인다', async () => {
  const ctx = context();
  ctx.officialEvidence.precedents.push({ ...OFFICIAL, id: '200', contentStatus: 'FULL_TEXT', courtName: '서울고등법원', caseNo: '2021누2',
    holding: '[1] 위탁 [2] 허가', summary: '[1] 위탁료 산정 기준 [2] 수탁자의 제3자 사용은 별도 허가가 필요하다.', referencedArticles: '' });
  ctx.officialEvidence.precedents.push({ ...OFFICIAL, id: '300', contentStatus: 'FULL_TEXT', courtName: '대법원', caseNo: '2019다3',
    summary: '임대차 보증금 반환', referencedArticles: '민법 제618조' });
  const registry = buildEvidenceRegistry(ctx);
  // 가짜 임베딩: 질문과 '별도 허가' 명제를 가깝게 둔다.
  const embed = async texts => ({ vectors: texts.map(t => /별도 (사용)?허가/.test(t) ? [1, 0] : [0, 1]), warning: null });
  const facts = [{ id: 'F1', docRef: 'D2', status: 'CONFIRMED' }, { id: 'F2', docRef: 'QUERY' }];
  const result = await selectIssueEvidence({ issue: issue(), registry, facts, plan: { byIssue: { I1: ['관리위탁'] } },
    hits: { 관리위탁: ['prec:200'] }, embed });

  assert.deepEqual(result.candidates.map(c => c.id), ['P2', 'P1'], '무관한 판례(P3)는 후보에서 빠진다');
  const p2 = result.candidates[0];
  assert.deepEqual(p2.features, { retrievedForIssue: true, namedByS1: false, articleMatch: false, termHits: 2, supremeCourt: false, semantic: 1 });
  assert.equal(p2.focusId, 'P2.y2');
  assert.equal(result.candidates[1].features.articleMatch, true, '참조조문이 쟁점 조문과 같다');
  assert.deepEqual(result.evidenceIds, ['A1.2', 'A2', 'P2', 'P1'], '판례는 반대 명제가 빠지지 않게 통째로 싣는다');
  assert.deepEqual(result.adverseCandidateIds, ['A1.2x']);
  assert.deepEqual(result.documentIds, ['D2']);
});

test('임베딩을 쓸 수 없으면 문자열 특징만으로 정렬하고 사유를 돌려준다', async () => {
  const registry = buildEvidenceRegistry(context());
  const embed = async texts => ({ vectors: texts.map(() => null), warning: '임베딩 모델(bge-m3)을 사용할 수 없어 문자열 일치로만 정렬했습니다: HTTP 404' });
  const result = await selectIssueEvidence({ issue: issue(), registry, facts: [], plan: { byIssue: {} }, hits: {}, embed });
  assert.match(result.warning, /문자열 일치로만/);
  assert.equal(result.candidates[0].features.semantic, null);
  assert.deepEqual(result.evidenceIds, ['A1.2', 'A2', 'P1']);
});
