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
      const summaryEl = document.getElementById('draft-summary-content');
      const text = summaryEl ? summaryEl.innerText : '';
      navigator.clipboard.writeText(text).then(() => {
        alert('핵심 요약 내용이 클립보드에 복사되었습니다.');
      });
    });
  }

  // 스튜디오로 전송 버튼
  const btnSendStudio = document.getElementById('btn-send-to-studio');
  if (btnSendStudio) {
    btnSendStudio.addEventListener('click', () => {
      if (state.lastReviewResult && state.lastReviewResult.review) {
        const title = `${state.lastReviewResult.meta?.primaryLawName || '법령'} 검토의견서`;
        openStudio(state.lastReviewResult.review.draftOpinion, title, state.lastReviewResult);
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

  // 1. Tab 1: 검토 초안 (구조화된 테이블 & 정형화 공문서 뷰)
  renderDraftTab(review, officialEvidence, meta);

  // 2. Tab 2: 공식 근거
  renderEvidenceTab(officialEvidence, meta);

  // 3. Tab 3: 개정 및 영향
  renderRevisionsTab(impactAndRevisions, meta);
}

/**
 * Tab 1: 마크다운 문법 없이 완벽하게 구조화된 HTML 테이블 및 컴포넌트로 렌더링
 */
function renderDraftTab(review, officialEvidence, meta) {
  if (!review) return;

  const lawName = meta?.primaryLawName || '관련 법령';
  const query = meta?.query || '요청 사안에 관한 법적 검토';

  // 1. 핵심 요약 하이라이트 박스
  const summaryEl = document.getElementById('draft-summary-content');
  summaryEl.innerHTML = `
    <div class="summary-highlight-card">
      ${escapeHtml(cleanText(review.summary))}
    </div>
  `;

  // 2. 관련 법령 및 조문 근거 테이블
  const basisEl = document.getElementById('draft-basis-content');
  let basisList = review.legalBasis || [];

  // 만약 review.legalBasis가 비어있으면 officialEvidence.articles에서 보완
  if (basisList.length === 0 && officialEvidence && officialEvidence.articles) {
    basisList = officialEvidence.articles.map(a => ({
      lawName,
      articleNo: `제${a.fullArticleNo || a.articleNo}조`,
      title: a.title,
      relevance: '본 사안의 행위 요건 및 적법성 판단의 직접적 근거 조항임'
    }));
  }

  if (basisList.length > 0) {
    let tableHtml = `
      <div class="table-responsive">
        <table class="legal-table">
          <thead>
            <tr>
              <th style="width: 20%;">구분 (법령명)</th>
              <th style="width: 15%; text-align: center;">해당 조항</th>
              <th style="width: 25%;">조문 제목</th>
              <th style="width: 40%;">적용 및 사안 관련성</th>
            </tr>
          </thead>
          <tbody>
    `;

    basisList.forEach(item => {
      tableHtml += `
        <tr>
          <td class="cell-bold">${escapeHtml(item.lawName || lawName)}</td>
          <td class="cell-center"><span class="badge badge-gov">${escapeHtml(item.articleNo || '')}</span></td>
          <td><strong>${escapeHtml(item.title || '')}</strong></td>
          <td>${escapeHtml(cleanText(item.relevance || '적법성 검토 기준 조항'))}</td>
        </tr>
      `;
    });

    tableHtml += `
          </tbody>
        </table>
      </div>
    `;
    basisEl.innerHTML = tableHtml;
  } else {
    basisEl.innerHTML = '<p class="placeholder-text">수집된 관련 법령 근거가 없습니다.</p>';
  }

  // 3. 핵심 쟁점 및 법적 리스크 분석 테이블
  const riskEl = document.getElementById('draft-risk-content');
  const risks = review.risks || [];

  if (risks.length > 0) {
    let riskTableHtml = `
      <div class="table-responsive">
        <table class="legal-table">
          <thead>
            <tr>
              <th style="width: 14%; text-align: center;">위험도</th>
              <th style="width: 32%;">핵심 쟁점 및 리스크명</th>
              <th style="width: 54%;">위반 시 제재 / 법적 불이익 및 분석 내용</th>
            </tr>
          </thead>
          <tbody>
    `;

    risks.forEach(r => {
      const level = (r.level || 'MEDIUM').toUpperCase();
      const levelIcon = level === 'HIGH' ? 'error' : (level === 'MEDIUM' ? 'warning' : 'info');
      const levelText = level === 'HIGH' ? '고위험 (High)' : (level === 'MEDIUM' ? '중위험 (Med)' : '주의 (Low)');

      riskTableHtml += `
        <tr>
          <td class="cell-center">
            <span class="badge-risk ${level}">
              <span class="material-symbols-outlined" style="font-size:14px;">${levelIcon}</span>
              ${levelText}
            </span>
          </td>
          <td><strong style="color: #1E293B;">${escapeHtml(cleanText(r.title || '법적 리스크'))}</strong></td>
          <td>${escapeHtml(cleanText(r.description || ''))}</td>
        </tr>
      `;
    });

    riskTableHtml += `
          </tbody>
        </table>
      </div>
    `;
    riskEl.innerHTML = riskTableHtml;
  } else {
    riskEl.innerHTML = '<p class="placeholder-text">발견된 특이 리스크가 없습니다.</p>';
  }

  // 4. 심층 법률 검토의견 본문 (20년 전문 변호사 다층 분석 렌더링)
  const opinionEl = document.getElementById('draft-opinion-content');
  const opinionText = cleanText(review.legalOpinion || '');
  const rawParagraphs = opinionText.split('\n\n').filter(p => p.trim());

  let opinionCardsHtml = '<div class="opinion-section-block">';
  if (rawParagraphs.length > 0) {
    rawParagraphs.forEach((block, idx) => {
      const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
      let cardTitle = `[쟁점 ${idx + 1}] 심층 법리 해석 및 적법성 판단`;
      let cardBodyLines = lines;

      // 첫 번째 줄이 소제목 형태([쟁점 ...], [1. ...] 등)인 경우 분리
      if (lines.length > 1 && (lines[0].startsWith('[') || lines[0].startsWith('■') || /^[0-9]\./.test(lines[0]))) {
        cardTitle = lines[0].replace(/^\[|\]$/g, '').replace(/^■\s*/, '');
        cardBodyLines = lines.slice(1);
      }

      const bodyHtml = cardBodyLines.map(line => `<p style="margin-bottom: 8px; line-height: 1.85;">${escapeHtml(line)}</p>`).join('');

      opinionCardsHtml += `
        <div class="opinion-item-card">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
            <span class="material-symbols-outlined icon-sm" style="color:var(--brand-primary);">gavel</span>
            <h4 style="margin:0; font-size:15px; font-weight:700; color:var(--brand-primary);">${escapeHtml(cardTitle)}</h4>
          </div>
          <div class="opinion-body-text" style="font-size:14px; color:#334155;">
            ${bodyHtml}
          </div>
        </div>
      `;
    });
  } else {
    opinionCardsHtml += `<p class="placeholder-text">검토의견이 없습니다.</p>`;
  }
  opinionCardsHtml += '</div>';
  opinionEl.innerHTML = opinionCardsHtml;

  // 5. 보완 권고사항 및 조치 계획 체크리스트
  const recEl = document.getElementById('draft-rec-content');
  const recommendations = review.recommendations || [];

  if (recommendations.length > 0) {
    let recHtml = '<div class="rec-checklist">';
    recommendations.forEach((rec, idx) => {
      recHtml += `
        <div class="rec-check-item">
          <div class="rec-num-badge">${idx + 1}</div>
          <div class="rec-text">${escapeHtml(cleanText(rec))}</div>
        </div>
      `;
    });
    recHtml += '</div>';
    recEl.innerHTML = recHtml;
  } else {
    recEl.innerHTML = '<p class="placeholder-text">보완 권고사항이 없습니다.</p>';
  }

  // 6. 완성형 법률검토의견서 (공문서 표준 서식 뷰)
  const reportViewEl = document.getElementById('draft-official-report-view');
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  let officialDocHtml = `
    <div class="official-report-view">
      <!-- 공문서 헤더 -->
      <div class="report-header-box">
        <h2 class="report-header-title">법 률 검 토 의 견 서</h2>
        <table class="report-meta-table">
          <tr>
            <td class="meta-label">문서 번호</td>
            <td style="width: 35%;">LR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}</td>
            <td class="meta-label">검토 일자</td>
            <td style="width: 35%;">${todayStr}</td>
          </tr>
          <tr>
            <td class="meta-label">검토 대상</td>
            <td colspan="3">${escapeHtml(query)}</td>
          </tr>
          <tr>
            <td class="meta-label">주요 법령</td>
            <td colspan="3"><strong>${escapeHtml(lawName)}</strong></td>
          </tr>
        </table>
      </div>

      <!-- 1. 검토 배경 및 사실관계 -->
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm">flag</span>
          <span>1. 검토 배경 및 질의 요지</span>
        </div>
        <div class="report-body-text">
          • ${escapeHtml(cleanText(review.facts || query))}
        </div>
      </div>

      <!-- 2. 법률적 쟁점 및 심층 검토 의견 -->
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm">gavel</span>
          <span>2. 법률적 쟁점 및 심층 검토 의견</span>
        </div>
        <div class="report-body-text" style="line-height: 1.9;">
          ${escapeHtml(opinionText)}
        </div>
      </div>

      <!-- 3. 리스크 평가 및 보완 조치 사항 -->
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm">checklist</span>
          <span>3. 리스크 평가 및 보완 조치 사항</span>
        </div>
        <div class="rec-checklist" style="margin-top: 10px;">
          ${recommendations.map((rec, i) => `
            <div class="rec-check-item">
              <div class="rec-num-badge">${i + 1}</div>
              <div class="rec-text">${escapeHtml(cleanText(rec))}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 4. 관련 법령 및 조문 근거 (마지막 배치) -->
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm">balance</span>
          <span>4. 관련 법령 및 조문 근거표</span>
        </div>
        <div class="table-responsive" style="margin-top: 10px;">
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

      <!-- 면책 조항 -->
      <div style="margin-top: 30px; padding: 14px; background: #F8FAFC; border-radius: 6px; font-size: 12px; color: #64748B; text-align: center;">
        ${escapeHtml(review.disclaimer || '본 의견서는 AI 법령검토 시스템에 의해 작성된 참고자료이며, 최종 법적 분쟁 및 처분에 대해서는 법률전문가의 자문을 받으시기 바랍니다.')}
      </div>
    </div>
  `;

  reportViewEl.innerHTML = officialDocHtml;
}

/**
 * Tab 2: 공식 근거 렌더링
 */
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
            <button class="btn btn-xs btn-outline btn-view-art" data-art="${escapeHtml(JSON.stringify(art))}">
              <span>전문 팝업</span>
              <span class="material-symbols-outlined" style="font-size:14px;">open_in_new</span>
            </button>
          </div>
          <div class="art-content">${escapeHtml(cleanText(art.content))}</div>
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
            <button class="btn btn-xs btn-outline btn-view-prec" data-prec="${escapeHtml(JSON.stringify(p))}">
              <span>판결요지 전문</span>
              <span class="material-symbols-outlined" style="font-size:14px;">open_in_new</span>
            </button>
          </div>
          <div class="prec-content">
            <p><strong>판시사항:</strong> ${escapeHtml(cleanText(p.holding || '내용 없음'))}</p>
            <p style="margin-top: 6px;"><strong>판결요지:</strong> ${escapeHtml(cleanText(p.summary || '내용 없음'))}</p>
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
            <strong>회답요지:</strong> ${escapeHtml(cleanText(e.answer || '내용 없음'))}
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
      rulesHtml += `
        <div style="margin-bottom: 8px; display: flex; align-items: center; gap: 6px; color: var(--brand-primary);">
          <span class="material-symbols-outlined icon-sm">attachment</span>
          <strong>관련 별표 및 서식:</strong>
        </div>`;
      annexes.forEach(a => {
        rulesHtml += `
          <div class="rule-card" style="margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
            <span>[별표 ${a.annexNo}] ${escapeHtml(a.title)}</span>
            ${a.fileUrl ? `
              <a href="${a.fileUrl}" target="_blank" class="btn btn-xs btn-outline" style="display:inline-flex; align-items:center; gap:4px;">
                <span class="material-symbols-outlined" style="font-size:14px;">download</span>
                <span>서식 다운로드</span>
              </a>` : ''}
          </div>
        `;
      });
    }

    if (ordinances.length > 0) {
      rulesHtml += `
        <div style="margin-top: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; color: var(--brand-primary);">
          <span class="material-symbols-outlined icon-sm">location_city</span>
          <strong>지자체 자치법규(조례):</strong>
        </div>`;
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

/**
 * Tab 3: 개정 및 영향 렌더링
 */
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
    itemsHtml += `
      <div class="table-responsive">
        <table class="legal-table">
          <thead>
            <tr>
              <th style="width: 15%; text-align: center;">상태 / 위험도</th>
              <th style="width: 25%;">문서 내 인용 조항</th>
              <th style="width: 30%;">공식 조문 제목</th>
              <th style="width: 30%;">충돌 및 적합성 분석 내용</th>
            </tr>
          </thead>
          <tbody>
    `;

    map.impactItems.forEach(item => {
      const risk = item.riskLevel || 'NORMAL';
      const riskBadgeClass = risk === 'HIGH' ? 'HIGH' : (risk === 'CAUTION' ? 'MEDIUM' : 'LOW');
      const statusText = risk === 'HIGH' ? '폐지/삭제' : (risk === 'CAUTION' ? '미확인' : '정상');

      itemsHtml += `
        <tr>
          <td class="cell-center">
            <span class="badge-risk ${riskBadgeClass}">
              ${statusText}
            </span>
          </td>
          <td><strong class="cell-bold">${escapeHtml(item.citation)}</strong></td>
          <td>${escapeHtml(item.articleTitle || '제목 없음')}</td>
          <td>${escapeHtml(cleanText(item.note))}</td>
        </tr>
      `;
    });

    itemsHtml += `
          </tbody>
        </table>
      </div>
    `;
  } else {
    itemsHtml = '<p class="placeholder-text">식별된 조문 인용이 없습니다.</p>';
  }

  container.innerHTML = itemsHtml;
}

/**
 * 텍스트 내 마크다운 불필요 특수문자(#, **, *, >, ` 등) 깔끔하게 정제
 */
function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/^#+\s+/gm, '')       // # 헤더 기호 제거
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 볼드 ** 제거
    .replace(/\*([^*]+)\*/g, '$1')     // 이탤릭 * 제거
    .replace(/^>\s+/gm, '')        // 인용 > 제거
    .replace(/`([^`]+)`/g, '$1')   // 백틱 코드 제거
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
  initWorkbenchTabs,
  renderWorkbench
};
