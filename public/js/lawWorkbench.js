// public/js/lawWorkbench.js - 워크벤치 3단계 탭 렌더러 및 이벤트 컨트롤러
import { state } from './state.js';
import { openArticleViewer, openPrecedentViewer } from './documentViewer.js';
import { openStudio } from './documentStudio.js';

export function initWorkbenchTabs() {
  const tabs = document.querySelectorAll('.wb-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // 요약 복사 버튼
  const btnCopySummary = document.getElementById('btn-copy-summary');
  if (btnCopySummary) {
    btnCopySummary.addEventListener('click', () => {
      const text = document.getElementById('draft-summary-content').innerText;
      navigator.clipboard.writeText(text).then(() => {
        alert('요약 내용이 클립보드에 복사되었습니다.');
      });
    });
  }

  // 스튜디오로 전송 버튼
  const btnSendStudio = document.getElementById('btn-send-to-studio');
  if (btnSendStudio) {
    btnSendStudio.addEventListener('click', () => {
      if (state.lastReviewResult && state.lastReviewResult.review) {
        const title = `${state.lastReviewResult.meta?.primaryLawName || '법령'} 검토의견서`;
        openStudio(state.lastReviewResult.review.draftOpinion, title);
      }
    });
  }
}

/**
 * 워크벤치 전체 데이터 렌더링
 * @param {object} data - /api/law/workbench 응답 데이터
 */
export function renderWorkbench(data) {
  state.lastReviewResult = data;
  const { review, officialEvidence, impactAndRevisions, meta } = data;

  // 1. Tab 1: 검토 초안 렌더링
  renderDraftTab(review, meta);

  // 2. Tab 2: 공식 근거 렌더링
  renderEvidenceTab(officialEvidence, meta);

  // 3. Tab 3: 개정 및 영향 렌더링
  renderRevisionsTab(impactAndRevisions, meta);
}

function renderDraftTab(review, meta) {
  if (!review) return;

  // 요약
  const summaryEl = document.getElementById('draft-summary-content');
  summaryEl.innerHTML = `<p>${escapeHtml(review.summary)}</p>`;

  // 쟁점 및 리스크 매트릭스
  const matrixEl = document.getElementById('risk-matrix');
  let riskHtml = '';

  if (review.risks && review.risks.length > 0) {
    review.risks.forEach(r => {
      const level = (r.level || 'MEDIUM').toUpperCase();
      riskHtml += `
        <div class="risk-item ${level}">
          <span class="risk-badge">${level}</span>
          <div class="risk-content">
            <strong>${escapeHtml(r.title || '법적 리스크')}</strong>
            <p>${escapeHtml(r.description || '')}</p>
          </div>
        </div>
      `;
    });
  } else {
    riskHtml = '<p class="placeholder-text">발견된 특이 리스크가 없습니다.</p>';
  }
  matrixEl.innerHTML = riskHtml;

  // 법률 검토의견
  const opinionEl = document.getElementById('draft-opinion-content');
  opinionEl.innerHTML = `<p style="line-height: 1.8; color: #1E293B;">${escapeHtml(review.legalOpinion)}</p>`;

  // 보완 권고사항
  const recEl = document.getElementById('draft-rec-content');
  let recHtml = '<ul style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px;">';
  if (review.recommendations && review.recommendations.length > 0) {
    review.recommendations.forEach(rec => {
      recHtml += `<li><strong>${escapeHtml(rec)}</strong></li>`;
    });
  } else {
    recHtml += '<li>권고사항이 없습니다.</li>';
  }
  recHtml += '</ul>';
  recEl.innerHTML = recHtml;

  // 완성형 마크다운 초안
  const fullMdEl = document.getElementById('draft-full-markdown');
  fullMdEl.textContent = review.draftOpinion || '';
}

function renderEvidenceTab(evidence, meta) {
  if (!evidence) return;
  const lawName = meta?.primaryLawName || '관련 법령';

  // 공식 조문 카드
  const artContainer = document.getElementById('evidence-articles');
  let artHtml = '';

  const articles = evidence.articles || [];
  document.getElementById('count-evidence').textContent = `${articles.length + (evidence.precedents?.length || 0)}건`;

  if (articles.length > 0) {
    articles.forEach(art => {
      artHtml += `
        <div class="art-card">
          <div class="art-card-header">
            <div class="art-title">${lawName} 제${art.fullArticleNo || art.articleNo}조 (${escapeHtml(art.title || '')})</div>
            <button class="btn btn-xs btn-outline btn-view-art" data-art="${escapeHtml(JSON.stringify(art))}">전문 팝업 ↗</button>
          </div>
          <div class="art-content">${escapeHtml(art.content)}</div>
        </div>
      `;
    });
  } else {
    artHtml = '<p class="placeholder-text">관련 조문 데이터가 없습니다.</p>';
  }
  artContainer.innerHTML = artHtml;

  // 조문 팝업 이벤트 바인딩
  artContainer.querySelectorAll('.btn-view-art').forEach(btn => {
    btn.addEventListener('click', () => {
      const art = JSON.parse(btn.getAttribute('data-art'));
      openArticleViewer(lawName, art);
    });
  });

  // 판례 및 해석례 카드
  const precContainer = document.getElementById('evidence-precedents');
  let precHtml = '';

  const precedents = evidence.precedents || [];
  const interpretations = evidence.interpretations || [];

  if (precedents.length > 0 || interpretations.length > 0) {
    precedents.forEach(p => {
      precHtml += `
        <div class="prec-card">
          <div class="prec-card-header">
            <div class="prec-title">[판례] ${p.courtName || ''} ${p.caseNo} ${escapeHtml(p.caseName)}</div>
            <button class="btn btn-xs btn-outline btn-view-prec" data-prec="${escapeHtml(JSON.stringify(p))}">판결요지 전문 ↗</button>
          </div>
          <div class="prec-content">
            <strong>판시사항:</strong> ${escapeHtml(p.holding || '내용 없음')}<br>
            <strong>판결요지:</strong> ${escapeHtml(p.summary || '내용 없음')}
          </div>
        </div>
      `;
    });

    interpretations.forEach(e => {
      precHtml += `
        <div class="prec-card" style="border-left: 4px solid #3B82F6;">
          <div class="prec-card-header">
            <div class="prec-title">[유권해석] ${e.orgName || '법제처'} (${e.itemNo || ''}) ${escapeHtml(e.title)}</div>
          </div>
          <div class="prec-content">
            <strong>회답요지:</strong> ${escapeHtml(e.answer || '내용 없음')}
          </div>
        </div>
      `;
    });
  } else {
    precHtml = '<p class="placeholder-text">관련 판례 및 해석례 데이터가 없습니다.</p>';
  }
  precContainer.innerHTML = precHtml;

  // 판례 팝업 이벤트 바인딩
  precContainer.querySelectorAll('.btn-view-prec').forEach(btn => {
    btn.addEventListener('click', () => {
      const prec = JSON.parse(btn.getAttribute('data-prec'));
      openPrecedentViewer(prec);
    });
  });

  // 행정규칙 / 조례 / 별표 카드
  const rulesContainer = document.getElementById('evidence-rules');
  let rulesHtml = '';
  const adminRules = evidence.adminRules || [];
  const ordinances = evidence.ordinances || [];
  const annexes = evidence.annexes || [];

  if (adminRules.length > 0 || ordinances.length > 0 || annexes.length > 0) {
    if (annexes.length > 0) {
      rulesHtml += `<div style="margin-bottom: 8px;"><strong>📌 관련 별표 및 서식:</strong></div>`;
      annexes.forEach(a => {
        rulesHtml += `
          <div class="rule-card" style="margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
            <span>[별표 ${a.annexNo}] ${escapeHtml(a.title)}</span>
            ${a.fileUrl ? `<a href="${a.fileUrl}" target="_blank" class="btn btn-xs btn-outline">서식 다운로드 ↗</a>` : ''}
          </div>
        `;
      });
    }

    if (ordinances.length > 0) {
      rulesHtml += `<div style="margin-top: 12px; margin-bottom: 8px;"><strong>🏛 지자체 자치법규(조례):</strong></div>`;
      ordinances.slice(0, 3).forEach(o => {
        rulesHtml += `
          <div class="rule-card" style="margin-bottom: 6px;">
            <span>[${o.orgName || '지자체'}] ${escapeHtml(o.name)}</span>
          </div>
        `;
      });
    }
  } else {
    rulesHtml = '<p class="placeholder-text">관련 행정규칙이나 별표 서식이 없습니다.</p>';
  }
  rulesContainer.innerHTML = rulesHtml;
}

function renderRevisionsTab(impactData, meta) {
  const container = document.getElementById('impact-items-container');
  const badgeContainer = document.getElementById('impact-summary-badge');
  const dotImpact = document.getElementById('dot-impact');

  if (!impactData || !impactData.impactMap) {
    badgeContainer.innerHTML = '<span class="badge badge-gov">문서 미첨부 (질의 기반 검토)</span>';
    container.innerHTML = '<p class="placeholder-text">첨부문서를 업로드하면 문서 내 조문 인용 충돌 및 적합성 신호가 표시됩니다.</p>';
    dotImpact.className = 'tab-status-dot';
    return;
  }

  const map = impactData.impactMap;
  const isWarning = map.impactSummary?.highRiskCount > 0;

  dotImpact.className = `tab-status-dot ${isWarning ? 'warning' : 'clear'}`;

  badgeContainer.innerHTML = isWarning 
    ? `<span class="badge" style="background:#FEE2E2; color:#DC2626;">경고: 삭제/폐지 조문 충돌 ${map.impactSummary.highRiskCount}건 감지</span>`
    : `<span class="badge" style="background:#DCFCE7; color:#15803D;">정상: 조문 인용 ${map.analyzedReferencesCount}건 적합 확인</span>`;

  let itemsHtml = '';
  if (map.impactItems && map.impactItems.length > 0) {
    map.impactItems.forEach(item => {
      const risk = item.riskLevel || 'NORMAL';
      itemsHtml += `
        <div class="impact-item ${risk}">
          <div>
            <strong>${escapeHtml(item.citation)}</strong>
            <p style="font-size: 12.5px; color: #475569; margin-top: 2px;">${escapeHtml(item.note)}</p>
          </div>
          <span class="badge ${risk === 'HIGH' ? 'badge-danger' : 'badge-gov'}">${risk}</span>
        </div>
      `;
    });
  } else {
    itemsHtml = '<p class="placeholder-text">식별된 조문 인용이 없습니다.</p>';
  }

  container.innerHTML = itemsHtml;
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
  initWorkbenchTabs,
  renderWorkbench
};
