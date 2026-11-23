// public/js/app.js - 메인 프론트엔드 엔트리포인트 및 이벤트 바인딩
import { state, saveSettings, LLM_MODES } from './state.js';
import { confirmReviewTransmission } from './externalLlm.js';
import { initWorkbenchTabs, renderWorkbench, resetWorkbenchTabs, resetWorkbench } from './lawWorkbench.js';
import { initDocumentViewer } from './documentViewer.js';
import { initDocumentStudio, resetStudio } from './documentStudio.js';
import { initHistoryDrawer, refreshHistoryList, addHistoryRecord } from './history.js';
import { initLearningTab } from './learningTab.js';
import { initWorkspaceLayout } from './workspaceLayout.js';
import { initReviewTrace, startReviewTrace, pushTraceEvent, finishReviewTrace, showTraceFallback, resetReviewTrace } from './reviewTrace.js';

document.addEventListener('DOMContentLoaded', async () => {
  // 모듈 초기화
  initWorkspaceLayout();
  initWorkbenchTabs();
  initLearningTab();
  initReviewTrace();
  initDocumentViewer();
  initDocumentStudio();
  initHistoryDrawer();
  initPresetChips();
  initFileDropzone();
  initReviewInputStepToggles();
  initReviewForm();
  initNewReviewButton();
  initSettingsModal();
  initToolsModal();

  // 초기 서버 설정 동기화
  await loadServerConfig();
});

/**
 * 6대 검토 유형별 20년 차 베테랑 변호사 전문 프롬프트 템플릿
 */
const PRESET_EXPERT_PROMPTS = {
  compliance: {
    query: '첨부된 문서(또는 사안)의 주요 조항 및 업무 프로세스가 관련 상위 법령(시행령·시행규칙)의 강행규정, 인허가 요건, 법정 의무사항을 충족하고 있는지 전면 검토하고, 위반 소지나 규제 리스크가 있는 항목에 대한 개선 권고사항을 제시해주세요.',
    targetLaw: '행정기본법'
  },
  contract_risk: {
    query: '첨부된 계약서(협약서) 전문을 심층 검토하여 일방 당사자에게 현저히 불리한 독소조항, 손해배상 및 위약벌 과다 위험, 해제·해지 요건의 모호성, 지식재산권 귀속 및 비밀유지 의무의 적정성을 분석하고 수정 조문 대안을 제시해주세요.',
    targetLaw: '민법, 약관의 규제에 관한 법률'
  },
  ordinance_conflict: {
    query: '첨부된 조례안(또는 사규·내부지침)의 각 조항이 상위 법률의 명시적 위임 범위를 일탈(법률유보원칙 위반)했는지, 포괄위임금지 및 과잉금지원칙에 반하여 주민(구성원)의 권리를 제한하거나 의무를 부과하는 무효 조항이 존재하는지 검토해주세요.',
    targetLaw: '지방자치법, 행정기본법'
  },
  admin_dispute: {
    query: '본 사안에 따른 감독관청의 시정명령, 영업정지, 과징금 등 불이익 행정처분의 실체적·절차적 적법성(사전통지, 의견제출 절차 준수 여부)을 검토하고, 행정심판 및 행정소송 관점에서의 방어 논리와 처분 취소 가능성을 평가해주세요.',
    targetLaw: '행정절차법, 행정심판법, 행정소송법'
  },
  privacy_security: {
    query: '첨부된 업무 절차 및 개인정보 처리방침 상 필수/선택 수집 항목의 최소 수집 원칙 준수 여부, 제3자 제공 및 위탁 동의 절차의 적법성, 안전성 확보조치(암호화, 접근통제) 이행 요건 충족 여부를 정밀 검토해주세요.',
    targetLaw: '개인정보 보호법'
  },
  labor_hr: {
    query: '취업규칙, 근로계약서, 임금·근로시간 운영 기준이 근로기준법 및 관련 노동법령의 최저기준을 준수하고 있는지 검토하고, 해고·징계의 정당한 이유, 연장·야간수당 산정, 주휴수당 등 노사 분쟁 취약 조항에 대한 정비 방안을 제시해주세요.',
    targetLaw: '근로기준법, 노동조합법'
  }
};

/**
 * 1. 6대 검토 프리셋 칩 선택 및 전문가 프롬프트 자동 세팅
 */
