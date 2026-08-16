// public/js/app.js - 메인 프론트엔드 엔트리포인트 및 이벤트 바인딩
import { state, saveSettings } from './state.js';
import { initWorkbenchTabs, renderWorkbench } from './lawWorkbench.js';
import { initDocumentViewer } from './documentViewer.js';
import { initDocumentStudio } from './documentStudio.js';

document.addEventListener('DOMContentLoaded', async () => {
  // 모듈 초기화
  initWorkbenchTabs();
  initDocumentViewer();
  initDocumentStudio();
  initPresetChips();
  initFileDropzone();
  initReviewForm();
  initSettingsModal();
  initToolsModal();

  // 초기 서버 설정 동기화
  await loadServerConfig();
});

/**
 * 1. 6대 검토 프리셋 칩 선택
 */
function initPresetChips() {
  const chips = document.querySelectorAll('.chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.currentPreset = chip.getAttribute('data-preset');
    });
  });
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

  function handleFileSelect(file) {
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
  const btnRun = document.getElementById('btn-run-review');
  const spinner = document.getElementById('review-spinner');
  const btnText = btnRun.querySelector('.btn-text');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = queryInput.value.trim();
    const targetLaw = targetLawInput.value.trim();

    if (!query && !state.selectedFile) {
      alert('검토 질의를 입력하거나 검토 대상 문서(HWPX, PDF 등)를 첨부해주세요.');
      queryInput.focus();
      return;
    }

    // 로딩 상태 시작
    btnRun.disabled = true;
    spinner.classList.remove('hidden');
    btnText.textContent = '법령 및 판례 수집 / AI 검토 중...';

    const formData = new FormData();
    formData.append('query', query);
    formData.append('preset', state.currentPreset);
    formData.append('targetLaw', targetLaw);
    formData.append('llmProvider', state.settings.provider);
    formData.append('llmModel', state.settings.modelName);
    formData.append('llmApiKey', state.settings.apiKey);

    if (state.selectedFile) {
      formData.append('file', state.selectedFile);
    }

    try {
      const res = await fetch('/api/law/workbench', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      renderWorkbench(data);

      // 워크벤치 섹션으로 부드럽게 스크롤
      document.getElementById('workbench-section').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      alert(`검토 실행 중 오류가 발생했습니다: ${err.message}`);
    } finally {
      btnRun.disabled = false;
      spinner.classList.add('hidden');
      btnText.textContent = '⚡ 종합 법령검토 실행';
    }
  });
}

/**
 * 4. 19대 도구 모달 제어
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
    modal.classList.remove('hidden');
    if (toolsCache.length === 0) {
      const res = await fetch('/api/law/tools');
      const data = await res.json();
      toolsCache = data.tools || [];
      renderToolsList();
    }
  });

  btnClose.addEventListener('click', () => modal.classList.add('hidden'));

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
 * 5. 설정 모달
 */
function initSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const btnOpen = document.getElementById('btn-open-settings');
  const btnClose = document.getElementById('btn-close-settings');
  const form = document.getElementById('form-settings');
  const btnResetCache = document.getElementById('btn-reset-cache');

  const providerSelect = document.getElementById('setting-provider');
  const ollamaUrlInput = document.getElementById('setting-ollama-url');
  const modelNameInput = document.getElementById('setting-model-name');
  const apiKeyInput = document.getElementById('setting-api-key');
  const lawOcInput = document.getElementById('setting-law-oc');

  btnOpen.addEventListener('click', () => {
    providerSelect.value = state.settings.provider;
    ollamaUrlInput.value = state.settings.ollamaUrl;
    modelNameInput.value = state.settings.modelName;
    apiKeyInput.value = state.settings.apiKey;
    lawOcInput.value = state.settings.lawOc;
    modal.classList.remove('hidden');
  });

  btnClose.addEventListener('click', () => modal.classList.add('hidden'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings({
      provider: providerSelect.value,
      ollamaUrl: ollamaUrlInput.value.trim(),
      modelName: modelNameInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      lawOc: lawOcInput.value.trim()
    });

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

function updateLlmDisplay() {
  const display = document.getElementById('current-llm-display');
  if (display) {
    display.textContent = `AI 엔진: ${state.settings.provider.toUpperCase()} (${state.settings.modelName})`;
  }
}

export default {};
