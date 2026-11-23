import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenEvidenceCandidates, hydrateSelectedCandidates } from '../server/law/evidenceScreen.js';
import { publicDetailUrl } from '../server/law/decisionsApiParser.js';

const candidate = (id, overrides = {}) => ({ id, source: 'OFFICIAL_API', contentStatus: 'LIST_ONLY',
  caseNo: `2024두${id}`, caseName: `사건 ${id}`, ...overrides });

test('목록에서 명백히 무관한 후보만 제외하고 명시 인용·불확실 후보는 공식 본문을 확인한다', async () => {
  const listed = [candidate('1'), candidate('2'), candidate('3')];
  const screened = await screenEvidenceCandidates({ candidates: listed, kind: 'precedent', query: '사용허가',
    protectedIds: ['2'], classify: async () => [
      { id: '1', label: 'IRRELEVANT' }, { id: '2', label: 'IRRELEVANT' }, { id: '3', label: 'UNKNOWN' }
    ] });
  assert.deepEqual(screened.selected.map(x => x.id), ['2', '3']);
  assert.equal(screened.decisions[1].reason, '명시 인용 또는 필수 후보');
  const fetched = [];
  const loaded = await hydrateSelectedCandidates({ candidates: screened.selected, kind: 'precedent', loadDetail: async id => {
    fetched.push(id);
    return { id, caseNo: `2024두${id}`, source: 'OFFICIAL_API', contentStatus: 'FULL_TEXT', summary: '공식 판결요지' };
  } });
  assert.deepEqual(fetched, ['2', '3']);
  assert.equal(loaded.items.length, 2);
});

test('목록 선별 실패와 전부 제외 판정은 본문 확인 경로를 닫지 않는다', async () => {
  const listed = [candidate('1'), candidate('2')];
  const failure = await screenEvidenceCandidates({ candidates: listed, kind: 'precedent', query: '허가',
    classify: async () => { throw new Error('모델 연결 실패'); } });
  assert.deepEqual(failure.selected.map(x => x.id), ['1', '2']);
  assert.equal(failure.warnings.length, 1);
  const allRejected = await screenEvidenceCandidates({ candidates: listed, kind: 'precedent', query: '허가',
    classify: async () => listed.map(x => ({ id: x.id, label: 'IRRELEVANT' })) });
  assert.deepEqual(allRejected.selected.map(x => x.id), ['1']);
});

test('목록과 공식 본문의 사건번호가 다르면 근거로 채택하지 않는다', async () => {
  const loaded = await hydrateSelectedCandidates({ candidates: [candidate('1')], kind: 'precedent',
    loadDetail: async () => ({ id: '1', caseNo: '다른 사건', contentStatus: 'FULL_TEXT', source: 'OFFICIAL_API' }) });
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].contentStatus, 'LIST_ONLY');
  assert.match(loaded.warnings[0], /식별번호 불일치/);
});

test('공식 목록 상세 링크에서 API 계정 식별자를 제거한다', () => {
  assert.equal(publicDetailUrl('/DRF/lawService.do?OC=private-account&target=prec&ID=12'),
    '/DRF/lawService.do?target=prec&ID=12');
});

test('임베딩이 분명히 가른 후보는 LLM을 부르지 않고, 경계 후보만 LLM에 묻는다', async () => {
  const listed = [candidate('1', { caseName: '보훈수당 지급 조례' }), candidate('2', { caseName: '교통사고 과실상계' }),
    candidate('3', { caseName: '수당 지급 규정의 위임' })];
  const scores = { 1: 0.7, 2: 0.3, 3: 0.48 };
  const embed = async texts => ({ warning: null, vectors: texts.map((_, i) => i === 0 ? [1, 0] : [scores[i], Math.sqrt(1 - scores[i] ** 2)]) });
  const asked = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { asked.push(JSON.parse(options.body)); throw new Error('모델 호출 시험 차단'); };
  try {
    const screened = await screenEvidenceCandidates({ candidates: listed, kind: 'precedent', query: '보훈수당', issue: '보훈수당을 조례로 지급할 수 있는가',
      provider: 'ollama', model: 'x', embed });
    const byId = Object.fromEntries(screened.decisions.map(d => [d.id, d]));
    assert.deepEqual([byId[1].label, byId[1].method], ['RELEVANT', 'EMBEDDING']);
    assert.deepEqual([byId[2].label, byId[2].method], ['IRRELEVANT', 'EMBEDDING']);
    assert.equal(byId[3].method, 'NONE', '경계 후보는 LLM 몫이다(여기서는 호출이 차단되어 본문 확인 대상으로 남는다)');
    assert.deepEqual(screened.selected.map(x => x.id), ['1', '3']);
  } finally { globalThis.fetch = originalFetch; }
});

test('임베딩을 쓸 수 없으면 종전처럼 모든 후보를 LLM 선별로 넘긴다', async () => {
  const listed = [candidate('1'), candidate('2')];
  const asked = [];
  const screened = await screenEvidenceCandidates({ candidates: listed, kind: 'precedent', query: '허가', issue: '허가 취소가 적법한가',
    embed: async texts => ({ vectors: texts.map(() => null), warning: '임베딩 불가' }),
    classify: undefined, provider: 'none' });
  assert.deepEqual(screened.selected.map(x => x.id), ['1', '2']);
  assert.ok(screened.warnings.includes('임베딩 불가'));
});
