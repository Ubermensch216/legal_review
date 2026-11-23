import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deidentify, findTitledNames, reidentifyDeep, reidentifyText, remainingIdentifiers } from '../server/privacy/deidentify.js';

const doc = { question: '홍길동 과장(010-1234-5678, gildong@example.com)이 수령한 수당이 적법한가', quote: '계좌 110-123-456789로 지급, 홍길동 과장은 서울특별시 종로구 세종대로 110에 근무' };

test('주민번호·연락처·계좌·주소와 직함이 붙은 이름을 같은 값은 같은 표기로 바꾼다', () => {
  const { value, mapping, counts } = deidentify(doc, { terms: [] });
  const text = JSON.stringify(value);
  for (const raw of ['홍길동', '010-1234-5678', 'gildong@example.com', '110-123-456789', '세종대로 110']) assert.ok(!text.includes(raw), `${raw} 남음`);
  assert.equal(value.question.match(/\[[^\]]+_\d+\]/g)[0], value.quote.match(/\[비공개_\d+\]/)[0], '같은 이름은 같은 표기');
  assert.ok(Object.values(mapping).includes('홍길동'));
  assert.ok(counts['전화'] >= 1);
  assert.deepEqual(remainingIdentifiers(text), []);
});

test('돌아온 답변은 매핑으로 원래 값을 복원한다', () => {
  const { value, mapping } = deidentify(doc);
  assert.deepEqual(reidentifyDeep(value, mapping).question, doc.question);
  assert.equal(reidentifyText('[없는표기_9]는 그대로', mapping), '[없는표기_9]는 그대로');
});

test('사용자 지정 단어(기관명 등)도 가리고, 남은 식별 후보는 검사로 잡는다', () => {
  const { value } = deidentify('가나다시청 개발부가 용역을 위탁했다', { terms: ['가나다시청'] });
  assert.ok(!value.includes('가나다시청'));
  assert.deepEqual(findTitledNames('김철수 팀장과 박영희 님이 회의했다. 대표자는 제외'), ['김철수', '박영희']);
  assert.ok(remainingIdentifiers('연락처 02-123-4567').length > 0);
  assert.deepEqual(remainingIdentifiers('근로기준법 제56조의 가산수당'), []);
});
