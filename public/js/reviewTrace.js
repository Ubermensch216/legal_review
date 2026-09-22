// public/js/reviewTrace.js - 검토 추론 과정(진행 상황) 폴딩 패널
//
// 서버가 NDJSON으로 흘려보내는 진행 이벤트를 실행 버튼 바로 아래 타임라인으로 그린다.
// 사용자가 기다리는 동안 "지금 무엇을 하고 있는지"를 단계·수확량·소요 시간으로 보여준다.
//
// 상태 표시 규칙:
//  - RUNNING: 파란 점이 맥동한다. 헤더에 현재 단계와 실시간 수치(tick)를 띄운다.
//  - DONE/SKIPPED/FAILED: 점 색으로 결과를 구분하고, 단계별 소요 시간을 오른쪽에 적는다.
//  - warn: 제한 사항. 노란 줄로 해당 단계 밑에 붙인다. 완료 후에도 남는다.
// 완료되면 패널을 자동으로 접고 헤더에 요약만 남긴다. (사용자가 직접 펼친 상태면 유지)

// 파이프라인의 예상 단계 수. 진행 바 길이 계산에만 쓰이며, 실제 단계 수는 사안마다 다르다.
const EXPECTED_STEPS = 12;

const els = {};
let steps = new Map();      // key -> { el, notesEl, state }
let order = [];
let timerId = null;
let startedAt = 0;
let userExpanded = null;    // 사용자가 직접 토글했으면 자동 접기를 하지 않는다
let finished = false;
// 진행 중인 단계. 로컬 모델의 프롬프트 처리처럼 수 분간 이벤트가 없는 구간에서도
// 이 단계의 경과 시간을 계속 갱신해, 멈춘 것인지 기다리는 것인지 구분되게 한다.
let running = null;         // { key, startedAt, detail, tickedAt }

export function initReviewTrace() {
  els.root = document.getElementById('review-trace');
  if (!els.root) return;
  els.toggle = document.getElementById('trace-toggle');
  els.icon = document.getElementById('trace-state-icon');
  els.current = document.getElementById('trace-current');
  els.sub = document.getElementById('trace-sub');
  els.elapsed = document.getElementById('trace-elapsed');
  els.bar = document.getElementById('trace-bar');
  els.body = document.getElementById('trace-body');
  els.list = document.getElementById('trace-list');

  els.toggle.addEventListener('click', () => {
    const collapsed = els.root.classList.toggle('collapsed');
    userExpanded = !collapsed;
    els.toggle.setAttribute('aria-expanded', String(!collapsed));
  });
}

/** 새 검토 시작. 패널을 비우고 펼친 상태로 보여준다. */
export function startReviewTrace({ provider = '', model = '' } = {}) {
  if (!els.root) return;
  steps = new Map();
  order = [];
  finished = false;
  userExpanded = null;
  startedAt = Date.now();

  els.list.innerHTML = '';
  els.root.classList.remove('hidden', 'collapsed');
  els.root.dataset.state = 'running';
  els.root.removeAttribute('data-source');
  els.toggle.setAttribute('aria-expanded', 'true');
  els.icon.innerHTML = '<span class="trace-pulse"></span>';
  els.current.textContent = '검토를 시작합니다';
  els.sub.textContent = [provider, model].filter(Boolean).join(' / ') || '진행 상황이 단계별로 표시됩니다';
  els.bar.style.width = '2%';

  running = null;
  clearInterval(timerId);
  timerId = setInterval(tickClock, 150);
}

/** 진행 이벤트 한 건을 반영한다. */
export function pushTraceEvent(event) {
  if (!els.root || !event) return;

  if (event.kind === 'step') {
    if (event.state === 'RUNNING') {
      upsertStep(event, 'RUNNING');
      running = { key: event.key, startedAt: Date.now(), detail: event.detail || '', tickedAt: 0 };
      els.current.textContent = event.label || '검토 진행 중';
      els.sub.textContent = event.detail || '';
    } else {
      upsertStep(event, event.state || 'DONE');
      if (running?.key === event.key) running = null;
      if (event.detail) els.sub.textContent = event.detail;
      advanceBar();
    }
    return;
  }

  if (event.kind === 'tick') {
    // 실시간 수치는 헤더에만 흘린다. 타임라인에 쌓으면 같은 줄이 수백 개가 된다.
    if (running) running.tickedAt = Date.now();
    els.sub.textContent = event.detail || els.sub.textContent;
    return;
  }

  if (event.kind === 'note' || event.kind === 'warn') {
    addNote(event.key, event.detail, event.kind === 'warn');
    if (event.kind === 'warn') markWarn();
    return;
  }

  if (event.kind === 'finish') {
    finishReviewTrace({ summary: event.detail, totalMs: event.ms });
  }
}

