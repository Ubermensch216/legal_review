import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findLawByName } from '../server/law/lawWorkbench.js';

const FULL = { lawName: '국가유공자 등 예우 및 지원에 관한 법률', lawNameShort: '국가유공자법', lawId: '1', lawSeq: '10' };
const DECREE = { lawName: '국가유공자 등 예우 및 지원에 관한 법률 시행령', lawNameShort: '국가유공자법 시행령', lawId: '2', lawSeq: '20' };

// 실제 API의 동작을 흉내 낸다: 약칭 전체로는 0건, 정식명에 든 단어로 검색하면 약칭이 일치하는 법령이 나온다.
const fakeApi = () => {
  const queries = [];
  return { queries, searchLaw: async query => { queries.push(query); return query === '국가유공자법' || query === '국가유공자법 시행령' ? [] : [FULL, DECREE]; } };
};

test('약칭으로 검색해 0건이면 어간으로 다시 찾아 약칭이 일치하는 법령을 돌려준다', async () => {
  const api = fakeApi();
  assert.equal((await findLawByName(api, '국가유공자법')).lawId, '1');
  assert.deepEqual(api.queries, ['국가유공자법', '국가유공자']);
});

test('약칭이 붙은 시행령도 찾고, 일치하는 법령이 없으면 null을 돌려준다', async () => {
  assert.equal((await findLawByName(fakeApi(), '국가유공자법 시행령')).lawId, '2');
  assert.equal(await findLawByName(fakeApi(), '존재하지않는법'), null);
});

test('정확한 이름이 바로 검색되면 한 번만 조회한다', async () => {
  const queries = [];
  const api = { searchLaw: async q => { queries.push(q); return [{ lawName: '근로기준법', lawId: '9' }]; } };
  assert.equal((await findLawByName(api, '근로기준법')).lawId, '9');
  assert.deepEqual(queries, ['근로기준법']);
});

test('2글자 법령명(민법)도 정확한 이름으로 검색하고, 어간 재검색은 하지 않는다', async () => {
  const queries = [];
  const api = { searchLaw: async q => { queries.push(q); return []; } };
  assert.equal(await findLawByName(api, '민법'), null);
  assert.deepEqual(queries, ['민법']);
});

test('검색이 목록이 아닌 상태 값을 돌려줘도 오류 없이 못 찾은 것으로 본다', async () => {
  const api = { searchLaw: async () => Object.assign([], { fetchStatus: 'ERROR' }) };
  assert.equal(await findLawByName(api, '근로기준법'), null);
});