function initPresetChips() {
  const chips = document.querySelectorAll('.chip');
  const queryTextarea = document.getElementById('input-query');
  const targetLawInput = document.getElementById('input-target-law');

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const presetKey = chip.getAttribute('data-preset');
      state.currentPreset = presetKey;

      const template = PRESET_EXPERT_PROMPTS[presetKey];
      if (template) {
        // 질의 입력창에 전문가 프롬프트 자동 세팅
        if (queryTextarea) {
          queryTextarea.value = template.query;
          queryTextarea.focus();
          queryTextarea.classList.add('pulse-highlight');
          setTimeout(() => queryTextarea.classList.remove('pulse-highlight'), 600);
        }
        // 기준 법령 입력창이 비어있거나 기존 프리셋 기본값이었던 경우 자동 세팅
        if (targetLawInput && (!targetLawInput.value.trim() || Object.values(PRESET_EXPERT_PROMPTS).some(p => p.targetLaw === targetLawInput.value.trim()))) {
          targetLawInput.value = template.targetLaw;
        }
        updateQueryOptionsSummary();
      }
    });
  });

  // 질의 박스 우측 상단 초기화 버튼
  const btnResetQuery = document.getElementById('btn-reset-query');
  if (btnResetQuery) {
    btnResetQuery.addEventListener('click', () => {
      if (queryTextarea) {
        queryTextarea.value = '';
        queryTextarea.focus();
      }
      chips.forEach(c => c.classList.remove('active'));
      state.currentPreset = '';

      if (targetLawInput && Object.values(PRESET_EXPERT_PROMPTS).some(p => p.targetLaw === targetLawInput.value.trim())) {
        targetLawInput.value = '';
      }

      updateQueryOptionsSummary();
      resetWorkbenchTabs();
    });
  }
}

function updateQueryOptionsSummary() {
  const summary = document.getElementById('query-options-summary');
  if (!summary) return;

  const targetLaw = document.getElementById('input-target-law')?.value.trim();
  const targetDate = document.getElementById('input-target-date')?.value.trim();
  const values = [];
  if (targetLaw) values.push(`기준 법령: ${targetLaw}`);
  if (targetDate) values.push(`기준 시점: ${targetDate}`);
  summary.textContent = values.length ? values.join(' · ') : 'AI 자동 판별 · 현행 법령 기준';
}

function updateCollapsedInputSummaries() {
  const fileSummary = document.getElementById('document-summary-text');
  const querySummary = document.getElementById('query-summary-text');
  const query = document.getElementById('input-query')?.value.trim() || '';
  const targetLaw = document.getElementById('input-target-law')?.value.trim() || '';
  const targetDate = document.getElementById('input-target-date')?.value.trim() || '';
  const activePreset = document.querySelector('.chip.active');
  const presetLabel = activePreset?.querySelector('span:last-child')?.textContent.trim();

  if (fileSummary) {
    fileSummary.textContent = state.selectedFile?.name || '첨부 문서 없음 · 직접 질의로 검토';
  }

  if (querySummary) {
    const parts = [presetLabel ? `템플릿: ${presetLabel}` : '직접 작성한 질의'];
    if (query) parts.push(`질의: ${query.slice(0, 90)}${query.length > 90 ? '…' : ''}`);
    if (targetLaw) parts.push(`기준 법령: ${targetLaw}`);
    if (targetDate) parts.push(`기준 시점: ${targetDate}`);
    querySummary.textContent = parts.join(' · ');
  }
}

function setReviewInputStepCollapsed(step, collapsed) {
  const toggle = step?.querySelector('.step-toggle');
  if (!toggle) return;

  step.classList.toggle('is-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', `${step.querySelector('.step-label')?.textContent.trim()} ${collapsed ? '펼치기' : '접기'}`);
  toggle.querySelector('.step-toggle-label').textContent = collapsed ? '펼치기' : '접기';
  toggle.querySelector('.material-symbols-outlined').textContent = collapsed ? 'expand_more' : 'expand_less';
  step.querySelector('.step-collapsed-summary')?.setAttribute('aria-hidden', String(!collapsed));
}

function setReviewInputStepsCollapsed(collapsed) {
  document.querySelectorAll('.step-document, .step-query').forEach(step => {
    setReviewInputStepCollapsed(step, collapsed);
  });
}

