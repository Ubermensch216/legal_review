// public/js/lawWorkbench.js - 워크벤치 4단계 탭 렌더러 및 이벤트 컨트롤러 (Redline 대비표, IRAC 및 Re-ranking 지원)
import { state } from './state.js';
import { openArticleViewer, openPrecedentViewer } from './documentViewer.js';
import { openStudio } from './documentStudio.js';
import { setLearningHistory, resetLearningTab } from './learningTab.js';
import { renderReasoningOpinion } from './reasoningView.js';
import { parseReportBlocks, renderReportBlocksHtml, stripReportMarkup } from './reportFormat.js';
import { expandReferences, explainDiagnostic } from './learningIssues.js';

export function initWorkbenchTabs() {
  const tabs = document.querySelectorAll('.wb-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      selectWorkbenchTab(tab);
    });
  });

  selectWorkbenchTab(document.querySelector('.wb-tab.active') || tabs[0]);

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
        const title = state.lastReviewResult.meta?.preset === 'contract_risk'
          ? '계약서 법률검토의견서' : `${state.lastReviewResult.meta?.primaryLawName || '법령'} 검토의견서`;
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

function selectWorkbenchTab(tab) {
  const pane = tab && document.getElementById(tab.getAttribute('data-tab'));
  if (!pane) return;
  document.querySelectorAll('.wb-tab').forEach(item => item.classList.toggle('active', item === tab));
  document.querySelectorAll('.tab-pane').forEach(item => item.classList.toggle('active', item === pane));
}

async function downloadQuickReport(format) {
  if (!state.lastReviewResult || !state.lastReviewResult.review) {
    alert('다운로드할 검토 결과가 없습니다. 먼저 검토를 실행해주세요.');
    return;
  }

  const title = state.lastReviewResult.meta?.preset === 'contract_risk'
    ? '계약서 법률검토의견서' : `${state.lastReviewResult.meta?.primaryLawName || '법령'} 검토의견서`;
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
/**
 * 데이터 출처 및 검토 엔진 상태를 상단 배너로 표시한다.
 * 폴백/목업 결과가 정상 검토와 구분되지 않던 문제를 눈에 보이게 만든다.
 */
function renderReliabilityBanner() {
  const rel = window.__reliability;
  let host = document.getElementById('reliability-banner');
  const external = rel?.externalKnowledge?.applied;

  if (!rel || (!rel.isFallback && !external)) {
    if (host) host.remove();
    return;
  }

  if (!host) {
    host = document.createElement('div');
    host.id = 'reliability-banner';
    const anchor = document.getElementById('draft-factuality-badge')
      || document.getElementById('workbench-section');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(host, anchor);
    } else {
      document.body.prepend(host);
    }
  }

  const engineLabel = rel.reviewEngine === 'RULE_BASED_FALLBACK'
    ? '규칙 기반 점검 (LLM 법리 검토 미수행)'
    : rel.reviewEngine === 'LLM_STAGED' ? '단계형 LLM 검토 (쟁점·요건 단위)' : rel.reviewEngine;

  host.className = `reliability-banner${external ? ' external' : ''}`;
  const externalLabel = external
    ? `외부 참고 지식 ${rel.externalKnowledge.count}건 반영 (${rel.externalKnowledge.humanExpertCount}건 전문가 · ${rel.externalKnowledge.externalAiCount}건 외부 AI)`
    : '';
  const headline = rel.isFallback
    ? `${external ? '외부 지식 반영 · ' : ''}이 결과는 참고용 제한 결과입니다 — 결재 문서로 사용하지 마십시오`
    : `외부 참고 지식 반영 재검토 — 공식 근거와 구분하여 확인하십시오`;
  host.innerHTML = `
    <div class="reliability-banner-head">
      <span class="material-symbols-outlined">${external ? 'merge_type' : 'report'}</span>
      <strong>${escapeHtml(headline)}</strong>
    </div>
    <div class="reliability-banner-body">
      <div>검토 엔진: <b>${escapeHtml(engineLabel)}</b></div>
      ${externalLabel ? `<div class="reliability-external-label">${escapeHtml(externalLabel)}</div>` : ''}
      <ul>
        ${(rel.warnings || []).map(w => `<li>${escapeHtml(w)}</li>`).join('')}
      </ul>
    </div>
  `;
}

