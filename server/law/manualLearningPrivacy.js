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

// Model output is untrusted: a word appearing in the text is not evidence that it is personal data.
// Automatic patterns above already remove most structured identifiers before this check runs.
export function proposedPersonalTerms(value, text) {
  const body = String(text || '');
  const surname = '[김이박최정강조윤장임한오서신권황안송류홍전고문손배백허유남심노하곽성차주우구민진지엄채원천방공현함변염양도석]';
  return privateTerms(value).filter(term => {
    if (!body.includes(term)) return false;
    if (/^[가-힣]{3,4}$/.test(term) && new RegExp(`^${surname}[가-힣]{2,3}$`).test(term)) {
      const role = '(?:성명|신청인|민원인|담당자|대표자|피해자|피고인|원고|피고|정보주체)';
      return new RegExp(`${role}\\s*[:：]?\\s*${term}(?:은|는|이|가|을|를|의|과|와|에게|씨|님)?(?![가-힣])|(?<![가-힣])${term}\\s*(?:씨|님)(?![가-힣])`).test(body);
    }
    return false;
  });
}

function redactor(value, terms) {
  const identities = new Map();
  const counts = {};
  // Editing an already redacted document must not assign a new party an existing pseudonym.
  let next = Math.max(0, ...Array.from(String(value).matchAll(/\[[^\]\n]+_(\d+)\]/g), m => Number(m[1])));
  const substitute = (kind, raw) => {
    const key = `${kind}:${raw}`;
    if (!identities.has(key)) identities.set(key, `[${kind}_${++next}]`);
    counts[kind] = (counts[kind] || 0) + 1;
    return identities.get(key);
  };
  const custom = privateTerms(terms).map(t => t.normalize('NFKC'));
  const redact = raw => {
    let text = String(raw || '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    for (const term of custom) {
      const parts = text.split(term);
      if (parts.length > 1) text = parts.map((p, i) => i ? substitute('비공개', term) + p : p).join('');
    }
    for (const [kind, pattern] of RULES) text = text.replace(pattern, found =>
      kind === '계좌번호' && /^\d{4}-\d{2}-\d{2}$/.test(found) ? found : substitute(kind, found));
    return text;
  };
  return { redact, counts };
}

export function redactLearningText(value, terms = []) {
  const { redact, counts } = redactor(value, terms);
  const text = redact(value);
  return { text, counts, changed: text !== String(value || '') };
}

// Redact values rather than serialized JSON: identifiers containing quotes must not corrupt the schema.
export function redactLearningValue(value, terms = []) {
  const { redact, counts } = redactor(JSON.stringify(value), terms);
  const walk = v => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  const result = walk(value);
  return { value: result, counts, changed: JSON.stringify(result) !== JSON.stringify(value) };
}

export function assertNoDetectedIdentifiers(text) {
  if (redactLearningText(text).changed) {
    const error = new Error('식별정보 후보가 남아 있습니다. 비식별 재검사를 수행한 뒤 다시 확인하십시오.');
    error.statusCode = 422;
    throw error;
  }
}