function initReviewInputStepToggles() {
  document.querySelectorAll('.step-document, .step-query').forEach(step => {
    step.querySelector('.step-toggle')?.addEventListener('click', () => {
      if (!step.classList.contains('is-collapsed')) updateCollapsedInputSummaries();
      setReviewInputStepCollapsed(step, !step.classList.contains('is-collapsed'));
    });
  });
}

/**
 * 현재 화면의 입력·첨부 파일·검토 결과만 비우고 새 리뷰를 시작한다.
 * 저장된 검토 이력은 다시 불러올 수 있어야 하므로 IndexedDB/서버 이력은 건드리지 않는다.
 */
function initNewReviewButton() {
  const button = document.getElementById('btn-new-review');
  if (!button) return;

  button.addEventListener('click', () => {
    if (state.isReviewing) {
      alert('검토가 진행 중입니다. 현재 검토가 끝난 후 새 리뷰를 시작해주세요.');
      return;
    }

    const trace = document.getElementById('review-trace');
    const hasCurrentReview = Boolean(
      state.lastReviewResult
      || state.selectedFile
      || document.getElementById('input-query')?.value.trim()
      || document.getElementById('input-target-law')?.value.trim()
      || document.getElementById('input-target-date')?.value
      || (trace && !trace.classList.contains('hidden'))
    );

    if (hasCurrentReview && !confirm('현재 입력, 첨부 파일, 검토 결과와 진행 기록을 초기화하고 새 리뷰를 시작하시겠습니까?\n\n저장된 검토 이력은 삭제되지 않습니다.')) {
      return;
    }

    resetCurrentReview();
  });
}

function resetCurrentReview() {
  const queryInput = document.getElementById('input-query');
  const targetLawInput = document.getElementById('input-target-law');
  const targetDateInput = document.getElementById('input-target-date');
  const fileInput = document.getElementById('file-input');
  const attachedInfo = document.getElementById('attached-file-info');
  const dropzoneContent = document.getElementById('dropzone-content');

  if (queryInput) queryInput.value = '';
  if (targetLawInput) targetLawInput.value = '';
  if (targetDateInput) targetDateInput.value = '';
  if (fileInput) fileInput.value = '';
  if (attachedInfo) attachedInfo.classList.add('hidden');
  if (dropzoneContent) dropzoneContent.classList.remove('hidden');
  setReviewInputStepsCollapsed(false);
  document.querySelectorAll('.query-details').forEach(details => { details.open = false; });

  document.querySelectorAll('.chip').forEach(chip => chip.classList.remove('active'));
  state.currentPreset = '';
  state.selectedFile = null;
  state.lastReviewResult = null;
  state.sourceHistoryId = null;
  state.manualLearningRerun = false;
  window.__reliability = null;
  updateQueryOptionsSummary();

  resetWorkbench();
  resetReviewTrace();
  resetStudio();
  document.getElementById('input-query')?.focus();
}

/**
 * 2. 첨부문서 파일 드롭존
 */
function initFileDropzone() {
  const dropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  const dropzoneContent = document.getElementById('dropzone-content');
  const attachedInfo = document.getElementById('attached-file-info');
  const fileNameEl = document.getElementById('file-name');
  const fileSizeEl = document.getElementById('file-size');
  const fileBadgeEl = document.getElementById('file-badge');
  const btnRemove = document.getElementById('btn-remove-file');

  dropzone.addEventListener('click', (e) => {
    if (e.target !== btnRemove) {
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
    }
  });

  btnRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    state.selectedFile = null;
    fileInput.value = '';
    attachedInfo.classList.add('hidden');
    dropzoneContent.classList.remove('hidden');
  });

  // 서버(parsers/index.js)와 같은 목록이다. 서버가 한 번 더 확인하므로 여기서는 빨리 알려 주는 용도다.
  const SUPPORTED_EXT = ['hwpx', 'pdf', 'docx', 'xlsx', 'csv', 'txt', 'md', 'json'];
  const LEGACY_HINT = { hwp: '구형 한글(.hwp)은 읽을 수 없습니다. .hwpx 또는 .pdf로 다시 저장해 첨부해 주세요.',
    xls: '구형 엑셀(.xls)은 읽을 수 없습니다. .xlsx 또는 .csv로 다시 저장해 첨부해 주세요.',
    doc: '구형 워드(.doc)는 읽을 수 없습니다. .docx 또는 .pdf로 다시 저장해 첨부해 주세요.' };

  function handleFileSelect(file) {
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    if (!SUPPORTED_EXT.includes(extension)) {
      alert(LEGACY_HINT[extension] || `지원하지 않는 파일 형식(.${extension})입니다. ${SUPPORTED_EXT.map(e => `.${e}`).join(', ')} 파일을 첨부해 주세요.`);
      fileInput.value = '';
      return;
    }
    state.selectedFile = file;
    const ext = file.name.split('.').pop().toUpperCase();
    fileBadgeEl.textContent = ext;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = `(${(file.size / 1024).toFixed(1)} KB)`;

    dropzoneContent.classList.add('hidden');
    attachedInfo.classList.remove('hidden');
  }
}