export function renderWorkbench(data) {
  document.getElementById('workbench-section')?.classList.remove('hidden');
  selectWorkbenchTab(document.querySelector('.wb-tab.active') || document.querySelector('.wb-tab'));
  state.lastReviewResult = data;
  const { review, officialEvidence, impactAndRevisions, meta } = data;

  // 서버가 내려준 신뢰도/출처 정보를 렌더러 전반에서 참조할 수 있게 보관한다.
  const learningReferences = Array.isArray(review?.learningReferences) ? review.learningReferences : [];
  const externalKnowledge = data.reliability?.externalKnowledge || {
    applied: learningReferences.length > 0,
    count: learningReferences.length,
    humanExpertCount: learningReferences.filter(item => item.source === 'USER_APPROVED_HUMAN_EXPERT').length,
    externalAiCount: learningReferences.filter(item => item.source !== 'USER_APPROVED_HUMAN_EXPERT').length
  };
  window.__reliability = data.reliability
    ? { ...data.reliability, externalKnowledge,
      warnings: (data.reliability.warnings || []).map(w => explainDiagnostic(w, data)) }
    : { externalKnowledge };

  const isFallback = Boolean(data.reliability && data.reliability.isFallback);
  const external = Boolean(externalKnowledge.applied);
  const statusText = isFallback ? (external ? '외부·제한' : '제한') : (external ? '외부 반영' : '완료');
  const statusClass = isFallback ? 'warning' : (external ? 'external' : 'active');

  const badgeReportEl = document.getElementById('badge-report-status');
  if (badgeReportEl) {
    badgeReportEl.className = `tab-badge ${statusClass}`;
    badgeReportEl.textContent = statusText;
  }

  // 검토 결과는 근거·영향 분석·외부 질의·법률검토의견서 탭으로 나누어 표시한다.
  renderDraftTab(review, officialEvidence, meta);

  // 1. 공식 근거 (Re-ranking 점수 및 연쇄 3단계 법령 체계)
  renderEvidenceTab(officialEvidence, meta);

  // 2. 개정 및 영향
  renderRevisionsTab(impactAndRevisions, meta);

  // 3. 외부 전문가 질의 — 서버에 저장된 이력에만 연결한다.
  //    질의서는 저장된 검토 자료에서 만들어지므로 이력 저장에 실패하면 사용할 수 없다.
  setLearningHistory(data.meta?.sourceHistoryId || data.historyId, data);
}

/**
 * 워크벤치 탭 상태 및 뱃지 비활성화 초기화 (램프 오프)
 */
export function resetWorkbenchTabs() {
  const badgeReportEl = document.getElementById('badge-report-status');
  if (badgeReportEl) {
    badgeReportEl.className = 'tab-badge off';
    badgeReportEl.textContent = '대기';
  }

  const countEvidenceEl = document.getElementById('count-evidence');
  if (countEvidenceEl) countEvidenceEl.textContent = '0건';

  const dotImpactEl = document.getElementById('dot-impact');
  if (dotImpactEl) {
    dotImpactEl.className = 'tab-status-dot';
    dotImpactEl.textContent = '';
  }

  resetLearningTab();
}

