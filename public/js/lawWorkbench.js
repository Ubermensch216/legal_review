// public/js/lawWorkbench.js - 워크벤치 4단계 탭 렌더러 및 이벤트 컨트롤러 (Redline 대비표, IRAC 및 Re-ranking 지원)
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

  // 4번째 탭: 스튜디오로 전송 버튼
  const btnTabStudio = document.getElementById('btn-tab-send-to-studio') || document.getElementById('btn-send-to-studio');
  if (btnTabStudio) {
    btnTabStudio.addEventListener('click', () => {
      if (state.lastReviewResult && state.lastReviewResult.review) {
        const title = `${state.lastReviewResult.meta?.primaryLawName || '법령'} 검토의견서`;
        openStudio(state.lastReviewResult.review.draftOpinion, title, state.lastReviewResult);
      }
    });
  }

  // 4번째 탭: HWPX 빠른 다운로드
  const btnTabHwpx = document.getElementById('btn-tab-export-hwpx');
  if (btnTabHwpx) {
    btnTabHwpx.addEventListener('click', () => downloadQuickReport('hwpx'));
  }

  // 4번째 탭: PDF 빠른 다운로드
  const btnTabPdf = document.getElementById('btn-tab-export-pdf');
  if (btnTabPdf) {
    btnTabPdf.addEventListener('click', () => downloadQuickReport('pdf'));
  }

  // 4번째 탭: DOCX 빠른 다운로드
  const btnTabDocx = document.getElementById('btn-tab-export-docx');
  if (btnTabDocx) {
    btnTabDocx.addEventListener('click', () => downloadQuickReport('docx'));
  }
}

