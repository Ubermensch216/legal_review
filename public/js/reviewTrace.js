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

const PHASES = [
  { group: '준비', id: 'prepare' },
  { group: '수집', id: 'collect' },
  { group: '분석', id: 'analyze' },
  { group: '작성', id: 'write' },
  { group: '검증', id: 'verify' }
];

// 작업 수가 아니라 실제 파이프라인에서 차지하는 예상 소요량으로 구간을 나눈다.
// 즉시 끝나는 집계 작업은 좁게, 모델 호출은 넓게 잡아 긴 분석 도중 진행률이 앞서가지 않게 한다.
const COMMON_PROGRESS = {
  parse: [2, 4, 2500], doc: [4, 7, 3000], keywords: [7, 9, 1500],
  law: [9, 15, 12000], articles: [15, 22, 15000], search: [22, 28, 15000],
  screen: [28, 33, 15000], adminrule: [33, 35, 10000], ordinance: [35, 37, 10000],
  rerank: [37, 39, 5000], integrity: [39, 40, 1000], learning: [40, 42, 3000]
};
const MONOLITHIC_PROGRESS = {
  budget: [42, 45, 2000], stage1: [45, 52, 60000], llm: [52, 78, 120000],
  json: [78, 92, 12000], verify: [92, 98, 12000], save: [98, 99, 1500]
};
const STAGED_PROGRESS = {
  s0: [42, 44, 2000], s1: [44, 58, 90000], s2: [58, 63, 20000],
  s3: [63, 70, 60000], s6: [86, 91, 60000], s7: [91, 92, 1000],
  s5: [92, 96, 60000], verify: [96, 98, 12000], save: [98, 99, 1500]
};
// 단계형 쟁점 정리가 실패한 뒤 단일 호출로 전환되면 이미 표시한 진행률에서 이어 간다.
const FALLBACK_PROGRESS = {
  budget: [58, 60, 2000], stage1: [60, 66, 60000], llm: [66, 80, 120000],
  json: [80, 92, 12000], verify: [92, 98, 12000], save: [98, 99, 1500]
};
const SEGMENT_PARTS = ['llm-part-issues', 'llm-part-opinion', 'llm-part-actions', 'llm-part-draft'];

const els = {};
let steps = new Map();      // key -> { el, notesEl, state }
let order = [];
let timerId = null;
let startedAt = 0;
let userExpanded = null;    // 사용자가 직접 토글했으면 자동 접기를 하지 않는다
let finished = false;
let currentProgress = 0;
let progressContext = null;
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
  els.progressValue = document.getElementById('trace-progress-value');
  els.progressbar = document.getElementById('trace-progressbar');
  els.phaseTrack = document.getElementById('trace-phase-track');
  els.body = document.getElementById('trace-body');
  els.list = document.getElementById('trace-list');

  els.toggle.addEventListener('click', () => {
    const collapsed = els.root.classList.toggle('collapsed');
    userExpanded = !collapsed;
    els.toggle.setAttribute('aria-expanded', String(!collapsed));
  });
}

/** 현재 검토의 진행 기록을 버리고 새 검토 전 상태로 되돌린다. */
export function resetReviewTrace() {
  clearInterval(timerId);
  timerId = null;
  steps = new Map();
  order = [];
  startedAt = 0;
  userExpanded = null;
  finished = false;
  running = null;
  currentProgress = 0;
  progressContext = createProgressContext();

  if (!els.root) return;
  els.root.classList.add('hidden');
  els.root.classList.remove('collapsed');
  els.root.removeAttribute('data-state');
  els.root.removeAttribute('data-source');
  els.root.removeAttribute('data-phase');
  els.toggle?.setAttribute('aria-expanded', 'true');
  if (els.list) els.list.innerHTML = '';
  setOverallProgress(0, true);
  if (els.current) els.current.textContent = '검토를 준비하고 있습니다';
  if (els.sub) els.sub.textContent = '진행 상황이 단계별로 표시됩니다';
  if (els.elapsed) els.elapsed.textContent = '0.0초';
  if (els.icon) els.icon.innerHTML = '<span class="trace-pulse"></span>';
}

/** 새 검토 시작. 패널을 비우고 펼친 상태로 보여준다. */
export function startReviewTrace({ provider = '', model = '' } = {}) {
  if (!els.root) return;
  steps = new Map();
  order = [];
  finished = false;
  userExpanded = null;
  startedAt = Date.now();
  currentProgress = 0;
  progressContext = createProgressContext();

  els.list.innerHTML = '';
  els.root.classList.remove('hidden', 'collapsed');
  els.root.dataset.state = 'running';
  els.root.removeAttribute('data-source');
  setPhase('준비');
  els.toggle.setAttribute('aria-expanded', 'true');
  els.icon.innerHTML = '<span class="trace-pulse"></span>';
  els.current.textContent = '검토를 시작합니다';
  els.sub.textContent = [provider, model].filter(Boolean).join(' / ') || '진행 상황이 단계별로 표시됩니다';
  setOverallProgress(2, true);

  running = null;
  clearInterval(timerId);
  timerId = setInterval(tickClock, 150);
}

