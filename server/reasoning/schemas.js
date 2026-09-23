// server/reasoning/schemas.js - 단계 출력 스키마와 최소 검증기
//
// Ollama는 `format`에 준 JSON Schema로 생성 자체를 제약하지만, 다른 제공자·구버전·재시도 경로에서는
// 보장되지 않는다. 그래서 같은 스키마로 코드에서도 한 번 더 확인한다.
// 지원 범위는 이 프로젝트 스키마가 쓰는 부분집합(type, properties, required, items, enum,
// minItems/maxItems, maxLength, additionalProperties:false)으로 한정한다.

const typeOf = value => Array.isArray(value) ? 'array' : value === null ? 'null'
  : Number.isInteger(value) ? 'integer' : typeof value;

/**
 * @returns {string[]} 오류 목록. 비어 있으면 통과다. 경로는 `issues[0].question` 형식이다.
 */
export function validateSchema(schema, value, path = '$') {
  const errors = [];
  const actual = typeOf(value);
  const expected = schema.type;
  if (expected && !(expected === actual || (expected === 'number' && actual === 'integer'))) {
    return [`${path}: ${expected} 형식이어야 합니다 (실제: ${actual})`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: 허용값(${schema.enum.join(', ')}) 밖의 값 '${String(value).slice(0, 40)}'`);
  if (actual === 'string' && schema.maxLength && value.length > schema.maxLength) errors.push(`${path}: ${schema.maxLength}자 초과`);
  if (actual === 'array') {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${path}: 항목이 ${schema.minItems}개 이상이어야 합니다`);
    if (schema.maxItems && value.length > schema.maxItems) errors.push(`${path}: 항목이 ${schema.maxItems}개를 넘습니다`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(schema.items, item, `${path}[${i}]`)));
  }
  if (actual === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: 필수 항목 누락`);
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateSchema(sub, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${path}.${key}: 정의되지 않은 항목`);
    }
  }
  return errors;
}

/** 모델 출력 문자열을 JSON으로 읽는다. 코드펜스·앞뒤 잡음만 걷어내고 내용은 고치지 않는다. */
export function parseModelJson(text) {
  const cleaned = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* 아래에서 최외곽 중괄호만 다시 시도 */ }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { return null; }
}

const str = maxLength => ({ type: 'string', maxLength });
const list = (items, maxItems) => ({ type: 'array', items, maxItems });

export const FACT_STATUS = ['CONFIRMED', 'ALLEGED', 'DISPUTED', 'UNKNOWN', 'INFERRED'];
export const ISSUE_TYPES = ['THRESHOLD', 'PRIMARY', 'DEPENDENT', 'PROCEDURAL', 'REMEDY', 'INTERPRETATION'];
export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/**
 * S1 사건·쟁점 출력 스키마. 길이 상한은 출력 토큰 상한이기도 하다.
 * 모델이 문장을 길게 쓰기 시작하면 디코드 시간이 그대로 늘어난다(약 17토큰/초).
 */
export function caseIssuesSchema({ maxIssues = 5, maxFacts = 16 } = {}) {
  const position = { type: 'object', additionalProperties: false, required: ['label', 'claim', 'evidenceIds'],
    properties: { label: str(20), claim: str(200), evidenceIds: list(str(16), 6) } };
  return {
    type: 'object', additionalProperties: false, required: ['facts', 'issues', 'unknownFacts'],
    properties: {
      facts: list({ type: 'object', additionalProperties: false, required: ['id', 'text', 'status', 'docRef', 'quote'],
        properties: { id: str(8), text: str(200), status: { type: 'string', enum: FACT_STATUS }, docRef: str(16), quote: str(80) } }, maxFacts),
      issues: { type: 'array', minItems: 1, maxItems: maxIssues, items: { type: 'object', additionalProperties: false,
        required: ['id', 'question', 'type', 'priority', 'dependsOn', 'factIds', 'evidenceIds', 'searchTerms'],
        properties: { id: str(8), question: str(200), type: { type: 'string', enum: ISSUE_TYPES },
          priority: { type: 'string', enum: PRIORITIES }, dependsOn: list(str(8), 4), factIds: list(str(8), 8),
          evidenceIds: list(str(16), 8), searchTerms: list(str(30), 4), positions: list(position, 3) } } },
      unknownFacts: list(str(160), 8)
    }
  };
}
