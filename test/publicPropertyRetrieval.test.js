import './setup.js';
// test/publicPropertyRetrieval.test.js
// 사전 컨설팅감사(영화의전당 사용료 산정) 사안을 답하기 위해 필요한 수집 경로 회귀 테스트.
// 이 사안은 자치법규·행정규칙 조문이 없으면 결론을 낼 수 없으므로,
// 법령명 절단·조례 파싱·기준 법령 폴백이 되돌아가면 여기서 잡힌다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleReferences, extractOrdinanceNames } from '../server/law/lawArticleRef.js';
import { parseOrdinances, parseOrdinanceDetail, parseAdminRules } from '../server/law/decisionsApiParser.js';
import { buildWorkbenchContext } from '../server/law/lawWorkbench.js';
import { buildConsultingAuditOpinion } from '../server/export/consultingAuditReport.js';
import { retrieveCascadingHierarchy } from '../server/law/cascadingRetriever.js';
import { buildReviewInput } from '../server/law/reviewContext.js';

test("법령명에 포함된 '및'을 나열 구분자로 오인해 이름을 자르지 않는다", () => {
  const cases = [
    ['공유재산 및 물품 관리법 시행령 제31조', '공유재산 및 물품 관리법 시행령'],
    ['부산광역시 공유재산 및 물품 관리 조례 제22조', '부산광역시 공유재산 및 물품 관리 조례'],
    ['「공유재산 및 물품관리법 시행령」제31조', '공유재산 및 물품관리법 시행령'],
    ['「지방세법」 제4조제1항', '지방세법']
  ];
  for (const [text, expected] of cases) {
    assert.equal(extractArticleReferences(text)[0].lawName, expected, text);
  }
});

test("앞선 인용 뒤의 '및'은 나열 구분자로 처리한다", () => {
  const refs = extractArticleReferences('개인정보 보호법 제15조의2 제1항 제2호 및 근로기준법 제56조');
  assert.equal(refs[0].lawName, '개인정보 보호법');
  assert.equal(refs[1].lawName, '근로기준법');
});

test("'같은 법' 등 대용 표현은 직전에 확정된 법령으로 해석한다", () => {
  const refs = extractArticleReferences('「부동산 가격공시에 관한 법률」 제10조에 따르며, 없으면 같은 법 제8조를 적용한다');
  assert.equal(refs[0].lawName, '부동산 가격공시에 관한 법률');
  assert.equal(refs[1].lawName, '부동산 가격공시에 관한 법률');
  assert.equal(refs[1].fullArticleNo, '8');
});

test('조문 인용이 없어도 자치법규 제명을 수집한다', () => {
  const names = extractOrdinanceNames('■ 부산광역시 사전 컨설팅감사 운영 조례 ［별지 제1호서식］ 및 부산광역시 공유재산 및 물품 관리 조례 제22조');
  assert.ok(names.includes('부산광역시 사전 컨설팅감사 운영 조례'), JSON.stringify(names));
  assert.ok(names.includes('부산광역시 공유재산 및 물품 관리 조례'), JSON.stringify(names));
});

test('자치법규 목록은 <law> 항목을, 행정규칙 목록은 <AdmRulSearch> 루트를 읽는다', () => {
  const ordinXml = `<?xml version="1.0" encoding="UTF-8"?><OrdinSearch><totalCnt>1</totalCnt>
    <law id="1"><자치법규일련번호>2120407</자치법규일련번호><자치법규명><![CDATA[부산광역시 공유재산 및 물품 관리 조례]]></자치법규명>
    <자치법규ID>2060161</자치법규ID><지자체기관명>부산광역시</지자체기관명><자치법규종류>조례</자치법규종류></law></OrdinSearch>`;
  const ordinances = parseOrdinances(ordinXml);
  assert.equal(ordinances.length, 1);
  assert.equal(ordinances[0].name, '부산광역시 공유재산 및 물품 관리 조례');
  assert.equal(ordinances[0].id, '2120407');

  const admrulXml = `<?xml version="1.0" encoding="UTF-8"?><AdmRulSearch><totalCnt>1</totalCnt>
    <admrul id="1"><행정규칙일련번호>2100000280396</행정규칙일련번호><행정규칙명><![CDATA[지방자치단체 공유재산 운영기준]]></행정규칙명>
    <행정규칙종류>고시</행정규칙종류><소관부처명>행정안전부</소관부처명></admrul></AdmRulSearch>`;
  const rules = parseAdminRules(admrulXml);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, '지방자치단체 공유재산 운영기준');
});