/** 검토 종료. 요약만 남기고 접는다. */
export function finishReviewTrace({ summary = '', totalMs = null, failed = false } = {}) {
  if (!els.root) return;
  finished = true;
  clearInterval(timerId);

  const elapsed = totalMs != null ? totalMs : Date.now() - startedAt;
  els.elapsed.textContent = formatElapsed(elapsed);
  els.bar.style.width = '100%';

  running = null;
  // 아직 RUNNING으로 남은 단계는 여기서 닫는다. (스트림이 중간에 끊긴 경우)
  for (const [key, step] of steps) {
    if (step.state === 'RUNNING') setStepState(key, failed ? 'FAILED' : 'DONE', failed ? '응답이 끊겼습니다' : '');
  }

  const warnCount = els.list.querySelectorAll('.trace-note.warn').length;
  const doneCount = els.list.querySelectorAll('.trace-step[data-state="DONE"]').length;

  els.root.dataset.state = failed ? 'error' : (warnCount ? 'warn' : 'done');
  els.icon.innerHTML = `<span class="material-symbols-outlined">${
    failed ? 'error' : (warnCount ? 'warning' : 'check_circle')}</span>`;
  els.current.textContent = failed ? '검토가 중단되었습니다' : '검토 완료';
  els.sub.textContent = summary
    || `${doneCount}단계 · ${formatElapsed(elapsed)}${warnCount ? ` · 제한 사항 ${warnCount}건` : ''}`;

  // 사용자가 직접 펼쳐 둔 경우에는 접지 않는다.
  if (userExpanded !== true) {
    els.root.classList.add('collapsed');
    els.toggle.setAttribute('aria-expanded', 'false');
  }
}

/** 스트림을 쓸 수 없는 환경(구형 브라우저 등)에서의 단순 대기 표시. */
export function showTraceFallback(message) {
  if (!els.root) return;
  startReviewTrace();
  els.current.textContent = '검토 진행 중';
  els.sub.textContent = message || '진행 상황을 수신할 수 없어 완료까지 기다립니다.';
  els.list.innerHTML = '<li class="trace-empty">이 브라우저에서는 단계별 진행 상황을 받을 수 없습니다.</li>';
  els.bar.style.width = '35%';
}

/**
 * 진행 시계. 전체 경과 시간과 진행 중인 단계의 경과 시간을 함께 갱신한다.
 * 서버 이벤트가 없는 구간(로컬 모델의 프롬프트 처리 등)에서도 화면이 살아 있어야 한다.
 */
function tickClock() {
  if (finished) return;
  els.elapsed.textContent = formatElapsed(Date.now() - startedAt);
  if (!running) return;

  const stepMs = Date.now() - running.startedAt;
  const step = steps.get(running.key);
  if (step) step.el.querySelector('.trace-step-ms').textContent = formatElapsed(stepMs);

  // 실시간 수치(tick)를 한 번도 못 받은 채 5초가 지나면, 무엇을 기다리는지 시간과 함께 알린다.
  if (!running.tickedAt && stepMs > 5000) {
    els.sub.textContent = `${running.detail ? `${running.detail} · ` : ''}응답 대기 ${formatElapsed(stepMs)}`;
  }
}

/**
 * 이력에서 불러온 검토의 추론 과정을 그대로 되살린다.
 * @param {{events: Array, stepCount: number, warnCount: number, totalMs: number}} trace
 */