/** 새 리뷰 시작 시 현재 워크벤치에 남은 결과·근거·선택 탭을 모두 초기 상태로 되돌린다. */
export function resetWorkbench() {
  resetWorkbenchTabs();
  document.getElementById('workbench-section')?.classList.add('hidden');

  [
    'evidence-articles', 'evidence-precedents', 'evidence-rules',
    'impact-summary-badge', 'impact-risk-container', 'impact-items-container',
    'impact-history-container', 'draft-official-report-view'
  ].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.innerHTML = '';
  });

  selectWorkbenchTab(document.querySelector('.wb-tab[data-tab="tab-evidence"]'));
  document.getElementById('reliability-banner')?.remove();
}

/**
 * 법률검토의견서 및 내부 검토 데이터 렌더링
 */
function renderDraftTab(review, officialEvidence, meta) {
  if (!review) return;

  const lawName = meta?.primaryLawName || '관련 법령';
  const query = meta?.query || '요청 사안에 관한 법적 검토';
  const opinionText = cleanText(expandReferences(review.legalOpinion || review.draftOpinion || '', { review }));

  // 0. 조문 실존성 검증 뱃지 및 폴백 경고
  const badgeContainer = document.getElementById('draft-factuality-badge');
  if (badgeContainer) {
    const factReport = review.factualityVerification;
    const parts = [];

    // 검토 엔진이 폴백이거나 수집 데이터가 목업이면 가장 먼저 경고를 띄운다.
    const warnings = (window.__reliability && window.__reliability.warnings) || [];
    if (review.isFallback || warnings.length > 0) {
      parts.push(`
        <div class="badge-fallback-warning">
          <span class="material-symbols-outlined" style="font-size:14px;">warning</span>
          <span>${review.isFallback ? '규칙 기반 점검 결과 (법리 검토 아님)' : '검토 제한 사항'}</span>
        </div>
      `);
    }

    if (factReport) {
      if (!factReport.isMeasurable) {
        // 측정 불가를 숫자로 위장하지 않는다.
        parts.push(`
          <div class="badge-confidence-tag badge-unmeasurable" title="${escapeHtml(factReport.unmeasurableReason || '검증 대상 인용이 없습니다.')}">
            <span class="material-symbols-outlined" style="font-size:14px; color:#B45309;">help</span>
            <span>조문 검증 측정 불가</span>
          </div>
        `);
      } else {
        const conf = factReport.citationConfidence;
        const tone = conf >= 90 ? '#16A34A' : (conf >= 60 ? '#B45309' : '#DC2626');
        parts.push(`
          <div class="badge-confidence-tag" title="수집된 공식 조문 및 법령 API로 검증된 인용 비율">
            <span class="material-symbols-outlined" style="font-size:14px; color:${tone};">verified</span>
            <span>조문 검증 ${conf}% (${factReport.validCount}/${factReport.totalChecked}건)</span>
          </div>
        `);
        if (factReport.unverifiedCount > 0) {
          parts.push(`<span class="badge-unverified">미검증 인용 ${factReport.unverifiedCount}건</span>`);
        }
      }
    }

    badgeContainer.innerHTML = parts.join('');
  }

  // 0-1. 상단 경고 배너 (데이터 출처 및 엔진 상태)
  renderReliabilityBanner();

  // 1. 핵심 요약 하이라이트 박스
  const summaryEl = document.getElementById('draft-summary-content');
  if (summaryEl) {
    const used = review.evidenceUsed || {};
    const usedLabels = [['articles', '법령 조문'], ['precedents', '판례'], ['interpretations', '유권해석례'],
      ['ordinances', '자치법규 조문'], ['adminRules', '행정규칙']]
      .filter(([key]) => Number.isInteger(used[key]) && used[key] > 0)
      .map(([key, label]) => `${label} ${used[key]}건`);
    summaryEl.innerHTML = `
      <div class="summary-highlight-card">
        ${usedLabels.length ? `<div><strong>검토에 사용한 자료:</strong> ${escapeHtml(usedLabels.join(' · '))}</div>` : ''}
        ${escapeHtml(cleanText(expandReferences(review.summary, { review })))}
      </div>
    `;
  }

  // 2. 핵심 쟁점 및 법적 리스크 분석 테이블
  const riskEl = document.getElementById('draft-risk-content');
  const risks = review.risks || [];

  if (riskEl && risks.length > 0) {
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
  } else if (riskEl) {
    riskEl.innerHTML = '<p class="placeholder-text">발견된 특이 리스크가 없습니다.</p>';
  }

  // 3. 실무형 수정 조문 (Redline Diff) 신구 조문 대비표
  const redlineEl = document.getElementById('draft-redline-content');
  const redlines = review.redlineDiffs || [];

  if (redlineEl && redlines.length > 0) {
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
  } else if (redlineEl) {
    redlineEl.innerHTML = '<p class="placeholder-text">수정이 요구되는 특이 독소조항이 발견되지 않았습니다.</p>';
  }

  // 4. 심층 법률 검토의견 본문 (IRAC 다단계 분석 렌더링)
  const opinionEl = document.getElementById('draft-opinion-content');
  // 단계형 검토는 쟁점별 요건 판단이 구조로 있으므로 표로 보여준다.
  if (opinionEl) {
    if (review.reasoning?.issues?.length) {
      opinionEl.innerHTML = renderReasoningOpinion(review.reasoning, review);
      opinionEl.querySelector('[data-open-learning]')?.addEventListener('click', () => document.querySelector('[data-tab="tab-learning"]')?.click());
    } else {
      opinionEl.innerHTML = legacyOpinionHtml(review);
    }
  }

  // 5. 보완 권고사항 및 조치 계획 체크리스트
  const recEl = document.getElementById('draft-rec-content');
  const recommendations = review.recommendations || [];

  if (recEl && recommendations.length > 0) {
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
  } else if (recEl) {
    recEl.innerHTML = '<p class="placeholder-text">보완 권고사항이 없습니다.</p>';
  }

  // 6. 관련 법령 및 조문 근거 테이블
  const basisEl = document.getElementById('draft-basis-content');
  let basisList = (review.legalBasis || []).map(b => ({ ...b, relevance: `[${b.verificationStatus === 'VERIFIED' ? '조문 존재 확인' : '미검증'}] ${b.relevance || ''}${b.verificationNote ? ' — ' + b.verificationNote : ''}` }));


  if (basisEl && basisList.length > 0) {
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
  } else if (basisEl) {
    basisEl.innerHTML = '<p class="placeholder-text">수집된 관련 법령 근거가 없습니다.</p>';
  }

  // 7. 완성형 법률검토의견서 (공문서 표준 서식 뷰)
  const reportViewEl = document.getElementById('draft-official-report-view');
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const externalKnowledge = window.__reliability?.externalKnowledge;
  const isExternalRerun = Boolean(externalKnowledge?.applied);
  const originLabel = isExternalRerun
    ? `외부 참고 지식 반영 재검토 · ${externalKnowledge.count}건 (전문가 ${externalKnowledge.humanExpertCount}건 / 외부 AI ${externalKnowledge.externalAiCount}건)`
    : '초기 검토 · 외부 참고 지식 미반영';

  let officialDocHtml = `
    <div class="official-report-view">
      <div class="report-warning">${escapeHtml((window.__reliability?.warnings || []).join(' / '))}</div>
      <div class="report-provenance ${isExternalRerun ? 'external' : 'initial'}">
        <span class="material-symbols-outlined icon-sm">${isExternalRerun ? 'merge_type' : 'history'}</span>
        <strong>${escapeHtml(originLabel)}</strong>
        <span>${isExternalRerun
          ? '승인된 외부 답변은 참고자료이며 공식 법령·판례를 대신하지 않습니다.'
          : '외부 전문가 질의·승인 지식은 아직 이 의견서에 반영되지 않았습니다.'}</span>
      </div>
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
          <tr>
            <td class="meta-label">검토 구분</td>
            <td colspan="3">${escapeHtml(originLabel)}</td>
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
          <span>${review.reasoning?.issues?.length ? '2. 쟁점별 IRAC 분석 및 전체 종합 결론' : '2. 법률 검토의견'}</span>
        </div>
        ${review.reasoning?.issues?.length
          ? renderReasoningOpinion(review.reasoning, review, { report: true })
          : `<div class="report-rich-body">${renderReportBlocksHtml(parseReportBlocks(opinionText))}</div>`}
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
/** 단일 호출 검토의 의견 본문을 문단 카드로 보여준다. */
function legacyOpinionHtml(review) {
  const opinionText = expandReferences(review.legalOpinion || '', { review });
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
  return opinionCardsHtml;
}

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
          <div class="art-title">${escapeHtml(art.lawName || lawName)} 제${art.fullArticleNo || art.articleNo}조 (${escapeHtml(art.title || '')})</div>
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
      openArticleViewer(art.lawName || lawName, art);
    });
  });

  // 2. Re-ranked 판례 및 해석례 카드
  const precContainer = document.getElementById('evidence-precedents');
  let precHtml = '';

  const precedents = evidence.precedents || [];
  const interpretations = evidence.interpretations || [];

  if (precedents.length > 0 || interpretations.length > 0) {
    precedents.forEach((p, idx) => {
      const scoreBadge = Number.isFinite(p.relevanceScore)
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
      const scoreBadge = Number.isFinite(interp.relevanceScore)
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
  if (cascade && (cascade.act || cascade.decree || cascade.rule)) {
    rulesHtml += `
      <div class="cascade-box" style="margin-bottom: 16px; padding: 14px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;">
        <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:#1E3A8A; margin-bottom: 8px;">
          <span class="material-symbols-outlined" style="font-size:16px;">account_tree</span>
          <span>확인된 조문 인용 연계 (부분 결과)</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:12.5px;">
          <span class="badge badge-gov">법률: ${escapeHtml(cascade.act?.lawName || lawName)}</span>
          <span class="material-symbols-outlined" style="font-size:14px; color:#94A3B8; align-self:center;">arrow_forward</span>
          <span class="badge" style="background:#E0E7FF; color:#3730A3;">시행령: ${escapeHtml(cascade.decree?.lawName || '미확인')}</span>
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
 * Tab 3: 개정 및 영향 분석 렌더링 (위험 조항 영향도, 조문 적합성 대조표 및 법령 개정 연혁)
 */
function renderRevisionsTab(impactData, meta) {
  const badgeContainer = document.getElementById('impact-summary-badge');
  const riskContainer = document.getElementById('impact-risk-container');
  const itemsContainer = document.getElementById('impact-items-container');
  const historyContainer = document.getElementById('impact-history-container');

  const lawName = meta?.primaryLawName || impactData?.primaryLawDetail?.lawName || '관련 법령';
  const lawDetail = impactData?.primaryLawDetail || null;
  const impactMap = impactData?.impactMap || null;
  const riskClauses = impactData?.riskClauses || [];
  const lawHistory = impactData?.lawHistory || null;

  // 1. 상단 종합 진단 뱃지 렌더링
  if (badgeContainer) {
    const summary = impactMap?.impactSummary || {};
    const highRiskCount = summary.highRiskCount || 0;
    const cautionCount = summary.cautionCount || 0;
    const totalCitations = summary.total || impactMap?.analyzedReferencesCount || 0;

    let statusBadge = `<span class="badge badge-gov"><span class="material-symbols-outlined" style="font-size:13px; color:#16A34A;">check_circle</span>현행 법령 적합</span>`;
    if (highRiskCount > 0) {
      statusBadge = `<span class="badge badge-risk HIGH"><span class="material-symbols-outlined" style="font-size:13px;">error</span>개정/폐지 조문 ${highRiskCount}건</span>`;
    } else if (cautionCount > 0) {
      statusBadge = `<span class="badge badge-risk MEDIUM"><span class="material-symbols-outlined" style="font-size:13px;">warning</span>확인 필요 ${cautionCount}건</span>`;
    }

    badgeContainer.innerHTML = `
      <div class="impact-summary-item">
        <span class="impact-summary-label">검토 기준</span>
        <strong>${escapeHtml(lawName)}</strong>
        ${lawDetail?.enforceDate ? `<small>시행일 ${escapeHtml(lawDetail.enforceDate)}</small>` : ''}
      </div>
      <div class="impact-summary-item">
        <span class="impact-summary-label">내부 위험 조항</span>
        <strong>${riskClauses.length}건</strong>
        <small>${riskClauses.length ? '우선 검토 필요' : '특이사항 없음'}</small>
      </div>
      <div class="impact-summary-item">
        <span class="impact-summary-label">조문 대조</span>
        <strong>${totalCitations}건</strong>
        <small>${highRiskCount + cautionCount ? `확인 필요 ${highRiskCount + cautionCount}건` : '현행 적합'}</small>
      </div>
      <div class="impact-summary-status">${statusBadge}</div>
    `;

    const dotEl = document.getElementById('dot-impact');
    if (dotEl) {
      if (highRiskCount > 0 || riskClauses.length > 0) {
        dotEl.className = 'tab-count';
        dotEl.style.background = '#FEE2E2';
        dotEl.style.color = '#DC2626';
        dotEl.textContent = `위험 ${highRiskCount + riskClauses.length}건`;
      } else {
        dotEl.className = 'tab-count';
        dotEl.style.background = '#ECFDF5';
        dotEl.style.color = '#059669';
        dotEl.textContent = '정상';
      }
    }
  }

  // 2. 내부 문서 쟁점 및 위험 조항 영향도 분석 (1번 섹션)
  if (riskContainer) {
    if (riskClauses.length > 0) {
      const orderedRiskClauses = [...riskClauses].sort((a, b) => {
        const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        return (rank[a.riskLevel] ?? 3) - (rank[b.riskLevel] ?? 3);
      });
      let riskHtml = '<div class="impact-risk-grid">';
      orderedRiskClauses.forEach((chunk, index) => {
        const tags = chunk.riskTags || [];
        const level = chunk.riskLevel || (tags.some(tag => tag.level === 'HIGH') ? 'HIGH' : 'MEDIUM');
        const isHigh = level === 'HIGH';
        const tagsHtml = tags.map(t => `<span class="risk-topic-chip">${escapeHtml(t.label)}</span>`).join('');
        const keywords = [...new Set(tags.flatMap(tag => tag.matchedKeywords || []))];
        const keywordsHtml = keywords.length
          ? keywords.map(keyword => `<span class="risk-keyword">${escapeHtml(keyword)}</span>`).join('')
          : '<span class="risk-keyword muted">문맥 기반 탐지</span>';
        const actionGuide = isHigh
          ? '관련 상위 법령의 강행규정과 원문을 우선 대조하고, 적용 범위와 예외 요건을 확인한 뒤 문구 수정 여부를 결정하십시오.'
          : '위임 근거와 적용 범위를 확인하고, 모호한 표현은 담당 부서 또는 법률 전문가의 확인을 거쳐 보완하십시오.';
        
        riskHtml += `
          <article class="risk-analysis-card ${level.toLowerCase()}">
            <header class="risk-card-header">
              <div class="risk-card-heading">
                <span class="risk-order">${index + 1}</span>
                <div>
                  <div class="risk-card-kicker">${escapeHtml(chunk.articleNo || '조항')} · 내부 문서</div>
                  <h5>${escapeHtml(chunk.title || '제목 없는 조항')}</h5>
                </div>
              </div>
              <span class="risk-level-badge ${level.toLowerCase()}">
                <span class="material-symbols-outlined">${isHigh ? 'priority_high' : 'error_outline'}</span>
                ${isHigh ? '우선 검토' : '확인 필요'}
              </span>
            </header>
            <div class="risk-topic-row">${tagsHtml}</div>
            <div class="risk-card-body">
              <div class="risk-info-block">
                <span class="risk-info-label"><span class="material-symbols-outlined">search</span>탐지 근거</span>
                <div class="risk-keywords">${keywordsHtml}</div>
              </div>
              <div class="risk-info-block action">
                <span class="risk-info-label"><span class="material-symbols-outlined">task_alt</span>권장 확인 절차</span>
                <p>${escapeHtml(actionGuide)}</p>
              </div>
            </div>
            <details class="risk-source-details">
              <summary><span class="material-symbols-outlined">description</span>문서 원문 보기<span class="material-symbols-outlined chevron">expand_more</span></summary>
              <div class="risk-source-text">${escapeHtml(chunk.content || '원문 내용이 없습니다.')}</div>
            </details>
          </article>
        `;
      });
      riskHtml += '</div>';
      riskContainer.innerHTML = riskHtml;
    } else {
      riskContainer.innerHTML = `
        <div class="impact-empty-state success">
          <span class="material-symbols-outlined">verified</span>
          <div><strong>우선 검토할 위험 조항이 감지되지 않았습니다.</strong><span>자동 탐지 결과이며, 최종 판단은 아래 공식 조문 대조 결과와 함께 확인하십시오.</span></div>
        </div>
      `;
    }
  }

  // 3. 조문 인용 충돌 및 개정 적합성 대조표 (2번 섹션: 테이블 형태 렌더링)
  if (itemsContainer) {
    const items = impactMap?.impactItems || [];
    if (items.length > 0) {
      const STATUS_CONFIG = {
        VALID: {
          label: '현행 유효',
          icon: 'check_circle',
          badgeClass: 'badge-gov',
          guideClass: 'valid',
          guideIcon: 'check_circle'
        },
        DELETED: {
          label: '조문 삭제/폐지',
          icon: 'cancel',
          badgeClass: 'badge-risk HIGH',
          guideClass: 'deleted',
          guideIcon: 'error'
        },
        OLD_LAW: {
          label: '구법 인용 의심',
          icon: 'warning',
          badgeClass: 'badge-risk HIGH',
          guideClass: 'old-law',
          guideIcon: 'warning'
        },
        CAUTION: {
          label: '조문 확인 필요',
          icon: 'help',
          badgeClass: 'badge-risk MEDIUM',
          guideClass: 'caution',
          guideIcon: 'info'
        }
      };

      let tableHtml = `
        <div class="table-responsive" style="margin-top: 10px; border: 1px solid #CBD5E1; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <table class="legal-table impact-comparison-table">
            <thead>
              <tr>
                <th style="width: 22%; text-align: left;">인용 / 대상 조문</th>
                <th style="width: 14%; text-align: center;">적합성 판정</th>
                <th style="width: 32%; text-align: left;">현행 법령 공식 규정 요지</th>
                <th style="width: 32%; text-align: left;">개정 영향 분석 및 실무 조치 가이드</th>
              </tr>
            </thead>
            <tbody>
      `;

      items.forEach(item => {
        const stKey = item.status || (item.riskLevel === 'HIGH' ? 'DELETED' : (item.riskLevel === 'CAUTION' ? 'CAUTION' : 'VALID'));
        const conf = STATUS_CONFIG[stKey] || STATUS_CONFIG.VALID;
        const isConflict = stKey === 'DELETED' || stKey === 'OLD_LAW';

        tableHtml += `
          <tr class="${isConflict ? 'row-conflict' : ''}">
            <!-- 1. 조문 명칭 -->
            <td>
              <div class="impact-art-law">${escapeHtml(item.lawName || lawName)}</div>
              <div class="impact-art-title">${escapeHtml(item.articleTitle || item.citation || '')}</div>
            </td>

            <!-- 2. 적합성 판정 뱃지 -->
            <td style="text-align: center; vertical-align: middle;">
              <span class="badge ${conf.badgeClass}" style="display:inline-flex; align-items:center; gap:4px; font-weight:700; font-size:11.5px; padding:4px 8px;">
                <span class="material-symbols-outlined" style="font-size:14px;">${conf.icon}</span>
                <span>${conf.label}</span>
              </span>
            </td>

            <!-- 3. 현행 공식 법령 내용 -->
            <td>
              <div class="statute-box">
                <span class="statute-tag">공식 조문 내용</span>
                <div>${escapeHtml(item.currentTextSnippet || '공식 법령 조문 본문 참조')}</div>
              </div>
            </td>

            <!-- 4. 실무 조치 가이드 -->
            <td>
              <div class="guide-box ${conf.guideClass}">
                <div style="font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:5px;">
                  <span class="material-symbols-outlined" style="font-size:15px; vertical-align:middle;">${conf.guideIcon}</span>
                  <span>${isConflict ? '주의 및 조치 필요' : '실무 적용 기준'}</span>
                </div>
                <div>${escapeHtml(item.actionGuide || item.note || '현행 조문 규정을 준수하십시오.')}</div>
              </div>
            </td>
          </tr>
        `;
      });

      tableHtml += `
            </tbody>
          </table>
        </div>
      `;

      itemsContainer.innerHTML = tableHtml;
    } else {
      itemsContainer.innerHTML = '<p class="placeholder-text">수집된 조문 적합성 대조 데이터가 없습니다.</p>';
    }
  }

  // 4. 소관 법령 최근 개정 연혁 및 시행 타임라인 (3번 섹션)
  if (historyContainer) {
    const timeline = lawHistory?.timeline || [];
    if (timeline.length > 0) {
      let timelineHtml = `
        <div class="table-responsive" style="margin-top: 10px;">
          <table class="legal-table">
            <thead>
              <tr>
                <th style="width: 25%;">법령명 및 구분</th>
                <th style="width: 20%; text-align: center;">공포일자 (공포번호)</th>
                <th style="width: 20%; text-align: center;">시행일자</th>
                <th style="width: 20%;">소관 부처</th>
                <th style="width: 15%; text-align: center;">개정 상태</th>
              </tr>
            </thead>
            <tbody>
      `;

      timeline.slice(0, 5).forEach((h, idx) => {
        const isLatest = idx === 0;
        timelineHtml += `
          <tr>
            <td class="cell-bold">${escapeHtml(h.lawName)} <span class="badge" style="background:#F1F5F9; color:#475569; font-size:10px;">${escapeHtml(h.lawType || '법령')}</span></td>
            <td class="cell-center">${escapeHtml(h.promulDate || '-')} ${h.promulNo ? `<small>(${h.promulNo}호)</small>` : ''}</td>
            <td class="cell-center"><strong>${escapeHtml(h.enforceDate || '-')}</strong></td>
            <td>${escapeHtml(h.ministry || '소관부처')}</td>
            <td class="cell-center">
              <span class="badge ${isLatest ? 'badge-gov' : 'badge-gray'}">${isLatest ? '현행 법령' : '종전 개정'}</span>
            </td>
          </tr>
        `;
      });

      timelineHtml += `
            </tbody>
          </table>
        </div>
      `;
      historyContainer.innerHTML = timelineHtml;
    } else {
      historyContainer.innerHTML = `
        <div style="padding: 14px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; font-size: 13px; color: #64748B;">
          ${lawName}의 최신 개정 연혁 정보를 국가법령정보센터에서 연동 중입니다.
        </div>
      `;
    }
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
  renderWorkbench,
  resetWorkbenchTabs,
  resetWorkbench
};
