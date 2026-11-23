// public/js/documentViewer.js - 조문/판례/유권해석/별표 상세 모달 뷰어
import { splitLegalParagraphs } from './authorityExcerpt.js';

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
        <span><strong>선고일자:</strong> ${escapeHtml(precedent.judgeDate)}</span> |
        <span><strong>사건종류:</strong> ${escapeHtml(precedent.caseType || '일반')}</span> |
        <span><strong>판결유형:</strong> ${escapeHtml(precedent.judgeType || '판결')}</span>
      </div>
      ${legalSection('판시사항', precedent.holding)}
      ${legalSection('판결요지', precedent.summary)}
      ${officialLink('precInfoP.do', 'precSeq', precedent.id)}
    </div>
  `;

  modalBody.innerHTML = html;
  modal.classList.remove('hidden');
}

export function openInterpretationViewer(interpretation) {
  if (!modal || !interpretation) return;

  modalTitle.textContent = `[유권해석] ${interpretation.orgName || '법제처'} ${interpretation.title || ''}`;
  const meta = [['안건번호', interpretation.itemNo], ['회신일자', interpretation.replyDate]].filter(([, value]) => value);

  modalBody.innerHTML = `
    <div class="viewer-precedent-container">
      ${meta.length ? `<div style="margin-bottom: 14px; padding: 10px; background: #F8FAFC; border-radius: 6px; font-size: 13px;">
        ${meta.map(([label, value]) => `<span><strong>${label}:</strong> ${escapeHtml(value)}</span>`).join(' | ')}
      </div>` : ''}
      ${legalSection('질의요지', interpretation.question)}
      ${legalSection('회답', interpretation.answer)}
      ${legalSection('이유', interpretation.reason)}
      ${officialLink('expcInfoP.do', 'expcSeq', interpretation.id)}
    </div>
  `;
  modal.classList.remove('hidden');
}

function legalSection(title, text) {
  const paragraphs = splitLegalParagraphs(text);
  return `<section class="viewer-legal-section">
    <h4>【 ${title} 】</h4>
    ${paragraphs.length
      ? paragraphs.map(p => `<p>${p.no ? `<span class="viewer-legal-no">[${p.no}]</span> ` : ''}${escapeHtml(p.text)}</p>`).join('')
      : '<p class="viewer-legal-empty">내용 없음</p>'}
  </section>`;
}

// API 상세 링크(/DRF/...)는 인증키 없이 열면 인증 실패 화면이 나오므로 공개 상세 페이지로 연결한다.
function officialLink(page, param, id) {
  if (!/^\d+$/.test(String(id || ''))) return '';
  const href = `https://www.law.go.kr/LSW/${page}?${param}=${id}`;
  return `<div style="margin-top: 20px; text-align: right;">
    <a href="${href}" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-outline">국가법령정보센터 원문 보기 ↗</a>
  </div>`;
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
  openInterpretationViewer,
  closeViewer
};
