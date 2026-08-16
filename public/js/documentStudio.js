// public/js/documentStudio.js - 보고서 스튜디오 드로어 및 다운로드 관리
import { state } from './state.js';

const drawer = document.getElementById('studio-drawer');
const btnOpen = document.getElementById('btn-open-studio');
const btnClose = document.getElementById('btn-close-studio');
const titleInput = document.getElementById('report-title-input');
const editor = document.getElementById('studio-editor');
const exportBtns = document.querySelectorAll('.btn-export');

export function initDocumentStudio() {
  if (btnOpen) {
    btnOpen.addEventListener('click', () => openStudio());
  }
  if (btnClose) {
    btnClose.addEventListener('click', () => closeStudio());
  }

  // 내보내기 버튼 이벤트 바인딩
  exportBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const format = btn.getAttribute('data-format');
      exportReport(format);
    });
  });
}

export function openStudio(initialText = '', title = '') {
  if (!drawer) return;

  if (initialText) {
    editor.value = initialText;
  }
  if (title) {
    titleInput.value = title;
  } else if (!titleInput.value) {
    titleInput.value = '법률검토의견서';
  }

  drawer.classList.add('open');
}

export function closeStudio() {
  if (drawer) drawer.classList.remove('open');
}

/**
 * 서버에 보고서 생성 및 다운로드 요청
 */
async function exportReport(format) {
  const content = editor.value.trim();
  const title = titleInput.value.trim() || '법률검토의견서';

  if (!content) {
    alert('보고서 본문 내용이 비어 있습니다.');
    return;
  }

  try {
    const res = await fetch('/api/law/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format,
        title,
        content,
        reviewData: state.lastReviewResult
      })
    });

    if (!res.ok) {
      throw new Error(`다운로드 실패: HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.${format === 'md' ? 'md' : format}`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
  } catch (err) {
    alert(`파일 다운로드 중 오류가 발생했습니다: ${err.message}`);
  }
}

export default {
  initDocumentStudio,
  openStudio,
  closeStudio
};
