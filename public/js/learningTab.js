// public/js/learningTab.js - 탭 5: 외부 전문가 질의
// 비식별 질의서 생성 → 사용자 검토·반출 → 외부 AI 답변 반입 → 지식 카드 승인.
// 외부 AI API는 호출하지 않는다. 반출과 반입은 모두 사람이 한다.
import { state } from './state.js';
import { collectLearningIssues } from './learningIssues.js';

const API = '/api/law/learning';

const view = {
  historyId: null,   // 현재 검토 이력. 이 이력에 속한 질의서만 다룬다.
  inquiry: null,
  knowledge: [],
  coverage: null,
  reviewIssues: [],
  notice: '',        // 성공/안내 메시지
  exportText: '',    // 클립보드가 막혔을 때 직접 복사할 질의서 본문
  error: '',
  busy: '',          // 진행 중인 동작 이름. 버튼 중복 클릭을 막는다.
  drafts: {},        // 실패·진행 표시 때문에 다시 그려도 사용자가 붙여넣은 답변을 잃지 않는다.
  folds: {},         // 사용자가 직접 바꾼 접힘 상태
  finalized: false   // 이 질의에 승인 지식을 반영한 최종 검토가 끝났는지
};

const draftKey = node => node.id || (node.name ? `${node.name}:${node.value}` : '');
// 체크박스·라디오는 값이 아니라 선택 여부를 보존해야 다시 그린 뒤에도 사용자의 선택이 남는다.
const isToggle = node => node.type === 'checkbox' || node.type === 'radio';
function captureDrafts() {
  for (const node of document.querySelectorAll('#learning-content input, #learning-content textarea')) {
    const key = draftKey(node);
    if (key && !node.readOnly) view.drafts[key] = isToggle(node) ? node.checked : node.value;
  }
}
function forgetDrafts(...prefixes) {
  for (const key of Object.keys(view.drafts)) if (prefixes.some(p => key.startsWith(p))) delete view.drafts[key];
}

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 검토 완료 직후에는 개발 서버가 재시작되거나 포트가 잠깐 재바인딩될 수 있다.
 * 이때 브라우저 fetch는 HTTP 응답 없이 TypeError('Failed to fetch')만 던지므로,
 * 짧게 재시도해 정상적인 학습 API 응답을 받을 기회를 준다.
 */
async function request(path, options = {}) {
  const init = {
    cache: 'no-store',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(`${API}${path}`, init);
    } catch (err) {
      if (attempt === 2) break;
      await wait(250 * (attempt + 1));
    }
  }
  throw new Error('학습 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인한 뒤 다시 시도하십시오.');
}
function captureFolds() {
  for (const node of document.querySelectorAll('#learning-content details[data-learning-fold]')) {
    view.folds[node.dataset.learningFold] = node.open;
  }
}

