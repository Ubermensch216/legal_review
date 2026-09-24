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
    modelName: localStorage.getItem('lr_modelName') || 'gemma4:e4b'
  }
};

export function saveSettings(newSettings) {
  state.settings = { ...state.settings, ...newSettings };
  localStorage.setItem('lr_provider', state.settings.provider);
  localStorage.setItem('lr_modelName', state.settings.modelName);
}

export default state;