/** 진행 이벤트 한 건을 반영한다. */
export function pushTraceEvent(event) {
  if (!els.root || !event) return;

  if (event.kind === 'step') {
    if (event.state === 'RUNNING') {
      setPhase(event.group);
      upsertStep(event, 'RUNNING');
      beginProgressStep(event);
      els.current.textContent = event.label || '검토 진행 중';
      els.sub.textContent = event.detail || '';
    } else {
      if (!steps.has(event.key)) setPhase(event.group);
      upsertStep(event, event.state || 'DONE');
      completeProgressStep(event);
      if (running?.key === event.key) running = null;
      if (event.detail) els.sub.textContent = event.detail;
    }
    return;
  }

  if (event.kind === 'tick') {
    // 실시간 수치는 헤더에만 흘린다. 타임라인에 쌓으면 같은 줄이 수백 개가 된다.
    if (running) {
      running.tickedAt = Date.now();
      const chars = parseGeneratedChars(event.detail);
      if (chars != null) running.workDone = chars;
      updateRunningProgress();
    }
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
  if (!failed) setOverallProgress(100, true);
  else {
    if (els.progressValue) els.progressValue.textContent = '중단';
    els.progressbar?.setAttribute('aria-valuetext', '검토 중단');
  }

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
  els.root.dataset.source = 'fallback';
  els.current.textContent = '검토 진행 중';
  els.sub.textContent = message || '진행 상황을 수신할 수 없어 완료까지 기다립니다.';
  els.list.innerHTML = '<li class="trace-empty">이 브라우저에서는 단계별 진행 상황을 받을 수 없습니다.</li>';
  els.bar.style.width = '35%';
  if (els.progressValue) els.progressValue.textContent = '산정 중';
  els.progressbar?.removeAttribute('aria-valuenow');
  els.progressbar?.setAttribute('aria-valuetext', '진행률 산정 중');
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
  updateRunningProgress(stepMs);

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
  els.root.dataset.source = 'history';
  for (const event of trace.events) pushTraceEvent(event);

  els.root.dataset.state = trace.warnCount ? 'warn' : 'done';
  els.icon.innerHTML = `<span class="material-symbols-outlined">${trace.warnCount ? 'warning' : 'history'}</span>`;
  els.current.textContent = '지난 검토의 추론 과정';
  els.sub.textContent = `${trace.stepCount || els.list.querySelectorAll('.trace-step').length}단계`
    + ` · ${formatElapsed(trace.totalMs || 0)}`
    + `${trace.warnCount ? ` · 제한 사항 ${trace.warnCount}건` : ''}`;
  els.elapsed.textContent = formatElapsed(trace.totalMs || 0);
  setOverallProgress(100, true);
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
  li.dataset.phase = PHASES.find(phase => phase.group === event.group)?.id || '';
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

function setPhase(group) {
  const index = PHASES.findIndex(phase => phase.group === group);
  if (index < 0 || !els.phaseTrack) return;
  const phase = PHASES[index].id;
  if (els.root.dataset.phase === phase) return;
  els.root.dataset.phase = phase;
  for (const [position, node] of [...els.phaseTrack.querySelectorAll('.trace-phase')].entries()) {
    node.classList.toggle('is-active', position === index);
    node.classList.toggle('is-past', position < index);
    if (position === index) node.setAttribute('aria-current', 'step');
    else node.removeAttribute('aria-current');
  }
}

function setOverallProgress(percent, allowDecrease = false) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  currentProgress = allowDecrease ? value : Math.max(currentProgress, value);
  if (els.bar) els.bar.style.width = `${currentProgress}%`;
  if (els.progressValue) els.progressValue.textContent = currentProgress === 100 ? '100% 완료' : `약 ${currentProgress}%`;
  els.progressbar?.setAttribute('aria-valuenow', String(currentProgress));
  els.progressbar?.setAttribute('aria-valuetext', currentProgress === 100 ? '검토 완료' : `예상 전체 진행률 약 ${currentProgress}%`);
}

function createProgressContext() {
  return { profile: 'monolithic', totalIssues: 5, issueKeys: [] };
}

/**
 * 한 작업에 배정된 전체 진행률 구간을 반환한다.
 * 단계형 파이프라인은 s0 이벤트부터 구별하며, S4는 실제 쟁점 수로 16% 구간을 나눈다.
 */
export function progressRangeForStep(key, context = {}) {
  const profile = context.profile || 'monolithic';
  const common = COMMON_PROGRESS[key];
  if (common) return common;

  if (key?.startsWith('s4:')) {
    const issueKeys = context.issueKeys || [];
    let index = issueKeys.indexOf(key);
    if (index < 0) index = issueKeys.length;
    const total = Math.max(1, Number(context.totalIssues) || 5, index + 1);
    const width = 16 / total;
    return [70 + width * index, Math.min(86, 70 + width * (index + 1)), 90000];
  }

  const partIndex = SEGMENT_PARTS.indexOf(key);
  if (partIndex >= 0) {
    const width = 14 / SEGMENT_PARTS.length;
    return [78 + width * partIndex, 78 + width * (partIndex + 1), 75000];
  }

  const profileSteps = profile === 'staged' ? STAGED_PROGRESS
    : (profile === 'fallback' ? FALLBACK_PROGRESS : MONOLITHIC_PROGRESS);
  return profileSteps[key] || null;
}

/** 긴 작업은 경과 시간과 실제 생성량 중 더 확실한 신호만큼만 자기 구간 안에서 전진한다. */
export function estimateProgressWithinRange({ range, elapsedMs = 0, completed = false, workDone = 0, workTotal = 0 }) {
  if (!range) return null;
  const [start, end, expectedMs = 30000] = range;
  if (completed) return end;
  const timeRatio = 1 - Math.exp(-Math.max(0, elapsedMs) / Math.max(1, expectedMs));
  const workRatio = workTotal > 0 ? Math.min(1, Math.max(0, workDone) / workTotal) : 0;
  // 실행 중에는 구간 끝을 남겨 둔다. 완료 이벤트만 그 작업의 전체 몫을 확정한다.
  const fraction = Math.min(0.9, Math.max(0.03, timeRatio * 0.82, workRatio * 0.9));
  return start + (end - start) * fraction;
}

function beginProgressStep(event) {
  if (!progressContext) progressContext = createProgressContext();
  if (event.key === 's0') progressContext.profile = 'staged';
  if (progressContext.profile === 'staged' && ['budget', 'stage1', 'llm'].includes(event.key)) {
    progressContext.profile = 'fallback';
  }
  if (event.key?.startsWith('s4:') && !progressContext.issueKeys.includes(event.key)) {
    progressContext.issueKeys.push(event.key);
  }
  const range = progressRangeForStep(event.key, progressContext);
  const outputTokens = Number(String(event.detail || '').match(/출력\s+([\d,]+)\s*토큰/)?.[1]?.replaceAll(',', '')) || 0;
  running = {
    key: event.key,
    startedAt: Date.now(),
    detail: event.detail || '',
    tickedAt: 0,
    range,
    workDone: 0,
    // 한국어 JSON 출력은 토큰당 문자 수 편차가 커서 보수적인 환산값을 쓴다.
    workTotal: outputTokens ? outputTokens * 2 : (event.key === 'llm' ? 16000 : 0)
  };
  const estimate = estimateProgressWithinRange({ range });
  if (estimate != null) setOverallProgress(estimate);
}

function completeProgressStep(event) {
  if (!progressContext) progressContext = createProgressContext();
  if (event.key === 's0') progressContext.profile = 'staged';
  if (progressContext.profile === 'staged' && ['budget', 'stage1', 'llm'].includes(event.key)) {
    progressContext.profile = 'fallback';
  }
  if (event.meta?.totalIssues) progressContext.totalIssues = event.meta.totalIssues;
  if (event.key?.startsWith('s4:') && !progressContext.issueKeys.includes(event.key)) {
    progressContext.issueKeys.push(event.key);
  }
  const range = progressRangeForStep(event.key, progressContext);
  const estimate = estimateProgressWithinRange({ range, completed: true });
  if (estimate != null) setOverallProgress(estimate);
}

function updateRunningProgress(elapsedMs = Date.now() - (running?.startedAt || Date.now())) {
  if (!running?.range) return;
  const estimate = estimateProgressWithinRange({
    range: running.range,
    elapsedMs,
    workDone: running.workDone,
    workTotal: running.workTotal
  });
  if (estimate != null) setOverallProgress(estimate);
}

function parseGeneratedChars(detail) {
  const match = String(detail || '').match(/([\d,]+)자/);
  return match ? Number(match[1].replaceAll(',', '')) : null;
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

export default { initReviewTrace, resetReviewTrace, startReviewTrace, pushTraceEvent, finishReviewTrace, renderTraceFromHistory, showTraceFallback };
