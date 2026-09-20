// test/reRankerAndVerifier.test.js - 판례 Re-ranking 및 조문 실존성 검증기 단위 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import { reRankPrecedents, reRankInterpretations } from '../server/law/reRanker.js';
import { verifyAndCorrectReviewCitations } from '../server/law/factualityVerifier.js';
import { retrieveCascadingHierarchy } from '../server/law/cascadingRetriever.js';

test('판례 시맨틱 Re-ranking 및 관련도 스코어링 (reRanker)', () => {
  const mockPrecedents = [
    {
      caseNo: '2015도1234',
      caseName: '일반 민사 분쟁',
      courtName: '서울중앙지방법원',
      holding: '일반적인 채무불이행에 관한 법리',
      summary: '계약 해제 요건'
    },
    {
      caseNo: '2020도5678',
      caseName: '개인정보보호법위반',
      courtName: '대법원',
      holding: '개인정보 보호법 제25조 제5항의 영상정보처리기기 녹음금지 규정은 강행규정이다.',
      summary: 'CCTV에 음성녹음 기능을 추가하여 대화내용을 녹음한 행위는 위법'
    },
    {
      caseNo: '2019두9999',
      caseName: '시정명령취소청구',
      courtName: '대법원 전원합의체',
      holding: '개인정보 보호법 제15조의 동의 요건',
      summary: '사전 동의 없이 정보를 수집한 경우 시정명령 및 과태료 처분은 적법'
    }
  ];

  const ranked = reRankPrecedents({
    precedents: mockPrecedents,
    query: 'CCTV 음성녹음 및 사전동의 생략',
    targetLaw: '개인정보 보호법',
    articleNos: ['제25조', '제15조'],
    expandedTerms: ['음성녹음', '동의생략', '영상정보처리기기']
  });

  assert.equal(ranked.length, 3);
  // 제25조 및 대법원 판례인 2020도5678 또는 2019두9999가 최상위로 랭크되어야 함
  assert.ok(ranked[0].relevanceScore >= 85, `Top 판례 점수가 85점 이상이어야 함 (실제: ${ranked[0].relevanceScore})`);
  assert.ok(ranked[0].caseNo === '2020도5678' || ranked[0].caseNo === '2019두9999', '가장 관련도 높은 판례가 1위로 정렬되어야 함');
  assert.ok(ranked[0].matchReason.length > 0, '매칭 사유가 생성되어야 함');
});

test('조문 실존성 검증 및 미검증 인용 표시 (factualityVerifier)', async () => {
  const mockReview = {
    summary: '검토 결론',
    legalBasis: [
      { lawName: '개인정보 보호법', articleNo: '제25조', title: '영상정보처리기기의 설치ㆍ운영 제한' },
      { lawName: '개인정보 보호법', articleNo: '제999조', title: '존재하지 않는 가공의 조항' } // 환각 테스트용
    ]
  };

  const mockContext = {
    meta: { primaryLawName: '개인정보 보호법' },
    officialEvidence: {
      articles: [
        { articleNo: 25, fullArticleNo: '25', title: '영상정보처리기기의 설치ㆍ운영 제한', content: '...' },
        { articleNo: 15, fullArticleNo: '15', title: '개인정보의 수집ㆍ이용', content: '...' }
      ]
    }
  };

  const { verifiedReview, verificationReport } = await verifyAndCorrectReviewCitations({
    review: mockReview,
    workbenchContext: mockContext
  });

  assert.ok(verificationReport, '검증 리포트가 생성되어야 함');
  assert.equal(verificationReport.validCount, 1, '유효 조문 1건 검증');

  // 존재하지 않는 조문은 '교정'하지 않고 미검증으로 표시해야 한다.
  // 과거에는 배열 순번상 아무 조문으로 바꿔치기한 뒤 신뢰도 90으로 통과시켰고,
  // 그 결과 환각 인용이 '다른 틀린 인용'이 되어 검증을 통과한 것처럼 보였다.
  assert.equal(verificationReport.correctionsCount, 0, '임의 치환(자동 교정)은 더 이상 수행하지 않아야 함');
  assert.equal(verificationReport.unverifiedCount, 1, '존재하지 않는 제999조는 미검증으로 집계되어야 함');
  assert.equal(verifiedReview.legalBasis[1].articleNo, '제999조', '원본 인용은 임의로 바뀌지 않아야 함');
  assert.equal(verifiedReview.legalBasis[1].verificationStatus, 'UNVERIFIED', '미검증 표식이 붙어야 함');

  // 신뢰도는 실제 검증 비율이어야 한다 (2건 중 1건 → 50%).
  // 과거에는 Math.max(..., 80) 클램프 때문에 80% 미만이 나올 수 없었다.
  assert.equal(verificationReport.citationConfidence, 50, '신뢰도는 실측 비율(1/2=50%)이어야 함');
  assert.equal(verificationReport.isMeasurable, true, '검증 대상이 있으므로 측정 가능해야 함');
});

test('검증 대상이 없으면 신뢰도를 숫자로 날조하지 않는다 (factualityVerifier)', async () => {
  const { verificationReport } = await verifyAndCorrectReviewCitations({
    review: { summary: '검토 결론', legalBasis: [] },
    workbenchContext: { meta: { primaryLawName: '개인정보 보호법' }, officialEvidence: { articles: [] } }
  });

  // 과거에는 인용이 하나도 없어도 기본값 95%가 표시됐다.
  assert.equal(verificationReport.citationConfidence, null, '측정 대상이 없으면 null이어야 함');
  assert.equal(verificationReport.isMeasurable, false, '측정 불가로 표시되어야 함');
});

test('대조 기준이 목업이면 검증을 수행하지 않는다 (factualityVerifier)', async () => {
  const { verificationReport } = await verifyAndCorrectReviewCitations({
    review: {
      summary: '검토 결론',
      legalBasis: [{ lawName: '개인정보 보호법', articleNo: '제25조', title: '영상정보처리기기' }]
    },
    workbenchContext: {
      meta: { primaryLawName: '개인정보 보호법', dataIntegrity: { sources: { articles: 'MOCK' } } },
      officialEvidence: {
        articles: [{ articleNo: 25, fullArticleNo: '25', title: '영상정보처리기기', content: '...' }]
      }
    }
  });

  // 목업 조문을 기준으로 '검증 완료 100%'를 찍던 동작을 막는다.
  assert.equal(verificationReport.isMeasurable, false, '목업 기준이면 측정 불가여야 함');
  assert.equal(verificationReport.citationConfidence, null, '목업 기준이면 신뢰도를 산출하지 않아야 함');
  assert.ok(verificationReport.unmeasurableReason, '측정 불가 사유가 있어야 함');
});

test('3단계 체계적 연쇄 검색 (cascadingRetriever)', async () => {
  const cascade = await retrieveCascadingHierarchy({
    lawName: '개인정보 보호법',
    articleNos: ['제15조', '제25조']
  });

  assert.ok(cascade, '연쇄 검색 결과 객체가 반환되어야 함');
  assert.ok(cascade.act, '모법(법률) 정보가 존재해야 함');
  assert.ok(cascade.decree, '시행령 정보가 존재해야 함');
});
