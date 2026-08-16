// test/lawHistory.test.js - 법령 검토 이력 저장, 조회, 복원, 삭제 단위 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveHistoryItem, getHistoryList, getHistoryById, deleteHistoryItem, clearAllHistory } from '../server/law/lawHistoryDb.js';

test('검토 이력 저장 및 목록 조회 검증', () => {
  // 1. 전체 초기화
  clearAllHistory();

  // 2. 이력 저장
  const id1 = saveHistoryItem({
    query: '개인정보 보호법 제15조 동의 요건 검토',
    preset: 'privacy_security',
    targetLaw: '개인정보 보호법',
    documentName: 'test_cctv.hwpx',
    reviewData: {
      review: {
        summary: '개인정보 보호법 상 동의 요건 준수가 필수적임.',
        risks: [{ level: 'HIGH', title: '과태료 처분 위험' }]
      }
    }
  });

  assert.ok(id1, '이력 ID가 생성되어야 함');

  const id2 = saveHistoryItem({
    query: '조례안 상위법 위반 검토',
    preset: 'ordinance_conflict',
    targetLaw: '지방자치법',
    reviewData: {
      review: {
        summary: '법률유보 원칙에 위배되어 조례 무효 가능성 높음.'
      }
    }
  });

  assert.ok(id2);

  // 3. 목록 조회 검증 (최신순 2건)
  const list = getHistoryList(10, 0);
  assert.equal(list.length, 2, '2개의 이력이 조회되어야 함');
  assert.equal(list[0].id, id2, '최신 이력이 첫 번째에 위치해야 함');
  assert.equal(list[1].id, id1);

  // 4. 상세 조회 및 복원 데이터 검증
  const detail = getHistoryById(id1);
  assert.ok(detail);
  assert.equal(detail.query, '개인정보 보호법 제15조 동의 요건 검토');
  assert.equal(detail.data.review.summary, '개인정보 보호법 상 동의 요건 준수가 필수적임.');

  // 5. 개별 삭제 검증
  const delRes = deleteHistoryItem(id1);
  assert.equal(delRes, true);
  const afterList = getHistoryList();
  assert.equal(afterList.length, 1);
  assert.equal(afterList[0].id, id2);

  // 6. 전체 삭제
  clearAllHistory();
  const emptyList = getHistoryList();
  assert.equal(emptyList.length, 0);
});
