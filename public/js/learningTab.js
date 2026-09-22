// public/js/learningTab.js - 탭 5: 외부 전문가 질의
// 비식별 질의서 생성 → 사용자 검토·반출 → 외부 AI 답변 반입 → 지식 카드 승인.
// 외부 AI API는 호출하지 않는다. 반출과 반입은 모두 사람이 한다.
import { state } from './state.js';

const API = '/api/law/learning';

const view = {
  historyId: null,   // 현재 검토 이력. 이 이력에 속한 질의서만 다룬다.
  inquiry: null,
  knowledge: [],
  coverage: null,
  notice: '',        // 성공/안내 메시지
  exportText: '',    // 클립보드가 막혔을 때 직접 복사할 질의서 본문
  error: '',
  busy: '',          // 진행 중인 동작 이름. 버튼 중복 클릭을 막는다.
  drafts: {}         // 실패·진행 표시 때문에 다시 그려도 사용자가 붙여넣은 답변을 잃지 않는다.
};

const draftKey = node => node.id || (node.name ? `${node.name}:${node.value}` : '');
function captureDrafts() {
  for (const node of document.querySelectorAll('#learning-content input, #learning-content textarea')) {
    const key = draftKey(node);
    if (key && !node.readOnly) view.drafts[key] = node.type === 'checkbox' ? node.checked : node.value;
  }
}
function forgetDrafts(...prefixes) {
  for (const key of Object.keys(view.drafts)) if (prefixes.some(p => key.startsWith(p))) delete view.drafts[key];
}

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined, ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `요청에 실패했습니다 (HTTP ${res.status}).`);
  return data;
}

/** 서버 상태를 다시 읽는다. 이 이력의 질의서는 하나만 다룬다. */
async function refresh() {
  if (!view.historyId) return;
  const historyId = view.historyId;
  const data = await call('/');
  if (historyId !== view.historyId) return;
  view.inquiry = (data.inquiries || []).find(item => item.historyId === historyId) || null;
  view.coverage = view.inquiry?.coverage || null;
  view.knowledge = (data.knowledge || []).filter(item => item.parentId === view.inquiry?.id);
}

/**
 * 버튼 동작 공통 처리. 오류 메시지는 서버가 준 문장을 그대로 보여준다.
 * 진행 표시를 위해 곧바로 다시 그리므로, 화면 입력값은 반드시 run()을 부르기 전에 읽어야 한다.
 */
async function run(name, fn) {
  if (view.busy) return;
  captureDrafts();
  view.busy = name; view.error = ''; view.notice = '';
  render();
  try {
    await fn();
    await refresh();
  } catch (err) {
    view.error = err.message;
  } finally {
    view.busy = '';
    render();
  }
}

// ── 외부에서 쓰는 진입점 ────────────────────────────────────────

export function initLearningTab() {
  const root = document.getElementById('learning-content');
  if (!root) return;
  root.addEventListener('click', onClick);
  root.addEventListener('input', event => {
    if (event.target.id === 'learning-text' || event.target.id === 'learning-custom-terms' || event.target.name === 'learning-term') {
      for (const id of ['learning-check-privacy', 'learning-check-logic']) {
        if (el(id)) el(id).checked = false;
        delete view.drafts[id];
      }
    }
  });
  render();
}

/** 검토가 끝나면 그 이력을 이 탭에 연결한다. */
export function setLearningHistory(historyId) {
  view.historyId = historyId || null;
  view.inquiry = null; view.knowledge = []; view.coverage = null;
  view.error = ''; view.notice = '';
  view.exportText = ''; view.drafts = {};
  if (!view.historyId) return render();
  refresh().catch(err => { view.error = err.message; }).finally(render);
}

export function resetLearningTab() { setLearningHistory(null); }

// ── 동작 ────────────────────────────────────────────────────────

const el = id => document.getElementById(id);
const checkedValues = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);

