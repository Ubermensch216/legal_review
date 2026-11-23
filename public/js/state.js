// public/js/state.js - 클라이언트 상태 관리

const read = (key, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, value ?? ''); } catch { /* 저장이 막힌 환경에서도 화면은 동작한다 */ }
};

export const LLM_MODES = Object.freeze({ LOCAL_ONLY: 'LOCAL_ONLY', HYBRID: 'HYBRID', EXTERNAL_ONLY: 'EXTERNAL_ONLY' });

/**
 * 사용 방식에서 이번 검토의 주 제공자·모델을 정한다.
 * 내부 전용과 병용은 로컬 Ollama로 검토하고, 외부 전용만 외부 제공자로 검토한다.
 */
export function deriveSettings(settings) {
  const external = settings.mode === LLM_MODES.EXTERNAL_ONLY;
  return { ...settings,
    provider: external ? settings.externalProvider : 'ollama',
    modelName: external ? settings.externalModel : settings.localModel };
}

const initialMode = LLM_MODES[read('lr_mode')] || LLM_MODES.LOCAL_ONLY;

export const state = {
  currentPreset: '',
  selectedFile: null,
  isReviewing: false,
  lastReviewResult: null,
  // 외부 전문가 질의 탭에서 최종 검토를 다시 실행할 때만 채워진다. 실행 후 비운다.
  sourceHistoryId: null,
  config: null,
  settings: deriveSettings({
    mode: initialMode,
    // 비어 있으면 서버 .env의 모델을 쓴다. 여기에 모델명을 적어 두면 .env 설정을 덮어쓴다.
    localModel: read('lr_localModel') || (read('lr_provider', 'ollama') === 'ollama' ? read('lr_modelName') : ''),
    externalProvider: read('lr_extProvider', 'exaone') || 'exaone',
    externalModel: read('lr_extModel'),
    // 외부로 보낼 때 추가로 가릴 단어(기관명 등). 이 브라우저에만 저장된다.
    privateTerms: read('lr_privateTerms')
  })
};

export function saveSettings(newSettings) {
  state.settings = deriveSettings({ ...state.settings, ...newSettings });
  write('lr_mode', state.settings.mode);
  write('lr_localModel', state.settings.localModel);
  write('lr_extProvider', state.settings.externalProvider);
  write('lr_extModel', state.settings.externalModel);
  write('lr_privateTerms', state.settings.privateTerms);
  // 이전 버전과의 호환: 주 제공자·모델도 함께 남긴다.
  write('lr_provider', state.settings.provider);
  write('lr_modelName', state.settings.modelName);
}

/** 줄·쉼표로 적은 단어 목록 */
export const privateTermList = () => String(state.settings.privateTerms || '').split(/[\n,]/).map(x => x.trim()).filter(x => x.length >= 2);

export default state;