/**
 * 3. 법령 검토 실행 폼
 */
function initReviewForm() {
  const form = document.getElementById('form-review');
  const queryInput = document.getElementById('input-query');
  const targetLawInput = document.getElementById('input-target-law');
  const targetDateInput = document.getElementById('input-target-date');
  const btnRun = document.getElementById('btn-run-review');
  const spinner = document.getElementById('review-spinner');
  const newReviewButton = document.getElementById('btn-new-review');
  const btnText = btnRun.querySelector('.btn-text');
  document.getElementById('manual-learning-mode')?.addEventListener('change', updateLlmDisplay);
  targetLawInput?.addEventListener('input', updateQueryOptionsSummary);
  targetDateInput?.addEventListener('input', updateQueryOptionsSummary);
  updateQueryOptionsSummary();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.isReviewing) return;
    const manualLearning = state.manualLearningRerun || usesLocalReviewPath();
    const query = queryInput.value.trim();
    const targetLaw = targetLawInput.value.trim();
    // <input type="date">는 YYYY-MM-DD로 준다. 서버가 두 형식을 모두 받는다.
    const targetDate = targetDateInput ? targetDateInput.value.trim() : '';

    if (!query && !state.selectedFile) {
      state.sourceHistoryId = null;
      state.manualLearningRerun = false;
      alert('검토 질의를 입력하거나 검토 대상 문서(HWPX, PDF 등)를 첨부해주세요.');
      queryInput.focus();
      return;
    }

    // 외부 LLM만 쓰는 모드: 개인정보를 가린 전송 내용을 확인·승인해야만 검토를 시작한다.
    let externalApproval = null;
    if (state.settings.mode === LLM_MODES.EXTERNAL_ONLY && !state.manualLearningRerun) {
      externalApproval = await confirmReviewTransmission({ query, file: state.selectedFile, provider: state.settings.provider });
      if (!externalApproval) return;
    }

    updateCollapsedInputSummaries();
    // 2분할 화면에서는 입력을 결과 옆에 계속 보여주고, 세로로 쌓인 좁은 화면에서만 접는다.
    if (window.matchMedia('(max-width: 1099px)').matches) setReviewInputStepsCollapsed(true);

    // 로딩 상태 시작
    state.isReviewing = true;
    if (newReviewButton) newReviewButton.disabled = true;
    btnRun.disabled = true;
    btnRun.classList.add('ai-processing');
    btnRun.setAttribute('aria-busy', 'true');
    spinner.classList.remove('hidden');
    btnText.textContent = manualLearning
      ? '승인된 외부 지식 반영·최종 재검토 중...'
      : '법령 및 판례 수집 / AI 검토 중...';

    const formData = new FormData();
    formData.append('query', query);
    formData.append('preset', state.currentPreset || 'compliance');
    formData.append('targetLaw', targetLaw);
    formData.append('targetDate', targetDate);
    // 진행 상황을 NDJSON으로 받는다. 스트림을 읽을 수 없는 환경이면 서버가 단일 JSON으로 답한다.
    const canStream = typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined';
    if (canStream) formData.append('stream', '1');
    if (manualLearning) {
      formData.append('learningMode', 'manual');
      formData.append('llmProvider', 'ollama');
      // 다른 제공자의 모델명을 Ollama에 넘기면 호출이 실패한다. 없으면 서버의 OLLAMA_MODEL을 쓴다.
      if (state.settings.provider === 'ollama' && state.settings.modelName) {
        formData.append('llmModel', state.settings.modelName);
      }
    } else {
      formData.append('llmProvider', state.settings.provider);
      if (state.settings.modelName) formData.append('llmModel', state.settings.modelName);
    }
    if (externalApproval) {
      formData.append('externalApprovalDigest', externalApproval.digest);
      formData.append('privateTerms', JSON.stringify(externalApproval.terms));
    }

    // 같은 사건의 재검토라면 그 이력을 알려, 그 사건에서 승인한 지식을 검토에 싣는다.
    if (state.sourceHistoryId) formData.append('sourceHistoryId', state.sourceHistoryId);

    if (state.selectedFile) {
      formData.append('file', state.selectedFile);
    }

    const activeProvider = manualLearning ? 'ollama' : state.settings.provider;
    const activeModel = (manualLearning && state.settings.provider !== 'ollama')
      ? (state.config?.models?.ollama || 'gemma4:e2b')
      : (state.settings.modelName || state.config?.models?.[activeProvider] || '');

    if (canStream) {
      startReviewTrace({
        provider: activeProvider,
        model: activeModel
      });
    } else {
      showTraceFallback();
    }

    try {
      const res = await fetch('/api/law/workbench', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        // error는 오류 종류 이름(예: Error)일 수 있어 사람이 읽을 message를 먼저 쓴다.
        throw new Error(errJson.message || errJson.error || `HTTP ${res.status}`);
      }

      const data = (res.headers.get('content-type') || '').includes('application/x-ndjson')
        ? await consumeReviewStream(res)
        : await res.json();

      finishReviewTrace({ totalMs: data.progressTrace?.totalMs ?? null });
      // 이 검토의 중간 산출물이 서버 메모리에 있는 동안에만 외부 재검토 제안을 보여 준다.
      data.escalationLive = true;
      renderWorkbench(data);
      await addHistoryRecord(data);

      // 워크벤치 섹션으로 부드럽게 스크롤
      document.getElementById('workbench-section').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      finishReviewTrace({ summary: err.message, failed: true });
      alert(`검토 실행 중 오류가 발생했습니다: ${err.message}`);
    } finally {
      // 한 번의 실행에만 적용한다. 남겨두면 이후 일반 검토에 엉뚱한 사건의 지식이 실린다.
      state.sourceHistoryId = null;
      state.manualLearningRerun = false;
      state.isReviewing = false;
      if (newReviewButton) newReviewButton.disabled = false;
      btnRun.disabled = false;
      btnRun.classList.remove('ai-processing');
      btnRun.removeAttribute('aria-busy');
      spinner.classList.add('hidden');
      btnText.textContent = '종합 법령검토 실행';
    }
  });
}

