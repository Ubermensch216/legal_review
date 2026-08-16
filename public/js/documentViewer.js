// public/js/documentViewer.js - 조문/판례/별표 상세 모달 뷰어

const modal = document.getElementById('viewer-modal');
const modalTitle = document.getElementById('modal-viewer-title');
const modalBody = document.getElementById('modal-viewer-body');
const btnClose = document.getElementById('btn-close-viewer');

export function initDocumentViewer() {
  if (btnClose) {
    btnClose.addEventListener('click', closeViewer);
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeViewer();
    });
  }
}

export function openArticleViewer(lawName, article) {
  if (!modal || !article) return;

  modalTitle.textContent = `${lawName} 제${article.fullArticleNo || article.articleNo}조 (${article.title || '제목 없음'})`;
  
  let html = `
    <div class="viewer-article-container">
      <div class="viewer-meta-bar" style="margin-bottom: 16px; padding: 10px; background: #F1F5F9; border-radius: 6px; font-size: 13px;">
        <span><strong>법령명:</strong> ${lawName}</span> | 
        <span><strong>시행일자:</strong> ${article.enforceDate || '현행'}</span>
      </div>
      <div class="viewer-article-body" style="font-size: 14.5px; line-height: 1.8; white-space: pre-wrap; color: #1E293B;">
        ${escapeHtml(article.content)}
      </div>
    </div>
  `;

  modalBody.innerHTML = html;
  modal.classList.remove('hidden');
}

export function openPrecedentViewer(precedent) {
  if (!modal || !precedent) return;

  modalTitle.textContent = `[판례] ${precedent.courtName || ''} ${precedent.caseNo} ${precedent.caseName}`;

  let html = `
    <div class="viewer-precedent-container">
      <div style="margin-bottom: 14px; padding: 10px; background: #F8FAFC; border-radius: 6px; font-size: 13px;">
        <span><strong>선고일자:</strong> ${precedent.judgeDate}</span> | 
        <span><strong>사건종류:</strong> ${precedent.caseType || '일반'}</span> |
        <span><strong>판결유형:</strong> ${precedent.judgeType || '판결'}</span>
      </div>
      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 14px; font-weight: 700; color: #1E3A8A; margin-bottom: 6px;">【 판시사항 】</h4>
        <p style="font-size: 14px; line-height: 1.7; background: #FFFBEB; padding: 12px; border-radius: 6px;">${escapeHtml(precedent.holding || '내용 없음')}</p>
      </div>
      <div>
        <h4 style="font-size: 14px; font-weight: 700; color: #1E3A8A; margin-bottom: 6px;">【 판결요지 】</h4>
        <p style="font-size: 14px; line-height: 1.7; white-space: pre-wrap;">${escapeHtml(precedent.summary || '내용 없음')}</p>
      </div>
      ${precedent.detailUrl ? `
        <div style="margin-top: 20px; text-align: right;">
          <a href="${precedent.detailUrl}" target="_blank" class="btn btn-xs btn-outline">국가법령정보센터 원문 보기 ↗</a>
        </div>
      ` : ''}
    </div>
  `;

  modalBody.innerHTML = html;
  modal.classList.remove('hidden');
}

export function closeViewer() {
  if (modal) modal.classList.add('hidden');
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
  initDocumentViewer,
  openArticleViewer,
  openPrecedentViewer,
  closeViewer
};
