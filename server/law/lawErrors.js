// server/law/lawErrors.js - 법령 에러 처리 및 시크릿 마스킹

/**
 * 로그나 에러 메시지에서 API 키나 시크릿 정보 마스킹
 * @param {string} text 
 * @returns {string}
 */
export function maskLawSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  
  return text
    .replace(/(OC=)([^&]+)/gi, '$1***')
    .replace(/(apiKey=)([^&]+)/gi, '$1***')
    .replace(/(key=)([^&]+)/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{10,}/gi, '$1***')
    .replace(/(sk-[A-Za-z0-9]{20,})/gi, 'sk-***');
}

/**
 * 법령 API 및 도구 전용 커스텀 에러 클래스
 */
export class LawApiError extends Error {
  constructor(message, options = {}) {
    super(maskLawSecrets(message));
    this.name = 'LawApiError';
    this.statusCode = options.statusCode || 500;
    this.code = options.code || 'LAW_API_ERROR';
    this.details = options.details ? maskLawSecrets(JSON.stringify(options.details)) : null;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * 클라이언트용 에러 응답 변환기
 * @param {Error} error 
 */
export function formatErrorResponse(error) {
  const isLawError = error instanceof LawApiError;
  return {
    ok: false,
    error: error.name || 'Error',
    code: isLawError ? error.code : 'INTERNAL_SERVER_ERROR',
    message: maskLawSecrets(error.message || '서버 내부 오류가 발생했습니다.'),
    statusCode: isLawError ? error.statusCode : 500,
    timestamp: new Date().toISOString()
  };
}

export default {
  maskLawSecrets,
  LawApiError,
  formatErrorResponse
};
