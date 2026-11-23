// public/js/workspaceLayout.js - 3분할 작업 영역: 좌우 도크의 폭 조절·접기, 우측 탭(스튜디오/이력) 전환
// 다른 모듈은 showDockTab / hideDockTab / isDockTabActive만 쓴다. 초기화 전이나 DOM이 없으면 아무 일도 하지 않는다.

const STORAGE_KEY = 'legalReviewer.workspace.v1';
const DESKTOP_QUERY = '(min-width: 1100px)';
const RAIL = 44;
// 최소 폭의 합(280 + 320 + 420)이 데스크톱 기준 폭(1100)보다 작아야 중앙이 항상 읽을 만한 폭을 유지한다.
const MIN_CENTER = 420;
const KEY_STEP = 24;
const LIMITS = {
  left: { min: 280, max: 640, def: 400 },
  right: { min: 320, max: 900, def: 480 }
};

const layout = { leftW: LIMITS.left.def, rightW: LIMITS.right.def, leftCollapsed: false, rightCollapsed: true, tab: 'history' };
let els = null;
let desktop = null;

const TAB_PANES = { studio: 'studio-drawer', history: 'history-drawer' };
const TAB_BUTTONS = { studio: 'btn-open-studio', history: 'btn-open-history' };

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (Number.isFinite(saved.leftW)) layout.leftW = saved.leftW;
    if (Number.isFinite(saved.rightW)) layout.rightW = saved.rightW;
    if (typeof saved.leftCollapsed === 'boolean') layout.leftCollapsed = saved.leftCollapsed;
  } catch { /* 저장소를 쓸 수 없어도 기본 배치로 동작한다. */ }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ leftW: layout.leftW, rightW: layout.rightW, leftCollapsed: layout.leftCollapsed }));
  } catch { /* 저장 실패는 무시한다. */ }
}

const isCollapsed = side => layout[`${side}Collapsed`];
const other = side => (side === 'left' ? 'right' : 'left');
// 화면에 실제로 적용 중인 폭. 창이 좁아 줄어들어도 사용자가 정한 값(layout.*W)은 건드리지 않는다.
const applied = { left: LIMITS.left.def, right: RAIL };

/** 중앙 영역에 최소 폭을 남기는 범위 안으로 폭을 맞춘다. */
function fitWidth(side, preferred, otherWidth) {
  const { min, max } = LIMITS[side];
  const room = els.workspace.clientWidth - otherWidth - MIN_CENTER;
  return Math.round(Math.max(min, Math.min(max, room, preferred)));
}

function computeWidths() {
  const rightPreferred = isCollapsed('right') ? RAIL : Math.min(layout.rightW, LIMITS.right.max);
  applied.left = isCollapsed('left') ? RAIL : fitWidth('left', layout.leftW, rightPreferred);
  applied.right = isCollapsed('right') ? RAIL : fitWidth('right', layout.rightW, applied.left);
}

function apply() {
  if (!els) return;
  desktop = window.matchMedia(DESKTOP_QUERY).matches;
  const { workspace } = els;

  if (desktop) {
    computeWidths();
    workspace.style.setProperty('--left-col', `${applied.left}px`);
    workspace.style.setProperty('--right-col', `${applied.right}px`);
  } else {
    workspace.style.removeProperty('--left-col');
    workspace.style.removeProperty('--right-col');
  }

  for (const side of ['left', 'right']) {
    const collapsed = isCollapsed(side);
    const label = side === 'left' ? '입력 패널' : '보조 패널';
    els[side].classList.toggle('is-collapsed', collapsed);
    els[`${side}Toggle`].setAttribute('aria-expanded', String(!collapsed));
    els[`${side}Toggle`].title = `${label} ${collapsed ? '펼치기' : '접기'}`;
    els[`${side}Toggle`].setAttribute('aria-label', `${label} ${collapsed ? '펼치기' : '접기'}`);
    els[`${side}ToggleIcon`].textContent = desktop
      ? `${side}_panel_${collapsed ? 'open' : 'close'}`
      : (collapsed ? 'expand_more' : 'expand_less');

    const handle = els[`${side}Resizer`];
    handle.setAttribute('aria-valuemin', String(LIMITS[side].min));
    handle.setAttribute('aria-valuemax', String(LIMITS[side].max));
    handle.setAttribute('aria-valuenow', String(applied[side]));
  }

  for (const [name, paneId] of Object.entries(TAB_PANES)) {
    const active = !layout.rightCollapsed && layout.tab === name;
    document.getElementById(paneId)?.classList.toggle('open', active);
    document.getElementById(TAB_BUTTONS[name])?.setAttribute('aria-selected', String(active));
  }
}

/** 사용자가 직접 정한 폭. 이때만 저장 값을 바꾼다. */
function setWidth(side, value) {
  const otherWidth = isCollapsed(other(side)) ? RAIL : applied[other(side)];
  layout[`${side}W`] = fitWidth(side, value, otherWidth);
  apply();
}

function toggleSide(side) {
  layout[`${side}Collapsed`] = !isCollapsed(side);
  apply();
  save();
}

function bindResizer(side) {
  const handle = els[`${side}Resizer`];

  handle.addEventListener('pointerdown', event => {
    if (!desktop || event.button > 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const rect = els.workspace.getBoundingClientRect();
    els.workspace.classList.add('is-resizing');
    handle.classList.add('active');

    const move = e => setWidth(side, side === 'left' ? e.clientX - rect.left : rect.right - e.clientX);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      els.workspace.classList.remove('is-resizing');
      handle.classList.remove('active');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });

  handle.addEventListener('keydown', event => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault();
    const step = (event.shiftKey ? KEY_STEP * 4 : KEY_STEP) * (event.key === grow ? 1 : -1);
    setWidth(side, applied[side] + step);
    save();
  });

  handle.addEventListener('dblclick', () => {
    setWidth(side, LIMITS[side].def);
    save();
  });
}

export function initWorkspaceLayout() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  els = {
    workspace,
    left: document.getElementById('left-dock'),
    right: document.getElementById('right-dock'),
    leftToggle: document.getElementById('btn-toggle-left'),
    rightToggle: document.getElementById('btn-toggle-right'),
    leftResizer: document.getElementById('resizer-left'),
    rightResizer: document.getElementById('resizer-right')
  };
  if (Object.values(els).some(el => !el)) { els = null; return; }
  els.leftToggleIcon = els.leftToggle.querySelector('.material-symbols-outlined');
  els.rightToggleIcon = els.rightToggle.querySelector('.material-symbols-outlined');

  readSaved();
  els.leftToggle.addEventListener('click', () => toggleSide('left'));
  els.rightToggle.addEventListener('click', () => toggleSide('right'));
  bindResizer('left');
  bindResizer('right');
  window.addEventListener('resize', apply);
  window.matchMedia(DESKTOP_QUERY).addEventListener?.('change', apply);
  apply();
}

/** 우측 도크를 펼쳐 해당 탭을 보여준다. */
export function showDockTab(name) {
  if (!els || !TAB_PANES[name]) return;
  layout.tab = name;
  layout.rightCollapsed = false;
  apply();
  if (!desktop) els.right.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 해당 탭이 열려 있을 때만 우측 도크를 접는다. 다른 탭을 보고 있으면 건드리지 않는다. */
export function hideDockTab(name) {
  if (!els || layout.tab !== name || layout.rightCollapsed) return;
  layout.rightCollapsed = true;
  apply();
}

export function isDockTabActive(name) {
  return Boolean(els) && !layout.rightCollapsed && layout.tab === name;
}
