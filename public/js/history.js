// public/js/history.js - 브라우저 IndexedDB 기반 영구 검토 이력 관리 모듈
import { renderWorkbench } from './lawWorkbench.js';
import { renderTraceFromHistory } from './reviewTrace.js';
import {
  saveReviewToIndexedDB,
  getAllReviewsFromIndexedDB,
  getReviewByIdFromIndexedDB,
  deleteReviewFromIndexedDB,
  clearAllReviewsFromIndexedDB
} from './historyDb.js';

const drawer = document.getElementById('history-drawer');
const btnOpen = document.getElementById('btn-open-history');
const btnClose = document.getElementById('btn-close-history');
const btnClearAll = document.getElementById('btn-clear-all-history');
const historyListEl = document.getElementById('history-list');
const countBadge = document.getElementById('badge-history-count');

export async function initHistoryDrawer() {
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

  // 드로어 바깥을 클릭하면 닫는다. 열기 버튼 자체를 누른 경우에는 즉시 닫히지 않도록 제외한다.
  document.addEventListener('click', (event) => {
    if (!drawer?.classList.contains('open')) return;
    if (drawer.contains(event.target) || btnOpen?.contains(event.target)) return;
    closeHistoryDrawer();
  });

  if (btnClearAll) {
    btnClearAll.addEventListener('click', async () => {
      if (confirm('브라우저에 영구 저장된 모든 검토 이력을 완전히 삭제하시겠습니까?')) {
        await clearAllHistory();
      }
    });
  }

  // 초기 IndexedDB 이력 동기화 및 카운트 갱신
  await syncWithServerAndRefresh();
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
 * 신규 검토 완료 시 IndexedDB에 즉시 영구 저장
 * @param {object} workbenchPayload - 전체 워크벤치 결과 데이터
 */
export async function addHistoryRecord(workbenchPayload) {
  try {
    const meta = workbenchPayload.meta || {};
    const review = workbenchPayload.review || {};

    const record = {
      id: `lr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      createdAt: new Date().toISOString(),
      preset: meta.preset || 'compliance',
      query: meta.query || (meta.documentName ? `[문서] ${meta.documentName}` : '법령 종합 검토'),
      targetLaw: meta.primaryLawName || '관련 법령',
      summary: review.summary || '종합 검토가 완료되었습니다.',
      data: workbenchPayload
    };

    // 1. 브라우저 IndexedDB 영구 저장
    await saveReviewToIndexedDB(record);
    console.log('[History] Saved review to browser IndexedDB:', record.id);

    // 2. 서버 DB에도 백업
    fetch('/api/law/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    }).catch(e => console.warn('[History] Server backup skipped:', e));

    // 3. UI 배지 갱신 및 애니메이션 하이라이트
    await refreshHistoryList(true);
  } catch (err) {
    console.error('[History] Save to IndexedDB error:', err);
  }
}

/**
 * 서버의 기존 이력이 있고 IndexedDB가 비어있을 때 초기 1회 동기화
 */
async function syncWithServerAndRefresh() {
  try {
    const localItems = await getAllReviewsFromIndexedDB();
    if (localItems.length === 0) {
      // 서버에서 기존 이력 조회
      const res = await fetch('/api/law/history');
      if (res.ok) {
        const data = await res.json();
        const serverItems = data.items || [];
        for (const item of serverItems) {
          await saveReviewToIndexedDB({
            id: item.id,
            createdAt: item.created_at || item.createdAt || new Date().toISOString(),
            preset: item.preset || 'compliance',
            query: item.query || '법령 검토',
            targetLaw: item.targetLaw || '관련 법령',
            summary: item.summary || '',
            data: item.data || item
          });
        }
      }
    }
  } catch (err) {
    console.warn('[History] Initial server sync error:', err);
  } finally {
    await refreshHistoryList();
  }
}

/**
 * IndexedDB에서 이력 목록을 읽어와 화면 렌더링
 * @param {boolean} highlight - 카운트 배지 펄스 애니메이션 여부
 */
export async function refreshHistoryList(highlight = false) {
  try {
    const items = await getAllReviewsFromIndexedDB();

    if (countBadge) {
      countBadge.textContent = items.length;
      if (items.length > 0) {
        countBadge.style.backgroundColor = '#1E3A8A';
        countBadge.style.color = '#FFFFFF';
      } else {
        countBadge.style.backgroundColor = '#E2E8F0';
        countBadge.style.color = '#334155';
      }

      if (highlight) {
        countBadge.style.transform = 'scale(1.35)';
        countBadge.style.transition = 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
        setTimeout(() => {
          countBadge.style.transform = 'scale(1)';
        }, 300);
      }
    }

    if (!historyListEl) return;

    if (items.length === 0) {
      historyListEl.innerHTML = `
        <div style="text-align: center; padding: 40px 16px; color: #94A3B8;">
          <span class="material-symbols-outlined" style="font-size: 40px; margin-bottom: 8px; color: #CBD5E1;">inventory_2</span>
          <p style="font-size: 13.5px; font-weight: 500;">저장된 검토 이력이 없습니다.</p>
          <p style="font-size: 11.5px; margin-top: 4px;">검토를 실행하면 브라우저 IndexedDB에 영구 보관됩니다.</p>
        </div>
      `;
      return;
    }

    let html = '';
    items.forEach(item => {
      const dateStr = new Date(item.createdAt || item.created_at).toLocaleString('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const presetName = getPresetName(item.preset);
      const title = item.query || (item.documentName ? `[문서] ${item.documentName}` : '법령 종합 검토');

      html += `
        <div class="history-card" data-id="${item.id}">
          <div class="history-card-top">
            <span class="badge badge-gov">${escapeHtml(presetName)}</span>
            <span class="history-date">${dateStr}</span>
          </div>
          <div class="history-query-text">${escapeHtml(title)}</div>
          <div class="history-summary-snippet">${escapeHtml(item.summary || '')}</div>
          <div class="history-meta-row">
            <span class="history-law-tag">${escapeHtml(item.targetLaw || '관련 법령')}</span>
            <div class="history-card-actions">
              <button class="btn btn-xs btn-primary btn-restore-history" data-id="${item.id}" title="검토 결과 화면에 복원" style="display:inline-flex; align-items:center; gap:4px; padding:4px 8px;">
                <span class="material-symbols-outlined" style="font-size:14px;">restore</span>
                <span>불러오기</span>
              </button>
              <button class="btn btn-xs btn-remove-history" data-id="${item.id}" title="이력 영구 삭제" style="color:#DC2626; background:transparent; border:none; padding:3px 6px; cursor:pointer;">
                <span class="material-symbols-outlined" style="font-size:16px;">delete</span>
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
        if (confirm('이 검토 이력을 브라우저에서 영구 삭제하시겠습니까?')) {
          await deleteHistory(id);
        }
      });
    });

  } catch (err) {
    console.error('[History] IndexedDB 이력 로드 실패:', err);
  }
}

