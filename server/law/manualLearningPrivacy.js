// Defense in depth for a human-reviewed export. Pattern matching is not anonymization proof.
const RULES = [
  ['주민번호', /\b\d{6}\s*[-–]?\s*[1-8]\d{6}\b/g],
  ['이메일', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['전화', /(?<!\d)(?:0(?:1[016789]|2|[3-6][1-5]|70)|\+82[- .]?(?:1[016789]|2|[3-6][1-5]|70))[- .]?\d{3,4}[- .]?\d{4}(?!\d)/g],
  ['사업자번호', /\b\d{3}-\d{2}-\d{5}\b/g],
  ['비밀키', /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{10,})\b/gi],
  ['주소링크', /https?:\/\/[^\s<>"\]]+/gi],
  ['파일경로', /(?:[A-Z]:[\\/]|\\\\)[^\s<>"\]]+/gi],
  ['식별번호', /(?<!\d)\d{12,19}(?!\d)/g],
  ['계좌번호', /\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b/g],
  ['비밀정보', /(?:비밀번호|password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*[^\s,;]+/gi],
  ['주소', /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)[가-힣]*(?:특별시|광역시|특별자치도|도|시)?\s+[가-힣]+(?:시|군|구)\s+[^\n,;]{0,45}(?:로|길|동|리)\s*\d+(?:-\d+)?/g],
  ['성명', /(?:성명|담당자|대표자|신청인|연락처)\s*[:：]\s*[가-힣]{2,5}/g],
];

export function privateTerms(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('추가 비식별 단어는 100개 이하여야 합니다.');
  return [...new Set(value.map(x => typeof x === 'string' ? x.trim() : '').filter(Boolean))]
    .filter(x => x.length >= 2 && x.length <= 200).sort((a, b) => b.length - a.length);
}

export function redactLearningText(value, terms = []) {
  let text = String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  const identities = new Map();
  const counts = {};
  const substitute = (kind, raw) => {
    const key = `${kind}:${raw}`;
    if (!identities.has(key)) identities.set(key, `[${kind}_${identities.size + 1}]`);
    counts[kind] = (counts[kind] || 0) + 1;
    return identities.get(key);
  };
  for (const term of privateTerms(terms)) text = text.split(term).join(substitute('비공개', term));
  // Count only actual replacements for custom terms.
  if (terms.length) counts['비공개'] = [...text.matchAll(/\[비공개_\d+\]/g)].length;
  for (const [kind, pattern] of RULES) text = text.replace(pattern, raw =>
    kind === '계좌번호' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : substitute(kind, raw));
  return { text, counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
    changed: text !== String(value || '') };
}

export function assertNoDetectedIdentifiers(text) {
  if (redactLearningText(text).changed) {
    const error = new Error('식별정보 후보가 남아 있습니다. 비식별 재검사를 수행한 뒤 다시 확인하십시오.');
    error.statusCode = 422;
    throw error;
  }
}
