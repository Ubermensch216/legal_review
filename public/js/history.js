// public/js/history.js - 검토 이력 관리 클라이언트 모듈
import { renderWorkbench } from './lawWorkbench.js';

const drawer = document.getElementById('history-drawer');
const btnOpen = document.getElementById('btn-open-history');
const btnClose = document.getElementById('btn-close-history');
const btnClearAll = document.getElementById('btn-clear-all-history');
const historyListEl = document.getElementById('history-list');
const countBadge = document.getElementById('badge-history-count');

export function initHistoryDrawer() {
  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      openHistoryDrawer();
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      closeHistoryDrawer();
    });
  }

  if (btnClearAll) {
    btnClearAll.addEventListener('click', async () => {
      if (confirm('저장된 모든 검토 이력을 삭제하시겠습니까?')) {
        await clearAllHistory();
      }
    });
  }

  // 초기 이력 카운트 조회
  refreshHistoryList();
}

export function openHistoryDrawer() {
  if (!drawer) return;
  drawer.classList.add('open');
  refreshHistoryList();
}

export function closeHistoryDrawer() {
  if (drawer) drawer.classList.remove('open');
}

/**
 * 서버에서 이력 목록 가져와서 렌더링
 */
export async function refreshHistoryList() {
  try {
    const res = await fetch('/api/law/history');
    if (!res.ok) return;

    const data = await res.json();
    const items = data.items || [];

    if (countBadge) {
      countBadge.textContent = items.length;
    }

    if (!historyListEl) return;

    if (items.length === 0) {
      historyListEl.innerHTML = '<p class="placeholder-text">저장된 검토 이력이 없습니다.</p>';
      return;
    }

    let html = '';
    items.forEach(item => {
      const dateStr = new Date(item.created_at || item.createdAt).toLocaleString('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const presetName = getPresetName(item.preset);
      const title = item.documentName ? `[문서] ${item.documentName}` : item.query;

      html += `
        <div class="history-card" data-id="${item.id}">
          <div class="history-card-top">
            <span class="badge badge-gov">${escapeHtml(presetName)}</span>
            <span class="history-date">${dateStr}</span>
          </div>
          <div class="history-query-text">${escapeHtml(title)}</div>
          <div class="history-summary-snippet">${escapeHtml(item.summary || '')}</div>
          <div class="history-meta-row">
            <span class="history-law-tag">${escapeHtml(item.targetLaw || '일반 법령')}</span>
            <div class="history-card-actions">
              <button class="btn btn-xs btn-outline btn-restore-history" data-id="${item.id}" title="검토 결과 화면에 복원">
                <span class="material-symbols-outlined" style="font-size:13px;">restore</span>
                <span>불러오기</span>
              </button>
              <button class="btn btn-xs btn-remove-history" data-id="${item.id}" title="이력 삭제" style="color:#DC2626; background:transparent; border:none; padding:3px 6px;">
                <span class="material-symbols-outlined" style="font-size:15px;">delete</span>
              </button>
            </div>
          </div>
        </div>
      `;
    });

    historyListEl.innerHTML = html;

    // 이벤트 바인딩
    historyListEl.querySelectorAll('.btn-restore-history').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        await restoreHistory(id);
      });
    });

    historyListEl.querySelectorAll('.btn-remove-history').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (confirm('이 검토 이력을 삭제하시겠습니까?')) {
          await deleteHistory(id);
        }
      });
    });

  } catch (err) {
    console.error('[History] 이력 로드 실패:', err);
  }
}

/**
 * 특정 이력 복원
 */
async function restoreHistory(id) {
  try {
    const res = await fetch(`/api/law/history/${id}`);
    if (!res.ok) throw new Error('이력 조회 실패');

    const data = await res.json();
    if (data.ok && data.item && data.item.data) {
      renderWorkbench(data.item.data);
      closeHistoryDrawer();

      // 워크벤치 영역으로 스크롤
      const wbSection = document.getElementById('workbench-section');
      if (wbSection) wbSection.scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    alert(`이력 복원 중 오류가 발생했습니다: ${err.message}`);
  }
}

/**
 * 특정 이력 삭제
 */
async function deleteHistory(id) {
  try {
    const res = await fetch(`/api/law/history/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await refreshHistoryList();
    }
  } catch (err) {
    alert('삭제 실패: ' + err.message);
  }
}

/**
 * 전체 이력 삭제
 */
async function clearAllHistory() {
  try {
    const res = await fetch('/api/law/history', { method: 'DELETE' });
    if (res.ok) {
      await refreshHistoryList();
    }
  } catch (err) {
    alert('전체 삭제 실패: ' + err.message);
  }
}

function getPresetName(preset) {
  const map = {
    compliance: '적법성/규제',
    contract_risk: '계약서 리스크',
    ordinance_conflict: '조례 충돌',
    admin_dispute: '행정처분',
    privacy_security: '개인정보/보안',
    labor_hr: '인사/노무'
  };
  return map[preset] || '법령검토';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default {
  initHistoryDrawer,
  openHistoryDrawer,
  closeHistoryDrawer,
  refreshHistoryList
};
