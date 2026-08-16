// server/abort.js - 비동기 요청 취소 컨트롤러

const activeControllers = new Map();

/**
 * 요청 ID에 대한 AbortController 등록
 * @param {string} requestId 
 * @returns {AbortController}
 */
export function registerAbortController(requestId) {
  if (!requestId) return new AbortController();
  
  if (activeControllers.has(requestId)) {
    try {
      activeControllers.get(requestId).abort();
    } catch {
      // ignore
    }
  }
  
  const controller = new AbortController();
  activeControllers.set(requestId, controller);
  return controller;
}

/**
 * 특정 요청 취소
 * @param {string} requestId 
 * @returns {boolean}
 */
export function cancelRequest(requestId) {
  if (!requestId || !activeControllers.has(requestId)) return false;
  
  try {
    const controller = activeControllers.get(requestId);
    controller.abort();
    activeControllers.delete(requestId);
    return true;
  } catch (err) {
    console.error(`[Abort] Failed to abort request ${requestId}:`, err);
    return false;
  }
}

/**
 * 완료된 요청 컨트롤러 제거
 * @param {string} requestId 
 */
export function unregisterAbortController(requestId) {
  if (requestId) {
    activeControllers.delete(requestId);
  }
}

export default {
  registerAbortController,
  cancelRequest,
  unregisterAbortController
};
