// server/rateLimit.js - 경량 토큰 버킷 / 슬라이딩 윈도우 Rate Limiter

const requestWindows = new Map();

/**
 * 특정 키(예: IP 또는 API 종류)에 대한 Rate Limit 체크
 * @param {string} key - 식별자 (예: IP 또는 'law-drf')
 * @param {number} maxRequests - 윈도우 내 최대 허용 요청 수 (기본: 60)
 * @param {number} windowMs - 윈도우 시간(ms) (기본: 60000 = 1분)
 * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
 */
export function checkRateLimit(key, maxRequests = 60, windowMs = 60000) {
  const now = Date.now();
  let timestamps = requestWindows.get(key) || [];
  
  // 윈도우 지난 요청 제거
  timestamps = timestamps.filter(ts => now - ts < windowMs);
  
  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0];
    const resetMs = windowMs - (now - oldest);
    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.max(0, resetMs)
    };
  }
  
  timestamps.push(now);
  requestWindows.set(key, timestamps);
  
  return {
    allowed: true,
    remaining: maxRequests - timestamps.length,
    resetMs: windowMs
  };
}

/**
 * Express 미들웨어 생성 헬퍼
 * @param {number} maxRequests 
 * @param {number} windowMs 
 */
export function createRateLimitMiddleware(maxRequests = 100, windowMs = 60000) {
  return (req, res, next) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const result = checkRateLimit(`ip:${clientIp}`, maxRequests, windowMs);
    
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    
    if (!result.allowed) {
      res.setHeader('Retry-After', Math.ceil(result.resetMs / 1000));
      return res.status(429).json({
        ok: false,
        error: 'Too Many Requests',
        message: `요청 한도를 초과했습니다. ${Math.ceil(result.resetMs / 1000)}초 후 다시 시도해주세요.`
      });
    }
    
    next();
  };
}

export default {
  checkRateLimit,
  createRateLimitMiddleware
};
