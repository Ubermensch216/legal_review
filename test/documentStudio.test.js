import test from 'node:test';
import assert from 'node:assert/strict';

const elements = new Map();

function element(id) {
  const classes = new Set();
  const listeners = new Map();
  return {
    id,
    value: '',
    innerHTML: '',
    get innerText() { return this.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '); },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    click() { listeners.get('click')?.({ target: this }); }
  };
}

for (const id of [
  'studio-drawer', 'btn-open-studio', 'btn-close-studio', 'report-title-input',
  'studio-visual-editor', 'studio-source-editor', 'btn-mode-visual',
  'btn-mode-source', 'draft-official-report-view'
]) elements.set(id, element(id));

globalThis.localStorage = { getItem: () => null };
globalThis.document = {
  getElementById: id => elements.get(id) || null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};

const { initDocumentStudio, openStudio } = await import('../public/js/documentStudio.js');

test('스튜디오에서 의견서 전문을 열고 모드 왕복 시 내용을 보존한다', () => {
  initDocumentStudio();
  const reportHtml = '<div class="official-report-view"><h2>법률검토의견서</h2><p>검토 배경 전문</p><p>심층 법률 검토의견 전문</p><table><tr><td>관련 조문 근거</td></tr></table></div>';
  elements.get('draft-official-report-view').innerHTML = reportHtml;

  openStudio('짧은 초안 조각', '법률검토의견서', { review: { draftOpinion: '짧은 초안 조각' } });

  const visual = elements.get('studio-visual-editor');
  const source = elements.get('studio-source-editor');
  assert.equal(visual.innerHTML, reportHtml);
  assert.match(source.value, /심층 법률 검토의견 전문/);
  assert.match(source.value, /관련 조문 근거/);

  elements.get('btn-mode-source').click();
  elements.get('btn-mode-visual').click();
  assert.equal(visual.innerHTML, reportHtml);

  elements.get('btn-mode-source').click();
  source.value += '\n추가 검토의견';
  elements.get('btn-mode-visual').click();
  assert.match(visual.innerHTML, /추가 검토의견/);
});