export function renderTraceFromHistory(trace) {
  if (!els.root) return;
  if (!trace || !Array.isArray(trace.events) || trace.events.length === 0) {
    els.root.classList.add('hidden');
    return;
  }

  startReviewTrace();
  clearInterval(timerId);
  finished = true;
  for (const event of trace.events) pushTraceEvent(event);

  els.root.dataset.source = 'history';
  els.root.dataset.state = trace.warnCount ? 'warn' : 'done';
  els.icon.innerHTML = `<span class="material-symbols-outlined">${trace.warnCount ? 'warning' : 'history'}</span>`;
  els.current.textContent = '지난 검토의 추론 과정';
  els.sub.textContent = `${trace.stepCount || els.list.querySelectorAll('.trace-step').length}단계`
    + ` · ${formatElapsed(trace.totalMs || 0)}`
    + `${trace.warnCount ? ` · 제한 사항 ${trace.warnCount}건` : ''}`;
  els.elapsed.textContent = formatElapsed(trace.totalMs || 0);
  els.bar.style.width = '100%';
  els.root.classList.add('collapsed');
  els.toggle.setAttribute('aria-expanded', 'false');
}

/* ── 내부 구현 ─────────────────────────────────────────────── */

function upsertStep(event, state) {
  const existing = steps.get(event.key);
  if (existing) {
    setStepState(event.key, state, event.detail, event.ms);
    return existing;
  }

  const li = document.createElement('li');
  li.className = 'trace-step';
  li.dataset.state = state;
  li.innerHTML = `
    <div class="trace-step-head">
      ${event.group ? `<span class="trace-step-group">${escapeHtml(event.group)}</span>` : ''}
      <span class="trace-step-label"></span>
      <span class="trace-step-ms"></span>
    </div>
    <div class="trace-step-detail"></div>
    <ul class="trace-notes"></ul>`;
  li.querySelector('.trace-step-label').textContent = event.label || event.key;
  li.querySelector('.trace-step-detail').textContent = event.detail || '';
  if (event.ms != null) li.querySelector('.trace-step-ms').textContent = formatElapsed(event.ms);

  els.list.appendChild(li);
  const entry = { el: li, notesEl: li.querySelector('.trace-notes'), state };
  steps.set(event.key, entry);
  order.push(event.key);

  // 진행 중인 단계가 항상 보이도록 따라간다.
  if (!els.root.classList.contains('collapsed')) els.body.scrollTop = els.body.scrollHeight;
  return entry;
}

function setStepState(key, state, detail, ms) {
  const step = steps.get(key);
  if (!step) return;
  step.state = state;
  step.el.dataset.state = state;
  if (detail) step.el.querySelector('.trace-step-detail').textContent = detail;
  if (ms != null) step.el.querySelector('.trace-step-ms').textContent = formatElapsed(ms);
}

function addNote(key, text, isWarn) {
  if (!text) return;
  const step = steps.get(key);
  // 단계가 아직 없는 보조 줄(예: 파이프라인 전체 경고)은 마지막 단계에 붙인다.
  const host = step?.notesEl || steps.get(order[order.length - 1])?.notesEl;
  if (!host) return;

  // 같은 키의 "조회 중" 류 진행 메모는 마지막 한 줄만 남겨 로그가 불어나지 않게 한다.
  if (!isWarn && host.children.length >= 6) host.removeChild(host.firstElementChild);

  const li = document.createElement('li');
  li.className = `trace-note${isWarn ? ' warn' : ''}`;
  li.textContent = text;
  host.appendChild(li);
  if (!els.root.classList.contains('collapsed')) els.body.scrollTop = els.body.scrollHeight;
}

function markWarn() {
  if (els.root.dataset.state === 'running') return;
  els.root.dataset.state = 'warn';
}

function advanceBar() {
  const closed = els.list.querySelectorAll('.trace-step:not([data-state="RUNNING"])').length;
  const ratio = Math.min(0.95, closed / EXPECTED_STEPS);
  els.bar.style.width = `${Math.max(2, ratio * 100).toFixed(1)}%`;
}

function formatElapsed(ms) {
  const sec = (Number(ms) || 0) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}초`;
  const m = Math.floor(sec / 60);
  return `${m}분 ${Math.round(sec - m * 60)}초`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export default { initReviewTrace, startReviewTrace, pushTraceEvent, finishReviewTrace, renderTraceFromHistory, showTraceFallback };