/**
 * 특정 이력 복원
 */
async function restoreHistory(id) {
  try {
    const item = await getReviewByIdFromIndexedDB(id);
    let data = item?.data || item;

    // 서버 목록에서 동기화된 기록에는 요약만 들어 있다. 검토 본문은 서버에서 가져와야 한다.
    if (!data?.review) {
      const res = await fetch(`/api/law/history/${encodeURIComponent(id)}`);
      const full = res.ok ? await res.json() : null;
      if (full?.item?.data?.review) data = full.item.data;
    }
    if (!data?.review) throw new Error('이력을 찾을 수 없습니다.');

    // 서버가 이력 ID를 payload에 넣기 전에 직렬화한 기록도 있다. 그때는 행 ID가 곧 서버 이력 ID다.
    // 이 값이 없으면 외부 전문가 질의 탭이 어느 검토를 대상으로 할지 알 수 없다.
    renderWorkbench({ ...data, historyId: data.historyId || id });
    // 그 검토가 어떤 추론 과정을 거쳤는지도 같은 폴딩 패널에 되살린다.
    renderTraceFromHistory(data.progressTrace);
    closeHistoryDrawer();

    // 워크벤치 영역으로 스크롤
    const wbSection = document.getElementById('workbench-section');
    if (wbSection) wbSection.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    alert(`이력 복원 중 오류가 발생했습니다: ${err.message}`);
  }
}

/**
 * 특정 이력 삭제
 */
async function deleteHistory(id) {
  try {
    // 1. IndexedDB에서 삭제
    await deleteReviewFromIndexedDB(id);

    // 2. 서버 DB 백업도 삭제 시도
    fetch(`/api/law/history/${id}`, { method: 'DELETE' }).catch(() => {});

    // 3. UI 새로고침
    await refreshHistoryList();
  } catch (err) {
    alert('삭제 실패: ' + err.message);
  }
}

/**
 * 전체 이력 삭제
 */
async function clearAllHistory() {
  try {
    // 1. IndexedDB 전체 삭제
    await clearAllReviewsFromIndexedDB();

    // 2. 서버 DB 백업도 전체 삭제
    fetch('/api/law/history', { method: 'DELETE' }).catch(() => {});

    // 3. UI 새로고침
    await refreshHistoryList();
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
  refreshHistoryList,
  addHistoryRecord
};