/**
 * 검토 진행 스트림(NDJSON) 소비.
 * 한 줄에 JSON 한 개가 온다. progress는 타임라인으로 흘리고, result를 최종 결과로 돌려준다.
 * 줄이 청크 경계에서 잘릴 수 있으므로 개행 단위로만 파싱한다.
 */
async function consumeReviewStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let result = null;
  let streamError = null;

  const handleLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; } // 불완전한 줄은 버린다
    if (msg.type === 'progress') pushTraceEvent(msg.event);
    else if (msg.type === 'result') result = msg.payload;
    else if (msg.type === 'error') streamError = msg.error || msg.message || '검토 실행 실패';
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  handleLine(buffer);

  if (streamError) throw new Error(streamError);
  if (!result) throw new Error('검토 결과를 받지 못했습니다. 서버 연결이 끊겼을 수 있습니다.');
  return result;
}

/**
 * 4. 19대 도구 드로어 제어
 */
let toolsCache = [];
let selectedTool = null;

function initToolsModal() {
  const modal = document.getElementById('tools-modal');
  const btnOpen = document.getElementById('btn-open-tools');
  const btnClose = document.getElementById('btn-close-tools');
  const toolsListEl = document.getElementById('tools-list');
  const titleEl = document.getElementById('selected-tool-title');
  const descEl = document.getElementById('selected-tool-desc');
  const formEl = document.getElementById('tool-params-form');
  const btnExec = document.getElementById('btn-exec-tool');
  const resultJson = document.getElementById('tool-result-json');

  btnOpen.addEventListener('click', async () => {
    modal.classList.add('open');
    if (toolsCache.length === 0) {
      const res = await fetch('/api/law/tools');
      const data = await res.json();
      toolsCache = data.tools || [];
      renderToolsList();
    }
  });

  btnClose.addEventListener('click', () => modal.classList.remove('open'));

  // 도구 드로어 바깥을 클릭하면 닫는다. 열기 버튼 자체는 예외로 둔다.
  document.addEventListener('click', (event) => {
    if (!modal?.classList.contains('open')) return;
    if (modal.contains(event.target) || btnOpen?.contains(event.target)) return;
    modal.classList.remove('open');
  });

  function renderToolsList() {
    toolsListEl.innerHTML = '';
    toolsCache.forEach((tool, idx) => {
      const btn = document.createElement('button');
      btn.className = `tool-item-btn ${idx === 0 ? 'active' : ''}`;
      btn.textContent = `${tool.name}`;
      btn.addEventListener('click', () => selectTool(tool, btn));
      toolsListEl.appendChild(btn);
    });

    if (toolsCache.length > 0) {
      selectTool(toolsCache[0], toolsListEl.firstChild);
    }
  }

  function selectTool(tool, btnEl) {
    selectedTool = tool;
    toolsListEl.querySelectorAll('.tool-item-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    titleEl.textContent = tool.name;
    descEl.textContent = tool.description;

    // 파라미터 폼 생성
    let formHtml = '';
    for (const [paramName, paramInfo] of Object.entries(tool.parameters || {})) {
      formHtml += `
        <div class="form-group">
          <label>${paramName} ${paramInfo.required ? '<span style="color:red">*</span>' : ''} <small style="color:#94a3b8">(${paramInfo.description})</small></label>
          <input type="text" class="tool-param-input" data-param="${paramName}" placeholder="${paramInfo.description}">
        </div>
      `;
    }
    formEl.innerHTML = formHtml;
  }

  btnExec.addEventListener('click', async () => {
    if (!selectedTool) return;
    const params = {};
    formEl.querySelectorAll('.tool-param-input').forEach(input => {
      const key = input.getAttribute('data-param');
      if (input.value.trim()) {
        params[key] = input.value.trim();
      }
    });

    resultJson.textContent = '도구 실행 중...';
    try {
      const res = await fetch('/api/law/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: selectedTool.name, params })
      });
      const data = await res.json();
      resultJson.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      resultJson.textContent = `오류: ${err.message}`;
    }
  });
}

