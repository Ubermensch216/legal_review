import test from 'node:test';
import assert from 'node:assert/strict';

test('외부 질의 단계는 진행 중 열리고 완료 후 접힌다', async () => {
  globalThis.localStorage = { getItem: () => null };
  const root = { innerHTML: '', querySelectorAll: () => [] };
  const badge = {};
  globalThis.document = { getElementById: id => id === 'learning-content' ? root
    : id === 'badge-learning-status' ? badge : null };

  const { setLearningHistory } = await import('../public/js/learningTab.js');
  const question = state => ({ no: 1, text: '징수권이 있는가', state });
  const inquiry = coverage => ({ id: 'inq-1', historyId: 'rev-1', state: 'READY', text: '질의서',
    questions: [question('UNANSWERED')], coverage });
  const card = state => ({ id: 'card-1', parentId: 'inq-1', state, answeredQuestions: [1],
    card: { title: '검토 카드', issue: '징수권', conditions: [], exceptions: [], principles: [], checklist: [] } });
  let response;
  globalThis.fetch = async () => ({ ok: true, json: async () => response });
  const show = async meta => {
    setLearningHistory('rev-1', { meta });
    await new Promise(resolve => setImmediate(resolve));
    return root.innerHTML;
  };
  const open = (html, step) => new RegExp(`data-learning-fold="${step}" open`).test(html);

  response = { inquiries: [inquiry({ total: 1, answered: 0, approved: 0, questions: [question('UNANSWERED')] })], knowledge: [] };
  let html = await show({});
  assert.equal(open(html, 'step3'), true);
  assert.equal(open(html, 'step5'), false);

  response = { inquiries: [inquiry({ total: 1, answered: 1, approved: 0, questions: [question('ANSWERED')] })], knowledge: [card('DRAFT')] };
  html = await show({});
  assert.equal(open(html, 'step3'), false);
  assert.equal(open(html, 'step4'), true);
  assert.equal(open(html, 'step5'), false);
  assert.doesNotMatch(html, /질문 연결 저장/);

  response = { inquiries: [inquiry({ total: 1, answered: 1, approved: 1, questions: [question('APPROVED')] })], knowledge: [card('APPROVED')] };
  html = await show({});
  assert.equal(open(html, 'step4'), false);
  assert.equal(open(html, 'step5'), true);

  html = await show({ sourceHistoryId: 'rev-1' });
  assert.equal(open(html, 'step5'), false);
});