test('자치법규 본문은 100배 조문번호를 풀고 항·호를 복원하며 엔티티를 디코딩한다', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><LawService>
    <자치법규기본정보><자치법규ID>2060161</자치법규ID><자치법규일련번호>2120407</자치법규일련번호>
      <자치법규명><![CDATA[부산광역시 공유재산 및 물품 관리 조례]]></자치법규명><시행일자>20260408</시행일자>
      <지자체기관명>부산광역시</지자체기관명></자치법규기본정보>
    <조문><조 조문번호='002200'><조문번호>2200</조문번호><조제목><![CDATA[건물대부료 산출기준]]></조제목>
      <조내용><![CDATA[제22조(건물대부료 산출기준)
① 건물의 대부료를 산출하는 경우 재산 평정가격은 건물평가액 및 부지평가액을 합산하여 결정한다.
② 제1항의 건물평가액과 부지평가액은 다음 각 호의 계산식에 따라 계산된 면적을 기준으로 한다.
1. 건물면적&#8231;산정
2. 부지면적 산정]]></조내용></조></조문></LawService>`;
  const detail = parseOrdinanceDetail(xml);
  assert.equal(detail.lawName, '부산광역시 공유재산 및 물품 관리 조례');
  const article = detail.articles.find(a => a.fullArticleNo === '22');
  assert.ok(article, '제22조를 찾지 못했습니다.');
  assert.equal(article.title, '건물대부료 산출기준');
  assert.equal(article.paragraphs.length, 2);
  assert.equal(article.paragraphs[1].items.length, 2);
  assert.ok(!article.paragraphs[1].items[0].content.includes('&#'), '엔티티가 남아 있습니다.');
});

test('첫 인용이 조회 불가한 조례여도 기준 법령을 조회 가능한 법령으로 확정한다', async () => {
  // 인용 순서상 조례가 먼저 나온다. 과거에는 여기서 조회가 끝나 조문 없이 검토가 나갔다.
  const documentText = '부산광역시 공유재산 및 물품 관리 조례 제22조 및 공유재산 및 물품 관리법 시행령 제31조에 따라 사용료를 산정한다.';
  const decree = {
    lawId: '010146', lawSeq: '1', lawName: '공유재산 및 물품 관리법 시행령', source: 'OFFICIAL_API',
    articles: [{ articleNo: '31', fullArticleNo: '31', title: '대부료율과 대부재산의 평가', content: '제31조(대부료율과 대부재산의 평가)', paragraphs: [] }]
  };
  const context = await buildWorkbenchContext({ query: '사용료 산정', preset: 'pre_consulting_audit', documentText }, {
    // 조례는 법령 API가 제공하지 않으므로 빈 결과가 정상이다.
    searchLaw: async name => (name === '공유재산 및 물품 관리법 시행령' ? [{ lawId: '010146', lawSeq: '1', lawName: name, enforceDate: '20260721' }] : []),
    getLawDetail: async () => decree,
    searchPrecedents: async () => [], searchInterpretations: async () => [],
    searchAdminRules: async () => [], searchOrdinances: async () => [],
    getOrdinanceDetail: async () => { throw new Error('본문 없음'); },
    getAdminRuleDetail: async () => { throw new Error('본문 없음'); },
    retrieveCascadingHierarchy: async () => null,
    runTool: async () => ({ ok: true, result: null })
  });

  assert.equal(context.meta.primaryLawName, '공유재산 및 물품 관리법 시행령');
  assert.equal(context.meta.dataIntegrity.sources.law, 'OFFICIAL_API');
  assert.ok(context.officialEvidence.articles.some(a => a.fullArticleNo === '31'));
});

test('사전 컨설팅감사 의견서는 대립 견해와 처리 결과를 서식에 담는다', () => {
  const markdown = buildConsultingAuditOpinion({
    review: {
      facts: '행정재산 사용료 산정 방식에 대한 이견',
      coreIssues: ['감정평가액 적용 가능 여부'],
      legalBasis: [{ lawName: '공유재산 및 물품 관리법 시행령', articleNo: '제31조 제2항 제1호', title: '대부료율과 대부재산의 평가', verificationStatus: 'VERIFIED' }],
      legalOpinion: '단서의 예외 요건을 충족해야 감정평가액을 적용할 수 있다.',
      opposingViews: [
        { label: '갑설', holder: '신청기관', position: '감정평가액으로 산출', citedBasis: ['시행령 제31조제2항제1호 단서'], assessment: '예외 요건 미충족', verdict: '부당' },
        { label: '을설', holder: '감사기구', position: '조례 산정방식 적용', citedBasis: ['조례 제22조'], assessment: '문언에 부합', verdict: '타당' }
      ],
      auditConclusion: { result: '반려', reason: '법령에 명확히 규정되어 있음', basis: '부산광역시 사전 컨설팅감사 운영 조례 제4조제2항', guidance: '소관 부서와 협의' },
      furtherChecks: []
    },
    officialEvidence: { ordinanceArticles: [{ lawName: '부산광역시 공유재산 및 물품 관리 조례' }], adminRuleDetails: [{ name: '지방자치단체 공유재산 운영기준' }] }
  }, '| 접수번호 | 2026-24 | 신청기관(부서명) | (재)영화의전당 |\n| 건   명 | 공유재산 사용허가에 따른 사용료 산정에 관한 사항 |  |');

  assert.match(markdown, /【 사전 컨설팅감사 의견서 】/);
  assert.match(markdown, /2026-24/);
  assert.match(markdown, /\(재\)영화의전당/);
  assert.match(markdown, /갑설[\s\S]*부당/);
  assert.match(markdown, /을설[\s\S]*타당/);
  assert.match(markdown, /사전 컨설팅감사 결과 : "반려"/);
  assert.match(markdown, /지방자치단체 공유재산 운영기준/);
  // 수정할 원문 조항이 없는 사안이므로 Redline 표는 나오지 않아야 한다.
  assert.doesNotMatch(markdown, /신·구 조문 대비표/);
});

test('시행령을 기준으로 삼으면 모법 조문은 번호가 아니라 본문 인용으로 찾는다', async () => {
  // 과거에는 시행령 제31조를 기준으로 삼고 모법 '제31조(대부기간)'를 골라왔다.
  const act = {
    lawId: '1', lawName: '공유재산 및 물품 관리법', source: 'OFFICIAL_API',
    articles: [
      { articleNo: '22', fullArticleNo: '22', title: '사용료', content: '제22조(사용료)', paragraphs: [] },
      { articleNo: '27', fullArticleNo: '27', title: '행정재산의 관리위탁', content: '제27조(관리위탁)', paragraphs: [] },
      { articleNo: '31', fullArticleNo: '31', title: '대부기간', content: '제31조(대부기간)', paragraphs: [] }
    ]
  };
  const decree = {
    lawId: '2', lawName: '공유재산 및 물품 관리법 시행령', source: 'OFFICIAL_API',
    articles: [{ articleNo: '31', fullArticleNo: '31', title: '대부료율과 대부재산의 평가',
      content: '제31조 ① 법 제22조제1항에 따른 대부료는 ...', paragraphs: [] }]
  };
  const result = await retrieveCascadingHierarchy({
    lawName: '공유재산 및 물품 관리법 시행령', articleNos: ['31'], actArticleNos: ['27']
  }, {
    searchLaw: async name => [{ lawId: name.includes('시행령') ? '2' : '1', lawSeq: '1', lawName: name, enforceDate: '20260101' }],
    getLawDetail: async id => (id === '2' ? decree : (id === '1' ? act : { lawName: '', articles: [] })),
    searchAdminRules: async () => []
  });

  const actNumbers = (result.act?.articles || []).map(a => a.fullArticleNo);
  assert.ok(actNumbers.includes('22'), '시행령 본문이 인용한 모법 제22조를 가져와야 합니다.');
  assert.ok(actNumbers.includes('27'), '지식베이스가 지정한 모법 제27조를 가져와야 합니다.');
  assert.ok(!actNumbers.includes('31'), '시행령 조문 번호를 모법에 그대로 적용하면 안 됩니다.');
  assert.deepEqual((result.decree?.articles || []).map(a => a.fullArticleNo), ['31']);
});

test('원칙(본문)과 예외(단서) 구조를 분리해 별도 입력으로 제공한다', () => {
  const context = {
    officialEvidence: {
      lawDetail: { source: 'OFFICIAL_API' },
      articles: [{
        lawName: '공유재산 및 물품 관리법 시행령', fullArticleNo: '31', title: '대부료율과 대부재산의 평가',
        source: 'OFFICIAL_API', content: '제31조',
        paragraphs: [{
          paragraphNo: '②', content: '② 재산의 가격은 다음 각 호의 방법으로 산출한다.',
          items: [{ itemNo: '1.', subItems: [],
            content: '1. 토지: 개별공시지가를 적용한다. 다만, 지방자치단체의 장이 필요하다고 인정하는 경우에는 감정평가액 이상의 금액으로 한다.' }]
        }]
      }],
      ordinanceArticles: [], adminRuleDetails: [], precedents: [], interpretations: []
    },
    impactAndRevisions: { extractedReferences: [{ lawName: '공유재산 및 물품 관리법 시행령', fullArticleNo: '31' }] }
  };
  const { keyProvisionsText } = buildReviewInput(context, '', '사용료 산정');
  assert.match(keyProvisionsText, /제2항 제1호/);
  assert.match(keyProvisionsText, /\[원칙\][\s\S]*개별공시지가를 적용한다/);
  assert.match(keyProvisionsText, /\[예외·단서\][\s\S]*감정평가액 이상의 금액/);
  assert.match(keyProvisionsText, /※신청서가 직접 인용/);
});
