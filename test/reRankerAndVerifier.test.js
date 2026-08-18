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

test('조문 실존성 자동 검증 및 오인용 보정 (factualityVerifier)', async () => {
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
  assert.equal(verificationReport.correctionsCount, 1, '존재하지 않는 제999조는 자동 교정되어야 함');
  assert.ok(verificationReport.citationConfidence >= 85, '인용 신뢰도가 85% 이상이어야 함');
  assert.notEqual(verifiedReview.legalBasis[1].articleNo, '제999조', '가공의 조문 번호가 실제 조문으로 보정되어야 함');
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