/**
 * 최초 검토를 로컬 Ollama 경로로 실행하는가.
 * 설정에서 EXAONE을 고른 경우에만 외부 API로 보낸다. 다른 클라우드 제공자는 기존처럼 로컬로 실행한다.
 */
function usesLocalReviewPath() {
  return Boolean(document.getElementById('manual-learning-mode')?.checked) && state.settings.mode !== LLM_MODES.EXTERNAL_ONLY;
}

/**
 * 5. 설정 모달
 */
function initSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const btnOpen = document.getElementById('btn-open-settings');
  const btnClose = document.getElementById('btn-close-settings');
  const form = document.getElementById('form-settings');
  const btnResetCache = document.getElementById('btn-reset-cache');

  const providerSelect = document.getElementById('setting-provider');
  const modelSelect = document.getElementById('setting-model-select');
  const modelNameInput = document.getElementById('setting-model-name');
  const btnRefreshModels = document.getElementById('btn-refresh-models');
  const modelHint = document.getElementById('setting-model-hint');

  async function loadAvailableModels(provider, currentModel) {
    if (!modelSelect) return;
    modelSelect.disabled = true;
    if (btnRefreshModels) btnRefreshModels.disabled = true;
    modelSelect.innerHTML = '<option value="">서버 설치 모델 조회 중...</option>';
    if (modelHint) {
      modelHint.textContent = '';
      modelHint.style.color = 'var(--text-muted, #64748b)';
    }

    try {
      const q = new URLSearchParams({ provider });
      const res = await fetch(`/api/law/models?${q.toString()}`);
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];

      modelSelect.innerHTML = '';

      if (models.length === 0) {
        const opt = document.createElement('option');
        opt.value = '__custom__';
        opt.textContent = '(조회된 모델 없음 - 직접 입력)';
        modelSelect.appendChild(opt);
      } else {
        const inferenceModels = models.filter(m => !m.isEmbeddingOnly);
        const embedModels = models.filter(m => m.isEmbeddingOnly);

        inferenceModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.name;
          const details = [];
          if (m.parameterSize) details.push(m.parameterSize);
          if (m.quantization) details.push(m.quantization);
          if (m.description) details.push(m.description);
          opt.textContent = details.length ? `${m.name} (${details.join(' · ')})` : m.name;
          modelSelect.appendChild(opt);
        });

        if (embedModels.length > 0) {
          const group = document.createElement('optgroup');
          group.label = '임베딩 전용 모델 (법리 추론 불가)';
          embedModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.disabled = true;
            opt.textContent = `${m.name} (임베딩 전용)`;
            group.appendChild(opt);
          });
          modelSelect.appendChild(group);
        }

        const customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = '직접 입력...';
        modelSelect.appendChild(customOpt);
      }

      if (!data.ok && data.error && modelHint) {
        modelHint.textContent = `※ ${data.error}`;
        modelHint.style.color = '#ef4444';
      } else if (modelHint) {
        const count = models.filter(m => !m.isEmbeddingOnly).length;
        modelHint.textContent = provider === 'ollama'
          ? `Ollama 서버에 설치된 법리 추론 가능 모델 ${count}개 확인됨`
          : provider === 'exaone'
            ? 'EXAONE_API_KEY 설정됨 · 검토 시 질의와 첨부문서 내용이 LG AI연구원 API로 전송됩니다.'
            : '';
        modelHint.style.color = 'var(--text-muted, #64748b)';
      }

      const targetModel = currentModel || state.settings.modelName || state.config?.models?.[provider] || '';
      const matchingOpt = Array.from(modelSelect.options).find(o => o.value === targetModel && !o.disabled);
      if (matchingOpt) {
        modelSelect.value = targetModel;
        modelNameInput.classList.add('hidden');
        modelNameInput.value = targetModel;
      } else {
        modelSelect.value = '__custom__';
        modelNameInput.classList.remove('hidden');
        modelNameInput.value = targetModel;
      }
    } catch (err) {
      modelSelect.innerHTML = `
        <option value="gemma4:e4b">gemma4:e4b</option>
        <option value="gemma4:e2b">gemma4:e2b</option>
        <option value="__custom__">직접 입력...</option>
      `;
      if (modelHint) {
        modelHint.textContent = `※ 모델 목록 조회 실패: ${err.message}`;
        modelHint.style.color = '#ef4444';
      }
      const targetModel = currentModel || state.settings.modelName || state.config?.models?.[provider] || '';
      const matchingOpt = Array.from(modelSelect.options).find(o => o.value === targetModel);
      if (matchingOpt) {
        modelSelect.value = targetModel;
        modelNameInput.classList.add('hidden');
        modelNameInput.value = targetModel;
      } else {
        modelSelect.value = '__custom__';
        modelNameInput.classList.remove('hidden');
        modelNameInput.value = targetModel;
      }
    } finally {
      modelSelect.disabled = false;
      if (btnRefreshModels) btnRefreshModels.disabled = false;
    }
  }

  modelSelect?.addEventListener('change', () => {
    if (modelSelect.value === '__custom__') {
      modelNameInput.classList.remove('hidden');
      modelNameInput.focus();
    } else {
      modelNameInput.classList.add('hidden');
      modelNameInput.value = modelSelect.value;
    }
  });

  btnRefreshModels?.addEventListener('click', () => {
    const selected = modelSelect.value === '__custom__' ? modelNameInput.value.trim() : modelSelect.value;
    loadAvailableModels(providerSelect.value, selected);
  });

  providerSelect?.addEventListener('change', () => {
    const isOllama = providerSelect.value === 'ollama';
    if (btnRefreshModels) btnRefreshModels.style.display = isOllama ? 'inline-flex' : 'none';
    // 이전 제공자의 모델명이 새 제공자의 '직접 입력' 값으로 넘어가지 않게 한다.
    const provider = providerSelect.value;
    const model = provider === state.settings.provider && state.settings.modelName
      ? state.settings.modelName : (state.config?.models?.[provider] || '');
    loadAvailableModels(provider, model);
  });

  // 사용 방식(내부 / 병용 / 외부)에 따라 보이는 설정이 달라진다. 주 제공자는 방식이 정한다.
  const modeRadios = [...document.querySelectorAll('input[name="llm-mode"]')];
  const externalProviderSelect = document.getElementById('setting-external-provider');
  const externalModelInput = document.getElementById('setting-external-model');
  const externalHint = document.getElementById('setting-external-hint');
  const privateTermsInput = document.getElementById('setting-private-terms');
  const selectedMode = () => modeRadios.find(r => r.checked)?.value || LLM_MODES.LOCAL_ONLY;

  function updateExternalHint() {
    if (!externalHint) return;
    const provider = externalProviderSelect.value;
    const configured = state.config?.externalProviders?.[provider];
    externalHint.textContent = configured === false
      ? `서버 .env에 ${provider.toUpperCase()}_API_KEY가 설정되어 있지 않습니다. 키를 넣고 서버를 다시 시작하십시오.`
      : configured ? `${provider.toUpperCase()}_API_KEY 설정됨 · 승인한 내용만 전송됩니다.` : '';
    externalHint.style.color = configured === false ? '#ef4444' : 'var(--text-muted, #64748b)';
  }
  function applyModeUi() {
    const mode = selectedMode();
    const usesExternal = mode !== LLM_MODES.LOCAL_ONLY;
    document.getElementById('external-llm-settings')?.classList.toggle('hidden', !usesExternal);
    document.getElementById('private-terms-settings')?.classList.toggle('hidden', !usesExternal);
    document.getElementById('local-llm-settings')?.classList.add('hidden');
    document.getElementById('local-model-settings')?.classList.toggle('hidden', mode === LLM_MODES.EXTERNAL_ONLY);
    updateExternalHint();
  }
  modeRadios.forEach(radio => radio.addEventListener('change', applyModeUi));
  externalProviderSelect?.addEventListener('change', () => {
    externalModelInput.value = state.config?.models?.[externalProviderSelect.value] || '';
    updateExternalHint();
  });

  btnOpen.addEventListener('click', () => {
    providerSelect.value = 'ollama';
    modelNameInput.value = state.settings.localModel;
    modeRadios.forEach(radio => { radio.checked = radio.value === state.settings.mode; });
    externalProviderSelect.value = state.settings.externalProvider;
    externalModelInput.value = state.settings.externalModel;
    privateTermsInput.value = state.settings.privateTerms;
    applyModeUi();
    if (btnRefreshModels) btnRefreshModels.style.display = 'inline-flex';
    loadAvailableModels('ollama', state.settings.localModel);
    modal.classList.remove('hidden');
  });

  btnClose.addEventListener('click', () => modal.classList.add('hidden'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const localModel = (modelSelect.value === '__custom__'
      ? modelNameInput.value.trim()
      : modelSelect.value) || state.settings.localModel;
    const mode = selectedMode();
    const externalProvider = externalProviderSelect.value;
    if (mode !== LLM_MODES.LOCAL_ONLY && state.config?.externalProviders?.[externalProvider] === false) {
      alert(`${externalProvider.toUpperCase()}_API_KEY가 서버에 설정되어 있지 않아 이 방식을 사용할 수 없습니다. .env에 키를 넣고 서버를 다시 시작하십시오.`);
      return;
    }
    saveSettings({ mode, localModel, externalProvider, externalModel: externalModelInput.value.trim(),
      privateTerms: privateTermsInput.value.trim() });

    updateLlmDisplay();
    modal.classList.add('hidden');
    alert('설정이 저장되었습니다.');
  });

  btnResetCache.addEventListener('click', async () => {
    if (confirm('모든 법령/판례 캐시를 초기화하시겠습니까?')) {
      alert('캐시가 초기화되었습니다.');
    }
  });
}

async function loadServerConfig() {
  try {
    const res = await fetch('/api/law/config');
    const data = await res.json();
    state.config = data;
    updateLlmDisplay();
  } catch {
    // ignore
  }
}

const MODE_LABEL = { LOCAL_ONLY: '내부 LLM만', HYBRID: '내부 + 외부 병용', EXTERNAL_ONLY: '외부 LLM만' };

function updateLlmDisplay() {
  const display = document.getElementById('current-llm-display');
  if (!display) return;
  const { mode, localModel, externalProvider, externalModel } = state.settings;
  const local = localModel || state.config?.models?.ollama || 'gemma4:e2b';
  const external = `${externalProvider.toUpperCase()} (${externalModel || state.config?.models?.[externalProvider] || '모델 기본값'})`;
  display.textContent = mode === LLM_MODES.EXTERNAL_ONLY ? `외부 LLM만 · ${external}`
    : mode === LLM_MODES.HYBRID ? `내부 + 외부 병용 · 로컬 ${local} → 어려운 쟁점은 ${external}`
      : `${MODE_LABEL[mode]} · 로컬 Ollama (${local})`;
}

export default {};
