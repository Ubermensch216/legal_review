// Local default: browser requests must originate from this server, including form submissions.
export function sameOriginOnly(req, res, next) {
  const origin = req.get('origin');
  const expected = `${req.protocol}://${req.get('host')}`;
  if ((origin && origin !== expected) || req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ ok: false, message: '다른 사이트에서 시작한 API 요청은 허용하지 않습니다.' });
  }
  next();
}
