// public/js/state.js - 클라이언트 상태 관리

export const state = {
  currentPreset: '',
  selectedFile: null,
  isReviewing: false,
  lastReviewResult: null,
  // 외부 전문가 질의 탭에서 최종 검토를 다시 실행할 때만 채워진다. 실행 후 비운다.
  sourceHistoryId: null,
  config: null,
  settings: {
    provider: localStorage.getItem('lr_provider') || 'ollama',
    ollamaUrl: localStorage.getItem('lr_ollamaUrl') || 'http://localhost:11434',
    modelName: localStorage.getItem('lr_modelName') || 'gemma4:e2b',
    apiKey: localStorage.getItem('lr_apiKey') || '',
    lawOc: localStorage.getItem('lr_lawOc') || ''
  }
};

export function saveSettings(newSettings) {
  state.settings = { ...state.settings, ...newSettings };
  localStorage.setItem('lr_provider', state.settings.provider);
  localStorage.setItem('lr_ollamaUrl', state.settings.ollamaUrl);
  localStorage.setItem('lr_modelName', state.settings.modelName);
  localStorage.setItem('lr_apiKey', state.settings.apiKey);
  localStorage.setItem('lr_lawOc', state.settings.lawOc);
}

export default state;
