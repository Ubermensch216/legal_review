import './setup.js';
// test/lawNameBoundary.test.js
// 법령 제명의 '앞쪽 경계' 회귀 테스트.
// 평문 인용("... 것이 지방자치법 제28조")은 제명 앞 문장까지 캡처 범위에 들어온다.
// 문장이 제명에 붙은 채로 법령 API에 나가면 전부 '본문 수집 실패'가 되므로,
// 아래 사례가 되돌아가면 여기서 잡힌다. (test/docs/test_mobility_ordinance.pdf 사안)
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleReferences, extractOrdinanceNames, trimLawNamePrefix } from '../server/law/lawArticleRef.js';

test('제명 앞에 붙은 문장은 법령명에서 잘라낸다', () => {
  const cases = [
    ['법률의 위임 없이 지자체 조례로 등록 취소 및 영업정지 처분을 신설하는 것이 지방자치법 제28조 단서', '지방자치법'],
    ['시장이 지정한 보행자 안심구역에서 개인형 이동장치를 운행한 자에 대하여는 도로교통법 제15조', '도로교통법'],
    ['법정 과태료 상한을 초과하여 부과할 수 있는지 여부는 질서위반행위규제법 제5조', '질서위반행위규제법'],
    ['해당 처분이 위법한 행정절차법 제21조 위반인지', '행정절차법'],
    ['연장근로 조항의 근로기준법 제56조 위반 여부', '근로기준법'],
    ['징계해고 절차의 근로기준법 제27조 저촉 여부', '근로기준법'],
    ['불이익 변경 절차의 근로기준법 제94조 위반 여부', '근로기준법']
  ];
  for (const [text, expected] of cases) {
    assert.equal(extractArticleReferences(text)[0].lawName, expected, text);
  }
});

test("완결된 제명 뒤의 '및'은 두 법령을 잇는 나열 구분자로 끊는다", () => {
  const refs = extractArticleReferences('행정대집행법 및 약관의 규제에 관한 법률 제6조, 제7조(면책조항의 무효) 저촉 여부');
  assert.equal(refs[0].lawName, '약관의 규제에 관한 법률');
  assert.equal(refs[0].fullArticleNo, '6');
});

test('제명 내부의 연결 어절은 그대로 보존한다', () => {
  const cases = [
    ['공유재산 및 물품 관리법 시행령 제31조', '공유재산 및 물품 관리법 시행령'],
    ['약관의 규제에 관한 법률 제6조', '약관의 규제에 관한 법률'],
    ['부패방지 및 국민권익위원회의 설치와 운영에 관한 법률 제27조', '부패방지 및 국민권익위원회의 설치와 운영에 관한 법률'],
    ['도시 및 주거환경정비법 제2조', '도시 및 주거환경정비법'],
    ['개인정보 보호법 제15조', '개인정보 보호법']
  ];
  for (const [text, expected] of cases) {
    assert.equal(extractArticleReferences(text)[0].lawName, expected, text);
  }
});

test('trimLawNamePrefix는 어간이 1음절인 명사를 활용형으로 오인하지 않는다', () => {
  // '제한/권한/신고'처럼 제명에 흔히 쓰이는 명사가 잘려나가면 제명이 망가진다.
  assert.equal(trimLawNamePrefix('옥외광고물 등의 관리와 옥외광고산업 진흥에 관한 법률'),
    '옥외광고물 등의 관리와 옥외광고산업 진흥에 관한 법률');
  assert.equal(trimLawNamePrefix('토지 등의 취득 및 보상에 관한 법률'), '토지 등의 취득 및 보상에 관한 법률');
});

test('문장 조각을 자치법규 제명으로 오인하지 않는다', () => {
  assert.deepEqual(extractOrdinanceNames('도로교통법 제15조 규정에도 불구하고 지자체 조례에 따라 과태료를 부과한다'), []);
  assert.deepEqual(extractOrdinanceNames('관계 고시 및 조례에서 정하는 바에 따른다'), []);
});

test('실제 자치법규 제명은 그대로 수집한다', () => {
  const names = extractOrdinanceNames(
    '부산광역시 사전 컨설팅감사 운영 조례 및 성남시 공유재산 관리 조례, 경기도 도로 점용 조례를 함께 검토한다');
  assert.ok(names.includes('부산광역시 사전 컨설팅감사 운영 조례'), JSON.stringify(names));
  assert.ok(names.includes('성남시 공유재산 관리 조례'), JSON.stringify(names));
  assert.ok(names.includes('경기도 도로 점용 조례'), JSON.stringify(names));
});
