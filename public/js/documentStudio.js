// public/js/documentStudio.js - 보고서 스튜디오 (비주얼 공문서 에디터 & 마크다운 소스 모드)
import { state } from './state.js';
import { renderReasoningOpinion } from './reasoningView.js';
import { expandReferences, explainDiagnostic } from './learningIssues.js';

const drawer = document.getElementById('studio-drawer');
const btnOpen = document.getElementById('btn-open-studio');
const btnClose = document.getElementById('btn-close-studio');
const titleInput = document.getElementById('report-title-input');
const visualEditor = document.getElementById('studio-visual-editor');
const sourceEditor = document.getElementById('studio-source-editor');
const btnModeVisual = document.getElementById('btn-mode-visual');
const btnModeSource = document.getElementById('btn-mode-source');
const exportBtns = document.querySelectorAll('.btn-export');

let currentMode = 'visual'; // 'visual' | 'source'
let lastReviewPayload = null;
let sourceAtModeChange = '';

export function initDocumentStudio() {
  if (btnOpen) {
    btnOpen.addEventListener('click', () => openStudio());
  }
  if (btnClose) {
    btnClose.addEventListener('click', () => closeStudio());
  }

  // 스튜디오 바깥을 클릭하면 닫는다. 상단 열기 버튼 클릭은 예외로 둔다.
  document.addEventListener('click', (event) => {
    if (!drawer?.classList.contains('open')) return;
    // 열기 버튼의 클릭도 document까지 전파된다. 이 클릭을 바깥 클릭으로 처리하면
    // openStudio가 드로어를 연 직후 같은 이벤트에서 닫아 버린다.
    if (drawer.contains(event.target) || event.target.closest?.('[data-studio-trigger]')) return;
    closeStudio();
  });

  // 모드 전환 버튼
  if (btnModeVisual && btnModeSource) {
    btnModeVisual.addEventListener('click', () => switchMode('visual'));
    btnModeSource.addEventListener('click', () => switchMode('source'));
  }

  // 내보내기 버튼 바인딩
  exportBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const format = btn.getAttribute('data-format');
      exportReport(format);
    });
  });
}

/**
 * 스튜디오 열기
 * @param {string} initialText - 마크다운 텍스트
 * @param {string} title - 보고서 제목
 * @param {object} reviewData - 전체 워크벤치 검토 데이터 (선택)
 */
export function openStudio(initialText = '', title = '', reviewData = null) {
  if (!drawer) return;

  lastReviewPayload = reviewData || state.lastReviewResult;

  if (title) {
    titleInput.value = title;
  } else if (!titleInput.value || lastReviewPayload?.meta?.preset === 'contract_risk') {
    titleInput.value = lastReviewPayload?.meta?.preset === 'contract_risk'
      ? '계약서 법률검토의견서' : '법률검토의견서';
  }

  const rawMd = expandReferences(initialText || lastReviewPayload?.review?.draftOpinion || '', lastReviewPayload || {});
  const reportView = document.getElementById('draft-official-report-view');

  // 의견서 탭에서 보던 전문과 동일한 문서를 편집기에 가져온다.
  if (lastReviewPayload?.review && reportView?.innerHTML.trim()) {
    visualEditor.innerHTML = reportView.innerHTML;
  } else if (lastReviewPayload?.review) {
    visualEditor.innerHTML = buildVisualReportHtml(lastReviewPayload, titleInput.value);
  } else {
    visualEditor.innerHTML = convertMarkdownToVisualHtml(rawMd, titleInput.value);
  }

  sourceEditor.value = visualEditor.innerText.trim() || rawMd;
  sourceAtModeChange = sourceEditor.value;
  currentMode = 'visual';
  switchMode('visual');
  drawer.classList.add('open');
}

export function closeStudio() {
  if (drawer) drawer.classList.remove('open');
}

/** 새 리뷰 시작 시 이전 검토의 편집본도 화면 상태에서 제거한다. */
export function resetStudio() {
  lastReviewPayload = null;
  sourceAtModeChange = '';
  currentMode = 'visual';
  if (titleInput) titleInput.value = '법률검토의견서';
  if (visualEditor) visualEditor.innerHTML = '';
  if (sourceEditor) sourceEditor.value = '';
  if (btnModeVisual && btnModeSource) switchMode('visual');
  closeStudio();
}

/**
 * 에디터 모드 전환 (비주얼 공문서 뷰 ↔ 마크다운 소스 뷰)
 */