async function downloadQuickReport(format) {
  if (!state.lastReviewResult || !state.lastReviewResult.review) {
    alert('다운로드할 검토 결과가 없습니다. 먼저 검토를 실행해주세요.');
    return;
  }

  const title = `${state.lastReviewResult.meta?.primaryLawName || '법령'} 검토의견서`;
  const content = state.lastReviewResult.review.draftOpinion || state.lastReviewResult.review.legalOpinion || '';

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

    if (!res.ok) throw new Error(`다운로드 실패: HTTP ${res.status}`);

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.${format}`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
  } catch (err) {
    alert(`파일 다운로드 중 오류가 발생했습니다: ${err.message}`);
  }
}

/**
 * 워크벤치 전체 데이터 렌더링
 * @param {object} data - /api/law/workbench 응답 데이터
 */
export function renderWorkbench(data) {
  state.lastReviewResult = data;
  const { review, officialEvidence, impactAndRevisions, meta } = data;

  // 1. Tab 1: 검토 초안 (구조화된 테이블, Redline 대비표 & IRAC 공문서 뷰)
  renderDraftTab(review, officialEvidence, meta);

  // 2. Tab 2: 공식 근거 (Re-ranking 점수 및 연쇄 3단계 법령 체계)
  renderEvidenceTab(officialEvidence, meta);

  // 3. Tab 3: 개정 및 영향
  renderRevisionsTab(impactAndRevisions, meta);
}

/**
 * Tab 1: 구조화된 HTML 테이블, Redline 대비표 및 IRAC 컴포넌트 렌더링
 */
function renderDraftTab(review, officialEvidence, meta) {
  if (!review) return;

  const lawName = meta?.primaryLawName || '관련 법령';
  const query = meta?.query || '요청 사안에 관한 법적 검토';

  // 0. 조문 실존성 검증 뱃지
  const badgeContainer = document.getElementById('draft-factuality-badge');
  if (badgeContainer) {
    const factReport = review.factualityVerification;
    if (factReport) {
      badgeContainer.innerHTML = `
        <div class="badge-confidence-tag" title="국가법령정보 DB 조문 실존성 전수 검증 완료">
          <span class="material-symbols-outlined" style="font-size:14px; color:#16A34A;">verified</span>
          <span>조문 검증 ${factReport.citationConfidence}% 확정</span>
          ${factReport.correctionsCount > 0 ? `<span class="badge-corrected">자동보정 ${factReport.correctionsCount}건</span>` : ''}
        </div>
      `;
    } else {
      badgeContainer.innerHTML = '';
    }
  }

  // 1. 핵심 요약 하이라이트 박스
  const summaryEl = document.getElementById('draft-summary-content');
  summaryEl.innerHTML = `
    <div class="summary-highlight-card">
      ${escapeHtml(cleanText(review.summary))}
    </div>
  `;

  // 2. 핵심 쟁점 및 법적 리스크 분석 테이블
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

  // 3. 실무형 수정 조문 (Redline Diff) 신구 조문 대비표
  const redlineEl = document.getElementById('draft-redline-content');
  const redlines = review.redlineDiffs || [];

  if (redlines.length > 0) {
    let redlineHtml = `
      <div class="table-responsive">
        <table class="legal-table redline-table">
          <thead>
            <tr>
              <th style="width: 18%;">대상 조항</th>
              <th style="width: 32%;">현행 원문 (위법/불리한 문구)</th>
              <th style="width: 32%;">수정 권고안 (적법 대체문구)</th>
              <th style="width: 18%;">개정 사유 및 법적 근거</th>
            </tr>
          </thead>
          <tbody>
    `;

    redlines.forEach((diff, idx) => {
      redlineHtml += `
        <tr>
          <td class="cell-bold">
            <span class="badge-clause-no">${escapeHtml(diff.clauseNo || `조항 ${idx + 1}`)}</span>
          </td>
          <td class="redline-cell-old">
            <div class="diff-tag old-tag">현행 문구</div>
            <div class="diff-text-old">${escapeHtml(diff.originalText)}</div>
          </td>
          <td class="redline-cell-new">
            <div class="diff-tag new-tag">수정 권고안</div>
            <div class="diff-text-new">${escapeHtml(diff.revisedText)}</div>
          </td>
          <td class="redline-cell-reason">
            <span class="reason-text">${escapeHtml(diff.reason)}</span>
          </td>
        </tr>
      `;
    });

    redlineHtml += `
          </tbody>
        </table>
      </div>
    `;
    redlineEl.innerHTML = redlineHtml;
  } else {
    redlineEl.innerHTML = '<p class="placeholder-text">수정이 요구되는 특이 독소조항이 발견되지 않았습니다.</p>';
  }

  // 4. 심층 법률 검토의견 본문 (IRAC 다단계 분석 렌더링)
  const opinionEl = document.getElementById('draft-opinion-content');
  const opinionText = cleanText(review.legalOpinion || '');
  const rawParagraphs = opinionText.split('\n\n').filter(p => p.trim());

  let opinionCardsHtml = '<div class="opinion-section-block">';
  if (rawParagraphs.length > 0) {
    rawParagraphs.forEach((block, idx) => {
      const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
      let cardTitle = `[쟁점 ${idx + 1}] 심층 법리 해석 및 적법성 판단`;
      let cardBodyLines = lines;

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

  // 6. 관련 법령 및 조문 근거 테이블
  const basisEl = document.getElementById('draft-basis-content');
  let basisList = review.legalBasis || [];

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

  // 7. 완성형 법률검토의견서 (공문서 표준 서식 뷰)
  const reportViewEl = document.getElementById('draft-official-report-view');
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  let officialDocHtml = `
    <div class="official-report-view">
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

      <!-- 2. 심층 법률 검토의견 (IRAC) -->
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm">gavel</span>
          <span>2. 심층 법률 검토의견 (IRAC 다단계 분석)</span>
        </div>
        <div class="report-body-text" style="line-height: 1.9;">
          ${escapeHtml(opinionText)}
        </div>
      </div>

      <!-- 3. 실무 조항 수정 권고안 (Redline Diff) -->
      ${redlines.length > 0 ? `
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm" style="color:#2563EB;">rate_review</span>
          <span>3. 실무 조항 수정 권고안 (신·구 조문 대비표)</span>
        </div>
        <div class="table-responsive" style="margin-top: 10px;">
          <table class="legal-table redline-table">
            <thead>
              <tr>
                <th style="width: 20%;">대상 조항</th>
                <th style="width: 40%;">현행 원문</th>
                <th style="width: 40%;">수정 권고안</th>
              </tr>
            </thead>
            <tbody>
              ${redlines.map(d => `
                <tr>
                  <td class="cell-bold">${escapeHtml(d.clauseNo || '')}</td>
                  <td style="color:#DC2626; text-decoration: line-through;">${escapeHtml(d.originalText)}</td>
                  <td style="color:#16A34A; font-weight:600;">${escapeHtml(d.revisedText)}<br><small style="color:#64748B; font-weight:normal;">(사유: ${escapeHtml(d.reason)})</small></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ` : ''}

      <!-- 4. 보완 조치 사항 -->
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm">checklist</span>
          <span>4. 리스크 평가 및 보완 조치 가이드</span>
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

      <!-- 5. 관련 법령 및 조문 근거 -->
      <div class="report-section">
        <div class="report-section-title">
          <span class="material-symbols-outlined icon-sm">balance</span>
          <span>5. 관련 법령 및 적용 조문 근거표</span>
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

      <div style="margin-top: 30px; padding: 14px; background: #F8FAFC; border-radius: 6px; font-size: 12px; color: #64748B; text-align: center;">
        ${escapeHtml(review.disclaimer || '본 의견서는 AI 법령검토 시스템에 의해 작성된 참고자료이며, 최종 법적 분쟁 및 처분에 대해서는 법률전문가의 자문을 받으시기 바랍니다.')}
      </div>
    </div>
  `;

  reportViewEl.innerHTML = officialDocHtml;
}

/**
 * Tab 2: 공식 근거 (Re-ranking 및 Cascading 연쇄 구조) 렌더링
 */
function renderEvidenceTab(evidence, meta) {
  if (!evidence) return;
  const lawName = meta?.primaryLawName || '관련 법령';

  // 1. 공식 조문 카드
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

  artContainer.querySelectorAll('.btn-view-art').forEach(btn => {
    btn.addEventListener('click', () => {
      const art = JSON.parse(btn.getAttribute('data-art'));
      openArticleViewer(lawName, art);
    });
  });

  // 2. Re-ranked 판례 및 해석례 카드
  const precContainer = document.getElementById('evidence-precedents');
  let precHtml = '';

  const precedents = evidence.precedents || [];
  const interpretations = evidence.interpretations || [];

  if (precedents.length > 0 || interpretations.length > 0) {
    precedents.forEach((p, idx) => {
      const scoreBadge = p.relevanceScore 
        ? `<span class="badge-rerank"><span class="material-symbols-outlined" style="font-size:13px; color:#2563EB;">star</span>관련도 ${p.relevanceScore}점 (${escapeHtml(p.matchReason || '핵심 판례')})</span>` 
        : '';

      precHtml += `
        <div class="prec-card">
          <div class="prec-card-header">
            <div>
              <div class="prec-title">[Top ${idx + 1} 판례] ${p.courtName || '대법원'} ${p.caseNo} ${escapeHtml(p.caseName)}</div>
              ${scoreBadge}
            </div>
            <button class="btn btn-xs btn-outline btn-view-prec" data-prec="${escapeHtml(JSON.stringify(p))}">
              <span>판결요지 전문</span>
              <span class="material-symbols-outlined" style="font-size:14px;">open_in_new</span>
            </button>
          </div>
          <div class="prec-summary">${escapeHtml(cleanText(p.summary || p.holding))}</div>
        </div>
      `;
    });

    interpretations.forEach((interp, idx) => {
      const scoreBadge = interp.relevanceScore 
        ? `<span class="badge-rerank"><span class="material-symbols-outlined" style="font-size:13px; color:#16A34A;">verified</span>해석례 관련도 ${interp.relevanceScore}점</span>` 
        : '';

      precHtml += `
        <div class="prec-card" style="border-left: 3px solid #16A34A;">
          <div class="prec-card-header">
            <div>
              <div class="prec-title" style="color:#15803D;">[유권해석 ${idx + 1}] ${interp.orgName || '법제처'} ${escapeHtml(interp.title || '')}</div>
              ${scoreBadge}
            </div>
          </div>
          <div class="prec-summary">${escapeHtml(cleanText(interp.answer || interp.reason || ''))}</div>
        </div>
      `;
    });
  } else {
    precHtml = '<p class="placeholder-text">수집된 판례 및 유권해석 데이터가 없습니다.</p>';
  }
  precContainer.innerHTML = precHtml;

  precContainer.querySelectorAll('.btn-view-prec').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = JSON.parse(btn.getAttribute('data-prec'));
      openPrecedentViewer(p);
    });
  });

  // 3. 행정규칙, 자치법규 및 3단계 연쇄 체계
  const rulesContainer = document.getElementById('evidence-rules');
  let rulesHtml = '';

  const cascade = evidence.cascadingHierarchy;
  if (cascade && cascade.isCompleteHierarchy) {
    rulesHtml += `
      <div class="cascade-box" style="margin-bottom: 16px; padding: 14px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
        <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:#1E3A8A; margin-bottom: 8px;">
          <span class="material-symbols-outlined" style="font-size:16px;">account_tree</span>
          <span>3단계 연쇄 법령 체계 (모법 ➔ 시행령 ➔ 시행규칙)</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:12.5px;">
          <span class="badge badge-gov">법률: ${escapeHtml(cascade.act?.lawName || lawName)}</span>
          <span class="material-symbols-outlined" style="font-size:14px; color:#94A3B8; align-self:center;">arrow_forward</span>
          <span class="badge" style="background:#E0E7FF; color:#3730A3;">시행령: ${escapeHtml(cascade.decree?.lawName || '시행령')}</span>
          ${cascade.rule ? `
            <span class="material-symbols-outlined" style="font-size:14px; color:#94A3B8; align-self:center;">arrow_forward</span>
            <span class="badge" style="background:#F1F5F9; color:#475569;">시행규칙: ${escapeHtml(cascade.rule.lawName)}</span>
          ` : ''}
        </div>
      </div>
    `;
  }

  const adminRules = evidence.adminRules || [];
  const ordinances = evidence.ordinances || [];

  if (adminRules.length > 0 || ordinances.length > 0) {
    adminRules.forEach(r => {
      rulesHtml += `
        <div class="rule-card">
          <div class="rule-card-header">
            <span class="badge badge-gray">행정규칙/고시</span>
            <strong>${escapeHtml(r.title || r.name)}</strong>
          </div>
          <div class="rule-desc">${escapeHtml(cleanText(r.content || r.summary || ''))}</div>
        </div>
      `;
    });

    ordinances.forEach(o => {
      rulesHtml += `
        <div class="rule-card">
          <div class="rule-card-header">
            <span class="badge badge-gray">자치법규/조례</span>
            <strong>${escapeHtml(o.title || o.name)}</strong>
          </div>
          <div class="rule-desc">${escapeHtml(cleanText(o.content || o.summary || ''))}</div>
        </div>
      `;
    });
  } else if (!cascade) {
    rulesHtml = '<p class="placeholder-text">관련 행정규칙 및 자치법규 데이터가 없습니다.</p>';
  }
  rulesContainer.innerHTML = rulesHtml;
}