async function call(path, options = {}) {
  const res = await request(path, options);
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
  captureFolds();
  const previousFolds = defaultFolds();
  view.busy = name; view.error = ''; view.notice = '';
  render();
  try {
    await fn();
    await refresh();
    if (['import', 'switchSource', 'maskCard', 'editCard', 'approve', 'revoke', 'discard'].includes(name)) {
      view.finalized = false;
    }
    const nextFolds = defaultFolds();
    for (const id of Object.keys(nextFolds)) {
      if (previousFolds[id] !== nextFolds[id]) delete view.folds[id];
    }
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
export function setLearningHistory(historyId, reviewData = {}) {
  view.historyId = historyId || null;
  view.inquiry = null; view.knowledge = []; view.coverage = null;
  view.reviewIssues = view.historyId ? collectLearningIssues(reviewData) : [];
  view.error = ''; view.notice = '';
  view.exportText = ''; view.drafts = {}; view.folds = {};
  view.finalized = Boolean(view.historyId && reviewData.meta?.sourceHistoryId === view.historyId);
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
    const res = await request(`/inquiries/${view.inquiry.id}/export`);
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
    const sourceType = el('learning-source-human')?.checked ? 'HUMAN_EXPERT' : 'EXTERNAL_AI';
    // 구조화 반입은 사용자가 직접 고른다. 붙여넣은 내용에 JSON이 보인다고 자동으로 전환하면
    // 외부 답변의 내용이 시스템 동작을 바꾸는 셈이 된다.
    const mode = el('learning-mode-structured')?.checked ? 'structured' : undefined;
    const id = view.inquiry.id;
    return run('import', async () => {
      if (!answer) throw new Error('외부 AI 또는 외부 전문가에게서 받은 답변을 붙여넣으십시오.');
      const data = await call(`/inquiries/${id}/answers`, { method: 'POST', body: JSON.stringify({ answer, providerLabel, mode, sourceType }) });
      forgetDrafts('learning-answer', 'learning-source-');
      view.notice = !data.item?.answeredQuestions?.length
        ? '답변 카드는 생성되었습니다. 아래 카드에서 답변한 질문을 확인한 뒤 승인하십시오.'
        : mode
        ? '붙여넣은 구조화 카드를 그대로 받았습니다. 내용과 인용을 확인한 뒤 승인하십시오.'
        : '답변을 지식 카드로 정리했습니다. 내용과 인용을 확인한 뒤 승인하십시오.';
    });
  },

  // 반입할 때 주체를 잘못 골랐으면 승인 전에 바로잡는다. 승인 뒤에는 서버가 수정을 막는다.
  switchSource: id => {
    const item = view.knowledge.find(k => k.id === id);
    const sourceType = item.sourceType === 'HUMAN_EXPERT' ? 'EXTERNAL_AI' : 'HUMAN_EXPERT';
    return run('switchSource', async () => {
      await call(`/knowledge/${id}`, { method: 'PATCH', body: JSON.stringify({ revision: item.revision, card: item.card, sourceType }) });
      view.notice = `답변 주체를 '${SOURCE_LABEL[sourceType]}'(으)로 바꿨습니다.`;
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
      || checkedValues(`learning-cardterm-${id}`).length) {
      captureDrafts(); view.error = '카드 내용·비식별 변경을 먼저 저장한 뒤 승인하십시오.'; render(); return;
    }
    if ((view.coverage?.questions || []).length && !selected.length) {
      captureDrafts(); view.error = '이 답변이 다룬 질문을 하나 이상 선택하십시오.'; render(); return;
    }
    const body = JSON.stringify({ revision: item.revision,
      answeredQuestions: selected, knowledgeConfirmed: el(`learning-ok-know-${id}`).checked,
      privacyConfirmed: el(`learning-ok-priv-${id}`).checked });
    return run('approve', async () => {
      await call(`/knowledge/${id}/approve`, { method: 'POST', body });
      forgetDrafts(`learning-q-${id}`, `learning-ok-know-${id}`, `learning-ok-priv-${id}`);
      view.notice = '지식을 승인했습니다. 이후 같은 근거 범위의 검토에서 참고 자료로 쓰입니다.';
    });
  },

  revoke: id => {
    const item = view.knowledge.find(k => k.id === id);
    if (!confirm('이 지식을 사용 중지하시겠습니까? 이후 검토에서 참고되지 않습니다.')) return;
    return run('revoke', () => call(`/knowledge/${id}/revoke`, { method: 'POST', body: JSON.stringify({ revision: item.revision }) }));
  },

  // 원 검토의 쟁점·요건·공식 근거 스냅샷에 승인 답변을 연결해 최종 검토한다.
  rerun: () => {
    const meta = state.lastReviewResult?.meta || {};
    if (!state.lastReviewResult?.review?.reasoning?.issues?.length) {
      view.error = '원 검토의 쟁점·요건 구조가 없습니다. 단계형 최초 검토를 완료한 뒤 외부 답변을 연결하십시오.';
      render();
      return;
    }
    const c = view.coverage || { total: 0, approved: 0 };
    const unmet = (c.questions || []).filter(q => q.state !== 'APPROVED');
    if (unmet.length) {
      view.error = `모든 확인 사항의 답변을 승인한 뒤 최종 검토를 실행할 수 있습니다. 미충족 질문: ${unmet.length}건`;
      render();
      return;
    }
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
 * 개인정보 제안에 공백이 있을 때 본문에 남은 부분 표현을 찾아준다.
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
const SOURCE_LABEL = { EXTERNAL_AI: '외부 AI', HUMAN_EXPERT: '외부 전문가' };
const sourceOf = item => item.sourceType === 'HUMAN_EXPERT' ? 'HUMAN_EXPERT' : 'EXTERNAL_AI';
const DISTILLATION_LABEL = { LOCAL_SINGLE: '로컬 AI 정리', LOCAL_CHUNKED: '로컬 AI 조각 정리',
  USER_STRUCTURED_JSON: '구조화 출력 그대로' };

// 단계형 검토에서 만든 질문은 어느 쟁점·요건의 판단 공백인지 보여준다. 답이 오면 그 쟁점만 다시 판단한다.
const GAP_LABEL = { LEGAL_INTERPRETATION: '해석 기준', AUTHORITY_CONFLICT: '근거 충돌', MISSING_AUTHORITY: '근거 부재', STAGE_FAILURE: '판단 실패' };
const anchorLabel = a => a.scope === 'ALL_ISSUES'
  ? `전체 쟁점 · ${a.group || GAP_LABEL[a.type] || a.type}`
  : `쟁점 ${a.issueId || '-'}${a.elementId ? ` · 요건 ${a.elementId}` : ''} · ${GAP_LABEL[a.type] || a.type}`;
const foldOpen = (id, defaultOpen) => (Object.hasOwn(view.folds, id) ? view.folds[id] : defaultOpen) ? ' open' : '';
function defaultFolds() {
  const inquiry = view.inquiry;
  const coverage = view.coverage || { total: 0, answered: 0, approved: 0 };
  const hasAnswers = coverage.total > 0 && coverage.answered >= coverage.total;
  const allApproved = coverage.total > 0 && coverage.approved >= coverage.total
    && !view.knowledge.some(item => item.state === 'DRAFT');
  return {
    step1: !inquiry,
    step2: inquiry?.state === 'DRAFT',
    step3: inquiry?.state === 'READY' && !hasAnswers,
    step4: view.knowledge.length > 0 && !allApproved,
    step5: inquiry?.state === 'READY' && !view.finalized
  };
}
const foldSummary = (icon, title, status) => `<summary class="learning-fold-summary">
  <span class="material-symbols-outlined icon-sm">${icon}</span><span class="learning-fold-title">${title}</span>
  ${status ? `<span class="learning-fold-status">${status}</span>` : ''}
  <span class="material-symbols-outlined learning-fold-chevron">expand_more</span>
</summary>`;

function renderQuestions() {
  const questions = view.coverage?.questions || [];
  if (!questions.length) return '<p class="learning-empty">질문 목록을 인식하지 못했습니다.</p>';
  return `<ul class="learning-questions">${questions.map(q => `
    <li class="learning-q ${q.state.toLowerCase()}">
      <span class="learning-q-no">${q.no}</span>
      <span class="learning-q-text">${esc(q.text)}${q.anchor ? `<em class="learning-q-anchor">${esc(anchorLabel(q.anchor))}</em>` : ''}</span>
      <span class="learning-q-state">${STATE_LABEL[q.state]}</span>
    </li>`).join('')}</ul>`;
}

function renderStep1() {
  if (view.inquiry) {
    const total = view.coverage?.total || view.inquiry.questions?.length || 0;
    return `
      <details class="panel learning-step learning-fold" data-learning-fold="step1"${foldOpen('step1', false)}>
        ${foldSummary('help', '1. 확인 사항 질문화', `${total}개 질문 생성됨`)}
        <div class="panel-body">
          <p class="learning-desc">이번 검토에서 외부 확인이 필요하다고 분류된 질문입니다. 다음 단계에서 비식별 여부를 확인한 뒤 외부로 반출합니다.</p>
          ${renderQuestions()}
        </div>
      </details>`;
  }
  return `
    <div class="panel learning-step">
      <div class="panel-header"><div class="panel-title-group">
        <span class="material-symbols-outlined icon-sm">help</span><h3>1. 확인 사항 질문화</h3>
      </div></div>
      <div class="panel-body">
        <p class="learning-desc">법리 판단 공백을 질문으로 만들고, 관련 사실·요건·공식 근거 원문을 질의서에 함께 싣습니다.
          로컬 AI는 필요한 사실을 비식별로 정리합니다. 자료 수집 오류는 내부에서 보완해야 하며 외부 질문으로 보내지 않습니다.</p>
        <label class="learning-label" for="learning-focus">추가로 묻고 싶은 쟁점 (선택)</label>
        <textarea id="learning-focus" class="learning-input" rows="3"
          placeholder="예: 조례 근거 없이 수탁자가 사용료를 징수할 수 있는지"></textarea>
        <button class="btn btn-primary ai-task-button${view.busy === 'create' ? ' ai-processing' : ''}" data-learning-action="create"
          ${view.busy ? 'disabled' : ''} ${view.busy === 'create' ? 'aria-busy="true"' : ''}>
          <span class="material-symbols-outlined icon-sm">auto_awesome</span>
          <span>${view.busy === 'create' ? '로컬 AI가 쟁점을 분석 중입니다...' : '질의서 생성'}</span>
        </button>
      </div>
    </div>`;
}

function renderStep2() {
  const item = view.inquiry;
  const editable = item.state === 'DRAFT';
  const counts = Object.entries(item.redactions || {});
  const proposals = item.proposedTerms || [];
  const residual = residualTerms(proposals, item.text);
  const termBox = (value, hint) => `<label class="learning-term">
    <input type="checkbox" name="learning-term" value="${esc(value)}">
    <span>${esc(value)}</span>${hint ? `<em>${esc(hint)}</em>` : ''}</label>`;

  return `
    <details class="panel learning-step learning-fold" data-learning-fold="step2"${foldOpen('step2', editable)}>
      ${foldSummary('shield', '2. 외부 반출 전 검토', editable ? '진행 중' : '반출 준비 완료')}
      <div class="panel-body">
        <div class="learning-actions learning-fold-action"><button class="btn btn-sm btn-outline" data-learning-action="discard">질의서 삭제</button></div>
        <div class="learning-chips">
          ${counts.length ? counts.map(([kind, n]) => chip(kind, `${n}건`)).join('') : '<span class="learning-chip">자동 치환 없음</span>'}
        </div>

        ${proposals.length || residual.length ? `
        <div class="learning-proposals">
          <p class="learning-desc"><strong>로컬 AI가 발견한 개인정보 후보입니다. 아직 적용되지 않았습니다.</strong>
            실제 개인을 식별하는 정보인지 확인한 뒤 필요한 항목만 고르십시오.</p>
          ${proposals.map(t => termBox(t, looksLegalReference(t) ? '법령·조문 표기 — 가리면 근거를 특정할 수 없습니다' : '')).join('')}
          ${residual.length ? `<p class="learning-desc learning-warn">본문에 아래 짧은 표현도 남아 있습니다.
            기관·업체 이름은 자동 탐지로 걸러지지 않으므로 직접 확인하십시오.</p>
            ${residual.map(t => termBox(t, '본문에 남음')).join('')}` : ''}
        </div>` : ''}

        ${editable ? `
          <label class="learning-label" for="learning-custom-terms">추가로 가릴 단어 (쉼표 또는 줄바꿈으로 구분)</label>
          <input id="learning-custom-terms" class="learning-input" type="text" placeholder="예: 홍길동, 개인 식별 정보">
          <label class="learning-label" for="learning-text">질의서 본문 (편집 가능)</label>
          <textarea id="learning-text" class="learning-input learning-textarea" rows="18">${esc(item.text)}</textarea>
          <div class="learning-actions">
            <button class="btn btn-secondary" data-learning-action="save" ${view.busy ? 'disabled' : ''}>선택한 단어 적용 · 본문 저장</button>
          </div>
          <div class="learning-confirm">
            ${box('learning-check-privacy', '개인정보·민감정보·기관 비밀정보가 제거되었음을 확인했습니다.')}
            ${box('learning-check-logic', '판단에 필요한 사실과 조건이 보존되었음을 확인했습니다.')}
            <button class="btn btn-primary" data-learning-action="confirm" ${view.busy ? 'disabled' : ''}>
              <span class="material-symbols-outlined icon-sm">lock_open</span><span>반출 준비 확인</span></button>
          </div>` : `
          <p class="learning-desc learning-warn">이 질의서는 반출 준비가 끝났습니다. 아래 본문은 당시 외부에 전달된 원문입니다.</p>
          <pre class="learning-readonly-text">${esc(item.text)}</pre>`}
      </div>
    </details>`;
}

function renderStep3(open = true) {
  const c = view.coverage || { total: 0, answered: 0, approved: 0 };
  return `
    <details class="panel learning-step learning-fold" data-learning-fold="step3"${foldOpen('step3', open)}>
      ${foldSummary('forum', '3. 답변 접수', `승인 ${c.approved} / 답변 ${c.answered} / 전체 ${c.total}`)}
      <div class="panel-body">
        ${renderQuestions()}
        <div class="learning-actions">
          <button class="btn btn-primary" data-learning-action="copy" ${view.busy ? 'disabled' : ''}>
            <span class="material-symbols-outlined icon-sm">content_copy</span><span>질의서 복사</span></button>
          <button class="btn btn-sm btn-outline" data-learning-action="discard">질의서 삭제</button>
        </div>
        ${view.exportText ? `<textarea class="learning-input learning-textarea" rows="12" readonly
          onclick="this.select()">${esc(view.exportText)}</textarea>` : ''}
        <p class="learning-desc">복사한 질의서를 외부 AI(ChatGPT·Claude·Gemini 등)나 외부 전문가(자문 변호사, 소관 부처 등)에게 전달하고,
          받은 답변을 아래에 그대로 붙여넣으십시오. 답변 하나가 여러 질문을 함께 답할 수 있습니다.</p>
        <span class="learning-label">답변 주체</span>
        <div class="learning-links">
          <label class="learning-term"><input type="radio" name="learning-source" id="learning-source-ai" value="EXTERNAL_AI" checked>
            <span>외부 AI</span></label>
          <label class="learning-term"><input type="radio" name="learning-source" id="learning-source-human" value="HUMAN_EXPERT">
            <span>외부 전문가(사람)</span></label>
        </div>
        <p class="learning-desc">어느 쪽이든 공식 근거가 아니며, 인용 확인과 재사용 조건은 같습니다. 구분은 표시용입니다.</p>
        <label class="learning-label" for="learning-provider">답변 출처 이름 (선택 · 표시용)</label>
        <input id="learning-provider" class="learning-input" type="text" maxlength="40"
          placeholder="예: ChatGPT, 자문 변호사 — 실명·연락처는 적지 마십시오">
        <label class="learning-label" for="learning-answer">외부 답변 붙여넣기</label>
        <textarea id="learning-answer" class="learning-input learning-textarea" rows="10"
          placeholder="받은 답변 전체를 붙여넣으십시오."></textarea>
        <label class="learning-check">
          <input type="checkbox" id="learning-mode-structured">
          <span>질의서가 요청한 <strong>질문별 JSON 부분만</strong> 붙여넣었습니다 (각 질문 1건 + card, 로컬 AI 정리 없이 그대로 사용)</span>
        </label>
        <button class="btn btn-primary ai-task-button${view.busy === 'import' ? ' ai-processing' : ''}" data-learning-action="import"
          ${view.busy ? 'disabled' : ''} ${view.busy === 'import' ? 'aria-busy="true"' : ''}>
          <span class="material-symbols-outlined icon-sm">download</span>
          <span>${view.busy === 'import' ? '로컬 AI가 지식으로 정리 중입니다...' : '답변 반입'}</span>
        </button>
        <p class="learning-desc">답변이 길면 로컬 AI가 조각으로 나눠 읽습니다. 시간이 더 걸리고,
          일부 조각이 실패하면 그 카드는 미완으로 표시되어 승인할 수 없습니다.</p>
      </div>
    </details>`;
}

function renderCard(item) {
  const questions = view.coverage?.questions || [];
  const editable = item.state === 'DRAFT';
  const answered = item.answeredQuestions?.length ? item.answeredQuestions
    : editable && questions.length === 1 ? [questions[0].no] : [];
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
        <span class="learning-badge source-${sourceOf(item).toLowerCase()}">${SOURCE_LABEL[sourceOf(item)]}</span>
        <span class="learning-badge ${item.state.toLowerCase()}">${item.state === 'APPROVED' ? '승인됨'
          : item.state === 'REVOKED' ? '사용 중지' : '검토 대기'}</span>
      </div>
      <p class="learning-card-meta">
        ${esc(item.sourceLabel)}${item.providerLabel ? ` · ${esc(item.providerLabel)}` : ''} ·
        인용 검증 ${verified}/${checks.length} · ${esc(DISTILLATION_LABEL[item.distillation] || '로컬 AI 정리')} · 법적 효력 미인증
        ${editable ? `<button class="btn btn-sm btn-outline" data-learning-action="switchSource" data-id="${item.id}">
          '${SOURCE_LABEL[sourceOf(item) === 'HUMAN_EXPERT' ? 'EXTERNAL_AI' : 'HUMAN_EXPERT']}' 답변으로 변경</button>` : ''}
      </p>
      ${incomplete ? `<div class="learning-message error">답변 ${item.chunkCoverage.total}조각 중
        ${item.chunkCoverage.processed}조각만 정리되었습니다. 내용이 일부만 반영된 지식이므로 승인할 수 없습니다.
        답변을 쟁점별로 나누어 다시 반입하십시오.</div>` : ''}
      <div class="learning-field"><span>쟁점</span><p>${esc(item.card.issue)}</p></div>
      ${list('적용 조건', item.card.conditions)}
      ${list('예외', item.card.exceptions)}
      ${list('검토 원리', item.card.principles)}
      ${list('점검 순서', item.card.checklist)}
      ${checks.some(c => c.status !== 'VERIFIED_EXISTENCE') ? `<div class="learning-message warn">확인되지 않은 인용이 있어 이 카드는 최종 재검토에 사용되지 않습니다. 원 검토에 저장된 공식 근거를 확인하십시오.</div>` : ''}
      ${checks.length ? `<div class="learning-field"><span>인용</span><ul>${checks.map(c =>
        `<li class="${c.status === 'VERIFIED_EXISTENCE' ? 'ok' : 'warn'}">${esc(c.lawName)} ${esc(c.articleNo)}
          — ${esc(CITATION_LABEL[c.status] || '확인 불가')}</li>`).join('')}</ul></div>` : ''}

      ${cases.length ? `<div class="learning-field"><span>본문에 적힌 판례·해석례 번호</span><ul>${cases.map(c =>
        `<li class="${c.status === 'VERIFIED_EXISTENCE' ? 'ok' : 'warn'}">${esc(c.caseNo)}
          — ${c.status === 'VERIFIED_EXISTENCE' ? '이번 검토에서 확보한 자료에 있음' : '확보한 자료에서 확인 불가 — 이 지식은 재사용되지 않습니다'}
        </li>`).join('')}</ul></div>` : ''}

      ${questions.length ? `<div class="learning-field"><span>이 답변이 다룬 질문</span>
        ${editable && !answered.length ? `<p class="learning-desc learning-warn">답변한 질문을 선택하십시오. 승인할 때 함께 연결됩니다.</p>` : ''}
        <div class="learning-links">${questions.map(q => `<label class="learning-term">
          <input type="checkbox" name="learning-q-${item.id}" value="${q.no}"
            ${answered.includes(q.no) ? 'checked' : ''} ${editable ? '' : 'disabled'}>
          <span>${q.no}. ${esc(q.text.slice(0, 40))}${q.text.length > 40 ? '…' : ''}</span></label>`).join('')}</div>
        </div>` : ''}

      ${editable && (item.proposedTerms || []).length ? `
      <div class="learning-proposals">
        <p class="learning-desc"><strong>로컬 AI가 발견한 개인정보 후보입니다. 아직 적용되지 않았습니다.</strong>
          실제 개인을 식별하는 정보인지 확인한 뒤 필요한 항목만 고르십시오.</p>
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

function renderStep5(open = false) {
  const c = view.coverage || { total: 0, approved: 0, questions: [] };
  if (!c.total) return '';
  const hasBaseline = Boolean(state.lastReviewResult?.review?.reasoning?.issues?.length);
  const unmet = (c.questions || []).filter(q => q.state !== 'APPROVED');
  const used = state.lastReviewResult?.review?.learningReferences || [];
  const dropped = state.lastReviewResult?.review?.learningExcluded || [];
  const impacts = state.lastReviewResult?.review?.reasoning?.knowledgeImpact || [];
  const partial = state.lastReviewResult?.review?.reviewStatus === 'PARTIAL';

  return `
    <details class="panel learning-step learning-fold" data-learning-fold="step5"${foldOpen('step5', open)}>
      ${foldSummary('task_alt', '5. 최종 답변서', `충족 ${c.approved} / ${c.total}`)}
      <div class="panel-body">
        <p class="learning-desc">원 검토의 쟁점·요건·공식 근거를 유지하고, 승인된 답변이 연결된 공백만 보충해 최종 검토합니다.
          공식 근거는 원 검토 시점의 스냅샷이며, 승인된 지식이 공식 근거를 대신하지 않습니다.</p>
        ${unmet.length ? `<p class="learning-desc learning-warn">아직 충족되지 않은 질문 ${unmet.length}건:
          ${unmet.map(q => `#${q.no}`).join(', ')} — 모든 답변을 승인해야 최종 검토를 다시 실행할 수 있습니다.</p>` : ''}
        ${!hasBaseline ? '<p class="learning-desc learning-warn">원 검토의 쟁점·요건 구조가 없어 이 답변을 끼워 넣을 수 없습니다. 단계형 최초 검토를 다시 완료하십시오.</p>' : ''}
        ${used.length ? `<div class="learning-message ${partial ? 'warn' : 'notice'}">승인된 외부 참고 지식 ${used.length}건을 반영하여 ${partial ? '부분 재검토를 진행했습니다. 제외된 카드와 검토 제한 사항을 확인하십시오' : '최종 검토를 완료했습니다'}.
          법률검토의견서 상단의 ‘외부 반영’ 표시와 검토 구분을 확인하십시오.</div>` : ''}
        ${used.length ? `<p class="learning-desc">직전 검토에 실린 지식 ${used.length}건:
          ${used.map(r => `${esc(r.title)} (${r.source === 'USER_APPROVED_HUMAN_EXPERT' ? '외부 전문가' : '외부 AI'})`).join(' · ')}</p>` : ''}
        ${impacts.length ? `<div class="learning-message notice">영향을 받은 판단
          <ul>${impacts.map(item => `<li>${esc(item.usedFor)} — ${item.officiallyVerified ? '공식 근거 연결 확인' : '공식 근거 추가 확인 필요'}</li>`).join('')}</ul></div>` : ''}
        ${dropped.length ? `<div class="learning-message warn">직전 검토에서 적용하지 않은 지식 ${dropped.length}건
          <ul class="learning-dropped">${dropped.map(d =>
            `<li>${esc(d.title || '(제목 없음)')} — ${esc(d.message)}</li>`).join('')}</ul></div>` : ''}
        <button class="btn btn-primary" data-learning-action="rerun" ${view.busy || unmet.length || !hasBaseline ? 'disabled' : ''}
          ${unmet.length ? 'title="모든 질문의 답변을 승인해야 합니다."' : ''}>
          <span class="material-symbols-outlined icon-sm">restart_alt</span>
          <span>승인된 지식으로 최종 검토 다시 실행</span></button>
      </div>
    </details>`;
}

function renderStep4(open = false) {
  if (!view.knowledge.length) return '';
  const unassigned = view.coverage?.unassigned || [];
  return `
    <details class="panel learning-step learning-fold" data-learning-fold="step4"${foldOpen('step4', open)}>
      ${foldSummary('library_books', '4. 지식 카드 검토', `${view.knowledge.length}건`)}
      <div class="panel-body">
        <p class="learning-desc">외부 AI 답변은 검증 대상 후보 지식입니다. 공식 근거를 대신하지 않습니다.
          적용 조건과 예외를 확인하고 승인해야 이후 검토에 참고 자료로 쓰입니다.</p>
        ${unassigned.length ? `<p class="learning-desc learning-warn">
          어느 질문과도 연결되지 않은 카드가 ${unassigned.length}건 있습니다.
          로컬 AI가 연결을 놓쳤을 수 있으니 아래에서 직접 지정하십시오.</p>` : ''}
        ${view.knowledge.map(renderCard).join('')}
      </div>
    </details>`;
}

function updateBadge() {
  const badge = document.getElementById('badge-learning-status');
  if (!badge) return;
  const c = view.coverage;
  const externalCount = view.reviewIssues.filter(issue => issue.kind === 'inquiry').length;
  if (!view.inquiry) {
    badge.className = `tab-badge ${externalCount ? 'warning' : 'off'}`;
    badge.textContent = externalCount ? `질의 ${externalCount}` : '대기';
    return;
  }
  if (!c?.total) {
    badge.className = `tab-badge ${externalCount ? 'warning' : 'active'}`;
    badge.textContent = externalCount ? `질의 ${externalCount}` : '작성 중';
    return;
  }
  badge.className = c.approved < c.total ? 'tab-badge warning' : 'tab-badge active';
  badge.textContent = `답변 ${c.approved}/${c.total}`;
}

function renderReviewIssues() {
  const questions = view.reviewIssues.filter(issue => issue.kind === 'inquiry');
  if (!questions.length) return `<div class="learning-message notice">외부 전문가에게 질의할 법리 판단 공백이 없습니다. 필요한 질문은 직접 입력할 수 있습니다.</div>`;
  return `<section class="panel learning-review-issues" aria-label="외부 전문가 질의 사항">
    <div class="panel-header"><div class="panel-title-group"><span class="material-symbols-outlined icon-sm">report</span>
      <h3>외부 전문가 질의 사항 <span class="learning-issue-count">${questions.length}건</span></h3></div></div>
    <div class="panel-body">
      <ul class="learning-review-issue-list">${questions.map(issue => `<li class="learning-review-issue ${issue.kind}">
        <span class="learning-issue-group">${esc(issue.group)}</span><span>${esc(issue.displayDetail || issue.detail)}</span></li>`).join('')}</ul>
    </div>
  </section>`;
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

  const folds = defaultFolds();
  const body = !view.inquiry
    ? renderStep1()
    : `${renderStep1()}${renderStep2()}${view.inquiry.state === 'DRAFT' ? ''
      : `${renderStep3(folds.step3)}${renderStep4(folds.step4)}${renderStep5(folds.step5)}`}`;

  root.innerHTML = `${providerNote}${messages}${renderReviewIssues()}${body}`;
  for (const node of root.querySelectorAll('input, textarea')) {
    const key = draftKey(node);
    if (Object.hasOwn(view.drafts, key)) {
      if (isToggle(node)) node.checked = view.drafts[key];
      else node.value = view.drafts[key];
    }
  }
  if (view.busy) for (const node of root.querySelectorAll('button, input, textarea')) node.disabled = true;
  updateBadge();
}

export default { initLearningTab, setLearningHistory, resetLearningTab };
