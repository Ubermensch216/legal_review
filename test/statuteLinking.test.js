import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { applyStatuteLinks, extractTerms, linkStatutes } from '../server/reasoning/stages/statuteLinking.js';

const OFFICIAL = { source: 'OFFICIAL_API' };
const article = (no, title, content) => ({ ...OFFICIAL, lawName: '근로기준법', fullArticleNo: no, title, enforceDate: '20200101', content });
const registry = () => buildEvidenceRegistry({
  meta: { asOfDate: '20260923' },
  officialEvidence: { lawDetail: { ...OFFICIAL, lawName: '근로기준법' }, articles: [
    article('6', '균등한 처우', '사용자는 근로자에 대하여 남녀의 성을 이유로 차별적 대우를 하지 못한다.'),
    article('56', '연장·야간 및 휴일 근로', '사용자는 연장근로에 대하여는 통상임금의 100분의 50 이상을 가산하여 지급하여야 한다.'),
    article('60', '연차 유급휴가', '사용자는 1년간 80퍼센트 이상 출근한 근로자에게 15일의 유급휴가를 주어야 한다.'),
    article('94', '규칙의 작성, 변경 절차', '취업규칙을 근로자에게 불리하게 변경하는 경우에는 근로자의 동의를 받아야 한다.')
  ], precedents: [], interpretations: [] }
});
const issue = (id, question, searchTerms = [], evidenceIds = [], factIds = []) => ({ id, question, searchTerms, evidenceIds, factIds, dependsOn: [] });
const idOf = (reg, no) => reg.list(e => e.kind === 'ARTICLE' && e.articleNo === no)[0].id;

test('조사를 떼고 쟁점을 가리지 못하는 말은 뺀다', () => {
  assert.deepEqual(extractTerms('연장근로수당을 지급하지 않는 것이 적법한가?').slice(0, 2), ['연장근로수당', '지급하지']);
  assert.ok(!extractTerms('근로자는 회사에서 업무 여부를 검토한다').includes('회사'));
});

test('모델이 조문을 고르지 못한 쟁점에 질문·검색어와 닿는 조문을 연결한다', () => {
  const reg = registry();
  const issues = [issue('I1', '연장근로에 대한 가산수당을 지급하지 않아도 되는가?', ['연장근로 가산']),
    issue('I2', '취업규칙을 불리하게 변경할 때 근로자 동의가 필요한가?', ['불이익 변경'])];
  const links = linkStatutes({ issues, facts: [], registry: reg });
  assert.equal(links.get('I1').added[0].id, idOf(reg, '56'));
  assert.equal(links.get('I2').added[0].id, idOf(reg, '94'));
  assert.ok(links.get('I1').added.every(a => a.why));
});

test('문서가 직접 인용한 조문은 점수가 낮아도 후보에 오른다', () => {
  const reg = registry();
  const cited = new Set(['근로기준법|60']);
  const keyOf = e => `${e.lawName}|${e.articleNo}`;
  const links = linkStatutes({ issues: [issue('I1', '휴가 제도가 적법한가?', [])], registry: reg, citedKeys: cited, keyOf });
  assert.ok(links.get('I1').added.some(a => a.id === idOf(reg, '60') && a.cited));
});

test('모델이 이미 충분히 연결했으면 건드리지 않고, 무관한 쟁점은 억지로 연결하지 않는다', () => {
  const reg = registry();
  const linked = issue('I1', '무엇이든', [], [idOf(reg, '56'), idOf(reg, '94')]);
  const unrelated = issue('I2', '주차장 이용료의 부과 기준은 적정한가?', ['주차장']);
  const links = linkStatutes({ issues: [linked, unrelated], registry: reg });
  assert.deepEqual(links.get('I1').added, []);
  assert.deepEqual(links.get('I2').added, []);
  const summary = applyStatuteLinks([linked, unrelated], links);
  assert.deepEqual(summary.unlinkedIssues, ['I2']);
  assert.match(unrelated.linkNote, /찾지 못했습니다/);
  assert.deepEqual(linked.evidenceIds.length, 2);
});

test('연결은 기존 조문 ID 뒤에 중복 없이 더한다', () => {
  const reg = registry();
  const one = issue('I1', '연장근로 가산수당 지급 여부', ['연장근로'], [idOf(reg, '94')]);
  applyStatuteLinks([one], linkStatutes({ issues: [one], registry: reg }));
  assert.equal(one.evidenceIds[0], idOf(reg, '94'));
  assert.ok(one.evidenceIds.includes(idOf(reg, '56')));
  assert.equal(new Set(one.evidenceIds).size, one.evidenceIds.length);
});