/** 화면에서 고른 비식별 단어. 제안 목록과 직접 입력을 합친다. */
function selectedTerms() {
  const manual = (el('learning-custom-terms')?.value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  return [...new Set([...checkedValues('learning-term'), ...manual])];
}

const actions = {
  create: () => {
    const focus = el('learning-focus')?.value.trim() || '';
    return run('create', async () => {
      const data = await call('/inquiries', { method: 'POST', body: JSON.stringify({ historyId: view.historyId, focus }) });
      if (!data.needsHelp) view.notice = data.message;
    });
  },

  save: () => {
    const { id, revision } = view.inquiry;
    const body = JSON.stringify({ revision, text: el('learning-text').value, privateTerms: selectedTerms() });
    return run('save', async () => {
      await call(`/inquiries/${id}`, { method: 'PATCH', body });
      forgetDrafts('learning-text', 'learning-custom-terms', 'learning-term:', 'learning-check-');
      view.notice = '비식별 처리를 적용했습니다. 본문을 다시 확인하십시오.';
    });
  },

  confirm: () => {
    if (el('learning-text').value !== view.inquiry.text || selectedTerms().length) {
      captureDrafts();
      view.error = '수정한 본문과 선택한 비식별 단어를 먼저 저장한 뒤, 저장된 질의서를 확인하십시오.';
      render();
      return;
    }
    const { id, revision } = view.inquiry;
    const body = JSON.stringify({ revision, privacyConfirmed: el('learning-check-privacy').checked,
      logicConfirmed: el('learning-check-logic').checked });
    return run('confirm', async () => {
      await call(`/inquiries/${id}/confirm`, { method: 'POST', body });
      view.drafts = {};
      view.notice = '반출 준비가 확인되었습니다. 질의서를 복사해 외부 AI에 질의하십시오.';
    });
  },

  // 복사는 반드시 서버 export를 거친다. 이 경로가 복사 직전에 식별정보를 다시 검사한다.
  copy: () => run('copy', async () => {
    const res = await fetch(`${API}/inquiries/${view.inquiry.id}/export`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '질의서를 내보내지 못했습니다.');
    const text = await res.text();
    try {
      await navigator.clipboard.writeText(text);
      view.exportText = '';
      view.notice = '질의서를 클립보드에 복사했습니다.';
    } catch {
      // 클립보드 권한이 없거나 창이 비활성일 수 있다. 사용자가 직접 복사할 수 있게 내놓는다.
      view.exportText = text;
      view.notice = '자동 복사가 차단되었습니다. 아래 내용을 직접 선택해 복사하십시오.';
    }
  }),

  import: () => {
    const answer = el('learning-answer').value.trim();
    const providerLabel = el('learning-provider').value.trim() || undefined;
    // 구조화 반입은 사용자가 직접 고른다. 붙여넣은 내용에 JSON이 보인다고 자동으로 전환하면
    // 외부 답변의 내용이 시스템 동작을 바꾸는 셈이 된다.
    const mode = el('learning-mode-structured')?.checked ? 'structured' : undefined;
    const id = view.inquiry.id;
    return run('import', async () => {
      if (!answer) throw new Error('외부 AI에서 받은 답변을 붙여넣으십시오.');
      await call(`/inquiries/${id}/answers`, { method: 'POST', body: JSON.stringify({ answer, providerLabel, mode }) });
      forgetDrafts('learning-answer');
      view.notice = mode
        ? '붙여넣은 구조화 카드를 그대로 받았습니다. 내용과 인용을 확인한 뒤 승인하십시오.'
        : '답변을 지식 카드로 정리했습니다. 내용과 인용을 확인한 뒤 승인하십시오.';
    });
  },

  link: id => {
    const item = view.knowledge.find(k => k.id === id);
    const body = JSON.stringify({ revision: item.revision, card: item.card,
      answeredQuestions: checkedValues(`learning-q-${id}`).map(Number) });
    return run('link', async () => {
      await call(`/knowledge/${id}`, { method: 'PATCH', body });
      forgetDrafts(`learning-q-${id}`, `learning-ok-know-${id}`, `learning-ok-priv-${id}`);
      view.notice = '답변이 다룬 질문을 수정했습니다.';
    });
  },

  maskCard: id => {
    const item = view.knowledge.find(k => k.id === id);
    const body = JSON.stringify({ revision: item.revision, card: item.card,
      privateTerms: checkedValues(`learning-cardterm-${id}`) });
    return run('maskCard', async () => {
      await call(`/knowledge/${id}`, { method: 'PATCH', body });
      forgetDrafts(`learning-card-${id}`, `learning-cardterm-${id}`, `learning-ok-know-${id}`, `learning-ok-priv-${id}`);
      view.notice = '선택한 단어를 카드에서 가렸습니다. 인용 검증 결과를 다시 확인하십시오.';
    });
  },

  editCard: id => {
    const item = view.knowledge.find(k => k.id === id);
    const raw = el(`learning-card-${id}`).value;
    return run('editCard', async () => {
      let card;
      try { card = JSON.parse(raw); }
      catch { throw new Error('카드 JSON 형식이 올바르지 않습니다.'); }
      await call(`/knowledge/${id}`, { method: 'PATCH', body: JSON.stringify({ revision: item.revision, card }) });
      forgetDrafts(`learning-card-${id}`, `learning-ok-know-${id}`, `learning-ok-priv-${id}`);
      view.notice = '지식 카드를 수정했습니다.';
    });
  },

  approve: id => {
    const item = view.knowledge.find(k => k.id === id);
    const textarea = el(`learning-card-${id}`);
    const selected = checkedValues(`learning-q-${id}`).map(Number);
    if ((textarea && textarea.value !== JSON.stringify(item.card, null, 2))
      || JSON.stringify(selected) !== JSON.stringify(item.answeredQuestions || [])
      || checkedValues(`learning-cardterm-${id}`).length) {
      captureDrafts(); view.error = '카드 내용·질문 연결·비식별 변경을 먼저 저장한 뒤 승인하십시오.'; render(); return;
    }
    const body = JSON.stringify({ revision: item.revision,
      knowledgeConfirmed: el(`learning-ok-know-${id}`).checked, privacyConfirmed: el(`learning-ok-priv-${id}`).checked });
    return run('approve', async () => {
      await call(`/knowledge/${id}/approve`, { method: 'POST', body });
      view.notice = '지식을 승인했습니다. 이후 같은 근거 범위의 검토에서 참고 자료로 쓰입니다.';
    });
  },

  revoke: id => {
    const item = view.knowledge.find(k => k.id === id);
    if (!confirm('이 지식을 사용 중지하시겠습니까? 이후 검토에서 참고되지 않습니다.')) return;
    return run('revoke', () => call(`/knowledge/${id}/revoke`, { method: 'POST', body: JSON.stringify({ revision: item.revision }) }));
  },

  // 최종 검토는 별도 경로를 만들지 않고 기존 검토 실행을 그대로 쓴다.
  // 공식 근거를 다시 수집해야 하고, 그 결과가 승인 지식의 적용 범위와 맞는지도 다시 따져야 한다.
  rerun: () => {
    const meta = state.lastReviewResult?.meta || {};
    const c = view.coverage || { total: 0, approved: 0 };
    const unmet = (c.questions || []).filter(q => q.state !== 'APPROVED');
    if (unmet.length && !confirm(`아직 승인된 지식으로 충족되지 않은 질문이 ${unmet.length}건 있습니다.\n`
      + '그대로 최종 검토를 실행하면 미충족 쟁점이 검토서의 제한사항으로 남습니다. 계속하시겠습니까?')) return;
    if (meta.hasAttachedDocument && !state.selectedFile
      && !confirm('원 검토에는 첨부문서가 있었습니다. 문서 원문은 보관하지 않으므로 다시 첨부해야 같은 조건으로 검토됩니다.\n'
        + '첨부 없이 계속하시겠습니까?')) return;

    const form = document.getElementById('form-review');
    const set = (id, value) => { const node = document.getElementById(id); if (node) node.value = value || ''; };
    set('input-query', meta.query);
    set('input-target-law', meta.primaryLawName);
    set('input-target-date', meta.targetDate ? `${meta.targetDate.slice(0, 4)}-${meta.targetDate.slice(4, 6)}-${meta.targetDate.slice(6, 8)}` : '');
    state.currentPreset = meta.preset || state.currentPreset;
    state.sourceHistoryId = view.historyId;
    // This workflow always returns to the local model, irrespective of saved cloud settings.
    state.manualLearningRerun = true;
    form.scrollIntoView({ behavior: 'smooth' });
    form.requestSubmit();
  },

  discard: () => {
    if (!confirm('질의서와 이 질의서에서 만든 지식을 모두 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
    const id = view.inquiry.id;
    return run('discard', async () => {
      await call(`/${id}`, { method: 'DELETE' });
      view.drafts = {}; view.exportText = '';
      view.notice = '질의서를 삭제했습니다.';
    });
  }
};

function onClick(event) {
  if (view.busy) return;
  const target = event.target.closest('[data-learning-action]');
  if (!target) return;
  const action = actions[target.dataset.learningAction];
  if (action) action(target.dataset.id);
}

// ── 렌더 ────────────────────────────────────────────────────────

/**
 * 제안을 적용해도 본문에 남는 짧은 표현을 찾아준다.
 * 예: 제안이 "사하구청 재무과"인데 본문 다른 곳에 "사하구청"만 있는 경우.
 * 기관명은 패턴 탐지로 걸러지지 않으므로 사람이 직접 골라야 한다.
 */
function residualTerms(proposals, text) {
  const found = new Set();
  for (const term of proposals) {
    if (looksLegalReference(term)) continue;
    for (const word of term.split(/[\s·,()（）]+/)) {
      if (word.length >= 2 && word !== term && !looksLegalReference(word) && text.includes(word)) found.add(word);
    }
  }
  return [...found];
}

/**
 * 법령명·조문 표기는 가리면 안 된다. 외부 AI가 근거를 특정할 수 없게 되어 질의 자체가 무의미해진다.
 * 로컬 모델이 이런 표기를 민감어로 지목하는 일이 실제로 있어, 고르기 전에 구분해 보여준다.
 */
function looksLegalReference(term) {
  // 한글에는 \b(단어 경계)가 적용되지 않는다. 접미사는 그대로 끝소리로 검사한다.
  return /제\s*\d+\s*조|법률 제/.test(term)
    || /(법|법률|시행령|시행규칙|조례|규칙|고시|훈령|예규|지침)$/.test(term);
}

const chip = (label, value) => `<span class="learning-chip">${esc(label)} <strong>${esc(value)}</strong></span>`;
const box = (id, label) => `<label class="learning-check"><input type="checkbox" id="${id}"><span>${esc(label)}</span></label>`;

const STATE_LABEL = { UNANSWERED: '미답변', ANSWERED: '답변됨', APPROVED: '승인됨' };
const CITATION_LABEL = { VERIFIED_EXISTENCE: '공식 조문에서 확인', OUT_OF_FORCE: '수집했으나 검토 기준일에 시행 중이 아님', UNVERIFIED: '확인 불가' };
const DISTILLATION_LABEL = { LOCAL_SINGLE: '로컬 AI 정리', LOCAL_CHUNKED: '로컬 AI 조각 정리',
  USER_STRUCTURED_JSON: '외부 AI 구조화 출력 그대로' };

function renderQuestions() {
  const questions = view.coverage?.questions || [];
  if (!questions.length) return '<p class="learning-empty">질문 목록을 인식하지 못했습니다.</p>';
  return `<ul class="learning-questions">${questions.map(q => `
    <li class="learning-q ${q.state.toLowerCase()}">
      <span class="learning-q-no">${q.no}</span>
      <span class="learning-q-text">${esc(q.text)}</span>
      <span class="learning-q-state">${STATE_LABEL[q.state]}</span>
    </li>`).join('')}</ul>`;
}

function renderStep1() {
  return `
    <div class="panel learning-step">
      <div class="panel-header"><div class="panel-title-group">
        <span class="material-symbols-outlined icon-sm">help</span><h3>1. 미해결 쟁점 확인</h3>
      </div></div>
      <div class="panel-body">
        <p class="learning-desc">로컬 AI가 이번 검토에서 스스로 판단을 뒷받침하지 못한 쟁점을 찾아
          비식별 질의서를 만듭니다. 외부 AI를 자동으로 호출하지 않습니다.</p>
        <label class="learning-label" for="learning-focus">추가로 묻고 싶은 쟁점 (선택)</label>
        <textarea id="learning-focus" class="learning-input" rows="3"
          placeholder="예: 조례 근거 없이 수탁자가 사용료를 징수할 수 있는지"></textarea>
        <button class="btn btn-primary" data-learning-action="create" ${view.busy ? 'disabled' : ''}>
          <span class="material-symbols-outlined icon-sm">auto_awesome</span>
          <span>${view.busy === 'create' ? '로컬 AI가 쟁점을 분석 중입니다...' : '질의서 생성'}</span>
        </button>
      </div>
    </div>`;
}

function renderStep2() {
  const item = view.inquiry;
  const counts = Object.entries(item.redactions || {});
  const proposals = item.proposedTerms || [];
  const residual = residualTerms(proposals, item.text);
  const termBox = (value, hint) => `<label class="learning-term">
    <input type="checkbox" name="learning-term" value="${esc(value)}">
    <span>${esc(value)}</span>${hint ? `<em>${esc(hint)}</em>` : ''}</label>`;

  return `
    <div class="panel learning-step">
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="material-symbols-outlined icon-sm">shield</span><h3>2. 외부 반출 전 검토</h3>
        </div>
        <button class="btn btn-sm btn-outline" data-learning-action="discard">질의서 삭제</button>
      </div>
      <div class="panel-body">
        <div class="learning-chips">
          ${counts.length ? counts.map(([kind, n]) => chip(kind, `${n}건`)).join('') : '<span class="learning-chip">자동 치환 없음</span>'}
        </div>

        ${proposals.length || residual.length ? `
        <div class="learning-proposals">
          <p class="learning-desc"><strong>로컬 AI가 가릴 것을 제안한 단어입니다. 아직 적용되지 않았습니다.</strong>
            법률 판단에 필요한 용어까지 가리면 외부 AI가 답할 수 없으므로, 실제로 가려야 할 것만 고르십시오.</p>
          ${proposals.map(t => termBox(t, looksLegalReference(t) ? '법령·조문 표기 — 가리면 근거를 특정할 수 없습니다' : '')).join('')}
          ${residual.length ? `<p class="learning-desc learning-warn">본문에 아래 짧은 표현도 남아 있습니다.
            기관·업체 이름은 자동 탐지로 걸러지지 않으므로 직접 확인하십시오.</p>
            ${residual.map(t => termBox(t, '본문에 남음')).join('')}` : ''}
        </div>` : ''}

        <label class="learning-label" for="learning-custom-terms">추가로 가릴 단어 (쉼표 또는 줄바꿈으로 구분)</label>
        <input id="learning-custom-terms" class="learning-input" type="text" placeholder="예: 사하구청, 대한스포츠">

        <label class="learning-label" for="learning-text">질의서 본문 (편집 가능)</label>
        <textarea id="learning-text" class="learning-input learning-textarea" rows="18">${esc(item.text)}</textarea>

        <div class="learning-actions">
          <button class="btn btn-secondary" data-learning-action="save" ${view.busy ? 'disabled' : ''}>
            선택한 단어 적용 · 본문 저장</button>
        </div>

        <div class="learning-confirm">
          ${box('learning-check-privacy', '개인정보·민감정보·기관 비밀정보가 제거되었음을 확인했습니다.')}
          ${box('learning-check-logic', '판단에 필요한 사실과 조건이 보존되었음을 확인했습니다.')}
          <button class="btn btn-primary" data-learning-action="confirm" ${view.busy ? 'disabled' : ''}>
            <span class="material-symbols-outlined icon-sm">lock_open</span><span>반출 준비 확인</span></button>
        </div>
      </div>
    </div>`;
}

function renderStep3() {
  const c = view.coverage || { total: 0, answered: 0, approved: 0 };
  return `
    <div class="panel learning-step">
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="material-symbols-outlined icon-sm">forum</span><h3>3. 답변 접수</h3>
        </div>
        <span class="learning-count">승인 ${c.approved} / 답변 ${c.answered} / 전체 ${c.total}</span>
      </div>
      <div class="panel-body">
        ${renderQuestions()}
        <div class="learning-actions">
          <button class="btn btn-primary" data-learning-action="copy" ${view.busy ? 'disabled' : ''}>
            <span class="material-symbols-outlined icon-sm">content_copy</span><span>질의서 복사</span></button>
          <button class="btn btn-sm btn-outline" data-learning-action="discard">질의서 삭제</button>
        </div>
        ${view.exportText ? `<textarea class="learning-input learning-textarea" rows="12" readonly
          onclick="this.select()">${esc(view.exportText)}</textarea>` : ''}
        <p class="learning-desc">복사한 질의서를 원하는 외부 AI(ChatGPT·Claude·Gemini 등)에 붙여넣고,
          받은 답변을 아래에 그대로 붙여넣으십시오. 답변 하나가 여러 질문을 함께 답할 수 있습니다.</p>
        <label class="learning-label" for="learning-provider">답변 출처 (선택 · 표시용)</label>
        <input id="learning-provider" class="learning-input" type="text" maxlength="40" placeholder="예: ChatGPT">
        <label class="learning-label" for="learning-answer">외부 AI 답변 붙여넣기</label>
        <textarea id="learning-answer" class="learning-input learning-textarea" rows="10"
          placeholder="외부 AI가 준 답변 전체를 붙여넣으십시오."></textarea>
        <label class="learning-check">
          <input type="checkbox" id="learning-mode-structured">
          <span>질의서가 요청한 <strong>JSON 부분만</strong> 붙여넣었습니다 (로컬 AI 정리 없이 그대로 사용)</span>
        </label>
        <button class="btn btn-primary" data-learning-action="import" ${view.busy ? 'disabled' : ''}>
          <span class="material-symbols-outlined icon-sm">download</span>
          <span>${view.busy === 'import' ? '로컬 AI가 지식으로 정리 중입니다...' : '답변 반입'}</span>
        </button>
        <p class="learning-desc">답변이 길면 로컬 AI가 조각으로 나눠 읽습니다. 시간이 더 걸리고,
          일부 조각이 실패하면 그 카드는 미완으로 표시되어 승인할 수 없습니다.</p>
      </div>
    </div>`;
}

function renderCard(item) {
  const questions = view.coverage?.questions || [];
  const answered = item.answeredQuestions || [];
  const editable = item.state === 'DRAFT';
  const checks = item.citationChecks || [];
  const verified = checks.filter(c => c.status === 'VERIFIED_EXISTENCE').length;
  const incomplete = item.chunkCoverage && item.chunkCoverage.processed < item.chunkCoverage.total;
  const cases = item.caseChecks || [];
  const list = (label, values) => values?.length
    ? `<div class="learning-field"><span>${label}</span><ul>${values.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : '';

  return `
    <div class="learning-card ${item.state.toLowerCase()}">
      <div class="learning-card-head">
        <h4>${esc(item.card.title)}</h4>
        <span class="learning-badge ${item.state.toLowerCase()}">${item.state === 'APPROVED' ? '승인됨'
          : item.state === 'REVOKED' ? '사용 중지' : '검토 대기'}</span>
      </div>
      <p class="learning-card-meta">
        ${esc(item.sourceLabel)}${item.providerLabel ? ` · ${esc(item.providerLabel)}` : ''} ·
        인용 검증 ${verified}/${checks.length} · ${esc(DISTILLATION_LABEL[item.distillation] || '로컬 AI 정리')} · 법적 효력 미인증
      </p>
      ${incomplete ? `<div class="learning-message error">답변 ${item.chunkCoverage.total}조각 중
        ${item.chunkCoverage.processed}조각만 정리되었습니다. 내용이 일부만 반영된 지식이므로 승인할 수 없습니다.
        답변을 쟁점별로 나누어 다시 반입하십시오.</div>` : ''}
      <div class="learning-field"><span>쟁점</span><p>${esc(item.card.issue)}</p></div>
      ${list('적용 조건', item.card.conditions)}
      ${list('예외', item.card.exceptions)}
      ${list('검토 원리', item.card.principles)}
      ${list('점검 순서', item.card.checklist)}
      ${checks.length ? `<div class="learning-field"><span>인용</span><ul>${checks.map(c =>
        `<li class="${c.status === 'VERIFIED_EXISTENCE' ? 'ok' : 'warn'}">${esc(c.lawName)} ${esc(c.articleNo)}
          — ${esc(CITATION_LABEL[c.status] || '확인 불가')}</li>`).join('')}</ul></div>` : ''}

      ${cases.length ? `<div class="learning-field"><span>본문에 적힌 판례·해석례 번호</span><ul>${cases.map(c =>
        `<li class="${c.status === 'VERIFIED_EXISTENCE' ? 'ok' : 'warn'}">${esc(c.caseNo)}
          — ${c.status === 'VERIFIED_EXISTENCE' ? '이번 검토에서 확보한 자료에 있음' : '확보한 자료에서 확인 불가 — 이 지식은 재사용되지 않습니다'}
        </li>`).join('')}</ul></div>` : ''}

      ${questions.length ? `<div class="learning-field"><span>이 답변이 다룬 질문</span>
        <div class="learning-links">${questions.map(q => `<label class="learning-term">
          <input type="checkbox" name="learning-q-${item.id}" value="${q.no}"
            ${answered.includes(q.no) ? 'checked' : ''} ${editable ? '' : 'disabled'}>
          <span>${q.no}. ${esc(q.text.slice(0, 40))}${q.text.length > 40 ? '…' : ''}</span></label>`).join('')}</div>
        ${editable ? `<button class="btn btn-sm btn-secondary" data-learning-action="link" data-id="${item.id}">
          질문 연결 저장</button>` : ''}
        </div>` : ''}

      ${editable && (item.proposedTerms || []).length ? `
      <div class="learning-proposals">
        <p class="learning-desc"><strong>로컬 AI가 가릴 것을 제안한 단어입니다. 아직 적용되지 않았습니다.</strong>
          법령명을 가리면 인용 검증이 '확인 불가'가 되어 이 지식은 재사용되지 않습니다.</p>
        ${item.proposedTerms.map(t => `<label class="learning-term">
          <input type="checkbox" name="learning-cardterm-${item.id}" value="${esc(t)}">
          <span>${esc(t)}</span>${looksLegalReference(t)
            ? `<em>법령·조문 표기 — 가리면 인용을 검증할 수 없습니다</em>` : ''}</label>`).join('')}
        <button class="btn btn-sm btn-secondary" data-learning-action="maskCard" data-id="${item.id}">선택한 단어 적용</button>
      </div>` : ''}

      ${editable ? `
      <details class="learning-advanced">
        <summary>카드 내용 직접 수정 (JSON)</summary>
        <textarea id="learning-card-${item.id}" class="learning-input learning-textarea" rows="10">${esc(JSON.stringify(item.card, null, 2))}</textarea>
        <button class="btn btn-sm btn-secondary" data-learning-action="editCard" data-id="${item.id}">카드 저장</button>
      </details>
      <div class="learning-confirm">
        ${box(`learning-ok-know-${item.id}`, '적용 조건과 예외를 확인했습니다.')}
        ${box(`learning-ok-priv-${item.id}`, '개인정보·비밀정보가 없음을 확인했습니다.')}
        <button class="btn btn-primary" data-learning-action="approve" data-id="${item.id}"
          ${incomplete ? 'disabled title="일부 조각만 정리된 지식은 승인할 수 없습니다."' : ''}>지식 승인</button>
        <button class="btn btn-sm btn-outline" data-learning-action="revoke" data-id="${item.id}">폐기</button>
      </div>` : item.state === 'APPROVED'
        ? `<div class="learning-actions"><button class="btn btn-sm btn-outline"
             data-learning-action="revoke" data-id="${item.id}">사용 중지</button></div>` : ''}
    </div>`;
}

function renderStep5() {
  const c = view.coverage || { total: 0, approved: 0, questions: [] };
  if (!c.total) return '';
  const unmet = (c.questions || []).filter(q => q.state !== 'APPROVED');
  const used = state.lastReviewResult?.review?.learningReferences || [];
  const dropped = state.lastReviewResult?.review?.learningExcluded || [];

  return `
    <div class="panel learning-step">
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="material-symbols-outlined icon-sm">task_alt</span><h3>5. 최종 답변서</h3>
        </div>
        <span class="learning-count">충족 ${c.approved} / ${c.total}</span>
      </div>
      <div class="panel-body">
        <p class="learning-desc">승인한 지식을 참고 자료로 실어 이 사건의 검토를 다시 실행합니다.
          공식 법령·판례는 그때 다시 수집하며, 승인된 지식이 공식 근거를 대신하지 않습니다.</p>
        ${unmet.length ? `<p class="learning-desc learning-warn">아직 충족되지 않은 질문 ${unmet.length}건:
          ${unmet.map(q => `#${q.no}`).join(', ')} — 그대로 실행하면 검토서의 제한사항으로 남습니다.</p>` : ''}
        ${used.length ? `<p class="learning-desc">직전 검토에 실린 지식 ${used.length}건:
          ${used.map(r => esc(r.title)).join(' · ')}</p>` : ''}
        ${dropped.length ? `<div class="learning-message warn">직전 검토에서 적용하지 않은 지식 ${dropped.length}건
          <ul class="learning-dropped">${dropped.map(d =>
            `<li>${esc(d.title || '(제목 없음)')} — ${esc(d.message)}</li>`).join('')}</ul></div>` : ''}
        <button class="btn btn-primary" data-learning-action="rerun" ${view.busy ? 'disabled' : ''}>
          <span class="material-symbols-outlined icon-sm">restart_alt</span>
          <span>승인된 지식으로 최종 검토 다시 실행</span></button>
      </div>
    </div>`;
}

function renderStep4() {
  if (!view.knowledge.length) return '';
  const unassigned = view.coverage?.unassigned || [];
  return `
    <div class="panel learning-step">
      <div class="panel-header"><div class="panel-title-group">
        <span class="material-symbols-outlined icon-sm">library_books</span><h3>4. 지식 카드 검토</h3>
      </div></div>
      <div class="panel-body">
        <p class="learning-desc">외부 AI 답변은 검증 대상 후보 지식입니다. 공식 근거를 대신하지 않습니다.
          적용 조건과 예외를 확인하고 승인해야 이후 검토에 참고 자료로 쓰입니다.</p>
        ${unassigned.length ? `<p class="learning-desc learning-warn">
          어느 질문과도 연결되지 않은 카드가 ${unassigned.length}건 있습니다.
          로컬 AI가 연결을 놓쳤을 수 있으니 아래에서 직접 지정하십시오.</p>` : ''}
        ${view.knowledge.map(renderCard).join('')}
      </div>
    </div>`;
}

function updateBadge() {
  const badge = document.getElementById('badge-learning-status');
  if (!badge) return;
  const c = view.coverage;
  if (!view.inquiry) { badge.className = 'tab-badge off'; badge.textContent = '대기'; return; }
  if (!c?.total) { badge.className = 'tab-badge active'; badge.textContent = '작성 중'; return; }
  badge.className = c.approved >= c.total ? 'tab-badge active' : 'tab-badge warning';
  badge.textContent = `답변 ${c.approved}/${c.total}`;
}

function render() {
  const root = document.getElementById('learning-content');
  if (!root) return;

  const messages = `
    ${view.error ? `<div class="learning-message error">${esc(view.error)}</div>` : ''}
    ${view.notice ? `<div class="learning-message notice">${esc(view.notice)}</div>` : ''}`;

  if (!view.historyId) {
    root.innerHTML = `<div class="learning-guard">
      <span class="material-symbols-outlined">info</span>
      <p>먼저 법령검토를 실행하십시오. 검토 결과가 있어야 로컬 AI가 미해결 쟁점을 찾을 수 있습니다.</p></div>`;
    return updateBadge();
  }

  // 승인된 지식은 로컬(Ollama) 검토 경로에서만 주입된다. 질의서 작성 자체는 제한되지 않는다.
  const providerNote = state.settings.provider !== 'ollama' ? `<div class="learning-message warn">
    일반 검토 모델 설정은 <strong>${esc(state.settings.provider)}</strong>입니다. 이 탭의 질의서 작성·답변 정리·최종 재검토는
    로컬 Ollama로 수행합니다. 외부 AI에는 사용자가 직접 전달합니다.</div>` : '';

  const body = !view.inquiry ? renderStep1()
    : view.inquiry.state === 'DRAFT' ? renderStep2()
    : `${renderStep3()}${renderStep4()}${renderStep5()}`;

  root.innerHTML = `${providerNote}${messages}${body}`;
  for (const node of root.querySelectorAll('input, textarea')) {
    const key = draftKey(node);
    if (Object.hasOwn(view.drafts, key)) {
      if (node.type === 'checkbox') node.checked = view.drafts[key];
      else node.value = view.drafts[key];
    }
  }
  if (view.busy) for (const node of root.querySelectorAll('button, input, textarea')) node.disabled = true;
  updateBadge();
}

export default { initLearningTab, setLearningHistory, resetLearningTab };