/**
 * Tab 3: 개정 및 영향 분석 렌더링
 */
function renderRevisionsTab(impactData, meta) {
  if (!impactData) return;

  const container = document.getElementById('impact-items-container');
  const badgeContainer = document.getElementById('impact-summary-badge');
  const impactMap = impactData.impactMap;

  if (impactMap) {
    const totalCount = impactMap.totalChecked || 0;
    const invalidCount = impactMap.conflictCount || 0;

    badgeContainer.innerHTML = `
      <span class="badge ${invalidCount > 0 ? 'badge-risk HIGH' : 'badge-gov'}">
        ${invalidCount > 0 ? `충돌/개정필요 ${invalidCount}건` : '상위법령 적합'}
      </span>
    `;

    let listHtml = '';
    const citations = impactMap.citations || [];

    if (citations.length > 0) {
      citations.forEach(c => {
        const isConflict = c.status === 'DELETED' || c.status === 'CONFLICT';
        listHtml += `
          <div class="impact-item-card ${isConflict ? 'has-conflict' : ''}">
            <div class="impact-item-header">
              <span class="impact-citation-badge">${escapeHtml(c.citation)}</span>
              <span class="badge ${isConflict ? 'badge-risk HIGH' : 'badge-gov'}">${escapeHtml(c.status)}</span>
            </div>
            <div class="impact-item-reason">${escapeHtml(c.reason || '')}</div>
          </div>
        `;
      });
    } else {
      listHtml = '<p class="placeholder-text">추출된 인용 조문이 없습니다.</p>';
    }

    container.innerHTML = listHtml;
  } else {
    badgeContainer.innerHTML = '<span class="badge badge-gov">분석 대기</span>';
    container.innerHTML = '<p class="placeholder-text">첨부문서가 업로드되면 조문 충돌 및 개정 영향 분석 결과가 여기에 표시됩니다.</p>';
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

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default {
  initWorkbenchTabs,
  renderWorkbench
};