function switchMode(mode) {
  if (mode === 'source' && currentMode === 'visual') {
    sourceEditor.value = visualEditor.innerText.trim();
    sourceAtModeChange = sourceEditor.value;
  } else if (mode === 'visual' && currentMode === 'source' && sourceEditor.value !== sourceAtModeChange) {
    visualEditor.innerHTML = convertMarkdownToVisualHtml(sourceEditor.value, titleInput.value);
  }
  currentMode = mode;

  if (mode === 'visual') {
    btnModeVisual.classList.add('active');
    btnModeSource.classList.remove('active');
    sourceEditor.classList.add('hidden');
    visualEditor.classList.remove('hidden');

  } else {
    btnModeSource.classList.add('active');
    btnModeVisual.classList.remove('active');
    visualEditor.classList.add('hidden');
    sourceEditor.classList.remove('hidden');

  }
}

/**
 * 정형화된 비주얼 공문서 서식 HTML 생성기
 */
function buildVisualReportHtml(data, reportTitle) {
  const { review, officialEvidence, meta } = data;
  const lawName = meta?.primaryLawName || '관련 법령';
  const query = meta?.query || '요청 사안에 관한 법적 검토';
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  const basisList = (review.legalBasis || []).map(b => ({ ...b, relevance: `[${b.verificationStatus === 'VERIFIED' ? '조문 존재 확인' : '미검증'}] ${b.relevance || ''}${b.verificationNote ? ' — ' + b.verificationNote : ''}` }));

  const recommendations = review.recommendations || [];

  return `
    <div class="visual-report-container" style="line-height: 1.8;">
      <div role="note">${escapeHtml((data.reliability?.warnings || []).map(w => explainDiagnostic(w, data)).join(' / '))}</div>
      <!-- 헤더 -->
      <div style="text-align: center; border-bottom: 2px solid #1E3A8A; padding-bottom: 16px; margin-bottom: 22px;">
        <h2 style="font-size: 21px; font-weight: 800; color: #1E3A8A; letter-spacing: 2px; margin-bottom: 12px;">${escapeHtml(reportTitle || '법 률 검 토 의 견 서')}</h2>
        
        <table class="legal-table" style="font-size: 13px; margin: 0 auto; width: 100%;">
          <tbody>
            <tr>
              <td style="background:#F8FAFC; font-weight:700; width:15%; text-align:center;">문서 번호</td>
              <td style="width:35%;">LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}</td>
              <td style="background:#F8FAFC; font-weight:700; width:15%; text-align:center;">검토 일자</td>
              <td style="width:35%;">${todayStr}</td>
            </tr>
            <tr>
              <td style="background:#F8FAFC; font-weight:700; text-align:center;">검토 대상</td>
              <td colspan="3">${escapeHtml(query)}</td>
            </tr>
            <tr>
              <td style="background:#F8FAFC; font-weight:700; text-align:center;">주요 법령</td>
              <td colspan="3"><strong style="color:#1E3A8A;">${escapeHtml(lawName)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 1. 검토 배경 -->
      <div style="margin-bottom: 22px;">
        <h3 style="font-size: 15px; font-weight: 700; color: #1E3A8A; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px; margin-bottom: 10px;">
          1. 검토 배경 및 질의 요지
        </h3>
        <p style="font-size: 14px; color: #334155; margin-left: 6px;">
          • ${escapeHtml(cleanText(review.facts || query))}
        </p>
      </div>

      <!-- 2. 법률적 검토의견 -->
      <div style="margin-bottom: 22px;">
        <h3 style="font-size: 15px; font-weight: 700; color: #1E3A8A; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px; margin-bottom: 10px;">
          2. 법률적 쟁점 및 심층 검토 의견
        </h3>
        ${review.reasoning?.issues?.length
          ? renderReasoningOpinion(review.reasoning, review, { report: true })
          : `<div style="font-size: 14px; line-height: 1.85; color: #1E293B; background: #F8FAFC; padding: 16px 20px; border-radius: 6px; border-left: 3px solid #2563EB;">${escapeHtml(cleanText(expandReferences(review.legalOpinion || '', data))).replace(/\n/g, '<br>')}</div>`}
      </div>

      <!-- 3. 리스크 평가 및 보완 조치 사항 -->
      <div style="margin-bottom: 22px;">
        <h3 style="font-size: 15px; font-weight: 700; color: #1E3A8A; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px; margin-bottom: 10px;">
          3. 리스크 평가 및 보완 조치 사항
        </h3>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          ${recommendations.map((rec, i) => `
            <div style="display: flex; align-items: flex-start; gap: 10px; background: #FFFFFF; border: 1px solid #E2E8F0; padding: 10px 14px; border-radius: 6px;">
              <span style="background:#1E3A8A; color:#FFF; font-size:11px; font-weight:700; width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${i + 1}</span>
              <span style="font-size: 13.5px; color: #1E293B;">${escapeHtml(cleanText(rec))}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 4. 관련 법령 및 조문 근거 (마지막 배치) -->
      <div style="margin-bottom: 22px;">
        <h3 style="font-size: 15px; font-weight: 700; color: #1E3A8A; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px; margin-bottom: 10px;">
          4. 관련 법령 및 조문 근거표
        </h3>
        <div class="table-responsive">
          <table class="legal-table">
            <thead>
              <tr>
                <th style="width: 25%;">법령명 및 조항</th>
                <th style="width: 30%;">조문 제목</th>
                <th style="width: 45%;">핵심 규정 내용 및 사안 연계</th>
              </tr>
            </thead>
            <tbody>
              ${basisList.map(b => `
                <tr>
                  <td class="cell-bold">${escapeHtml(b.lawName || lawName)} ${escapeHtml(b.articleNo || '')}</td>
                  <td>${escapeHtml(b.title || '')}</td>
                  <td>${escapeHtml(cleanText(b.relevance || ''))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- 면책 고지문 -->
      <div style="margin-top: 24px; padding: 12px; background: #F1F5F9; border-radius: 6px; font-size: 11.5px; color: #64748B; text-align: center;">
        ${escapeHtml(review.disclaimer || '본 의견서는 AI 법령검토 시스템에 의해 작성된 참고자료이며, 최종 법적 분쟁 및 처분에 대해서는 법률전문가의 자문을 받으시기 바랍니다.')}
      </div>
    </div>
  `;
}

/**
 * 마크다운 문자열을 마크다운 특수기호 없이 정돈된 비주얼 공문서 HTML로 변환
 */
function convertMarkdownToVisualHtml(markdownText, reportTitle) {
  if (!markdownText) return '<p class="placeholder-text">보고서 내용이 비어 있습니다.</p>';

  const lines = markdownText.split('\n');
  let html = `<div class="visual-report-container" style="line-height: 1.8;">`;
  html += `<h2 style="font-size: 20px; font-weight: 800; text-align: center; color: #1E3A8A; margin-bottom: 18px;">${escapeHtml(reportTitle || '법 률 검 토 의 견 서')}</h2>`;

  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) {
        html += `</ul>`;
        inList = false;
      }
      continue;
    }

    if (trimmed.startsWith('# ')) {
      if (inList) { html += `</ul>`; inList = false; }
      continue; // 타이틀은 위에서 표시
    } else if (trimmed.startsWith('## ')) {
      if (inList) { html += `</ul>`; inList = false; }
      const text = cleanText(trimmed.replace('## ', ''));
      html += `<h3 style="font-size: 15px; font-weight: 700; color: #1E3A8A; border-bottom: 1px solid #E2E8F0; padding-bottom: 4px; margin-top: 18px; margin-bottom: 10px;">${escapeHtml(text)}</h3>`;
    } else if (trimmed.startsWith('### ')) {
      if (inList) { html += `</ul>`; inList = false; }
      const text = cleanText(trimmed.replace('### ', ''));
      html += `<h4 style="font-size: 14px; font-weight: 700; color: #334155; margin-top: 12px; margin-bottom: 6px;">■ ${escapeHtml(text)}</h4>`;
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        html += `<ul style="padding-left: 20px; margin-bottom: 10px;">`;
        inList = true;
      }
      const text = cleanText(trimmed.substring(2));
      html += `<li style="font-size: 13.5px; color: #1E293B; margin-bottom: 4px;">${escapeHtml(text)}</li>`;
    } else if (trimmed.startsWith('> ')) {
      if (inList) { html += `</ul>`; inList = false; }
      const text = cleanText(trimmed.substring(2));
      html += `<div style="background: #F8FAFC; border-left: 3px solid #3B82F6; padding: 8px 14px; margin: 6px 0; font-size: 13px; color: #475569;">${escapeHtml(text)}</div>`;
    } else {
      if (inList) { html += `</ul>`; inList = false; }
      html += `<p style="font-size: 13.5px; color: #334155; margin-bottom: 8px;">${escapeHtml(cleanText(trimmed))}</p>`;
    }
  }

  if (inList) html += `</ul>`;
  html += `</div>`;
  return html;
}

/**
 * 보고서 생성 및 다운로드 요청
 */
async function exportReport(format) {
  const title = titleInput.value.trim() || '법률검토의견서';
  
  // 현재 에디터 내용 추출 (비주얼 뷰의 innerText 또는 소스 뷰의 value)
  let content = '';
  if (currentMode === 'visual') {
    content = visualEditor.innerText.trim();
  } else {
    content = sourceEditor.value.trim();
  }

  if (!content) {
    alert('보고서 내용이 비어 있습니다.');
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
        reviewData: lastReviewPayload || state.lastReviewResult
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

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
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
  initDocumentStudio,
  openStudio,
  closeStudio,
  resetStudio
};
