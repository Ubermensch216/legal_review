// server/privacy/deidentify.js - 외부 LLM으로 보내기 전 비식별화와 복원
//
// 주민번호·전화·이메일·계좌·주소·사업자번호·비밀정보는 기존 학습 내보내기용 규칙(manualLearningPrivacy)을 그대로 쓰고,
// 직함이 붙은 사람 이름과 사용자가 지정한 단어를 더한다. 같은 값은 같은 표기([전화_1])로 바뀌므로
// 외부 답변이 같은 대상을 가리킬 수 있고, 돌아온 답변은 서버가 원래 값으로 되돌린다(mapping은 외부로 나가지 않는다).
// 패턴 매칭은 익명화 보증이 아니다. 그래서 전송 전 사용자가 비식별 결과를 직접 확인·승인한다.
import { createRedactor, redactLearningText } from '../law/manualLearningPrivacy.js';

const SURNAME = '[김이박최정강조윤장임한오서신권황안송류홍전고문손배백허유남심노하곽성차주우구민진지엄채원천방공현함변염양도석]';
const TITLE = '(?:과장|팀장|부장|차장|대리|주임|사원|계장|사무관|주무관|국장|실장|본부장|이사|대표|원장|소장|위원|교수|변호사|담당관|씨|님)';
const NAME_WITH_TITLE = new RegExp(`(?<![가-힣])(${SURNAME}[가-힣]{1,2})[ ]*${TITLE}(?=[은는이가을를의과와도에께만]|[^가-힣]|$)`, 'g');
// 직함만 보고 이름으로 오인하면 안 되는 일반 낱말.
const NOT_NAMES = new Set(['대표자', '이사회', '주무관청', '위원회', '소장님', '관리자']);

/** 본문에서 "홍길동 과장"처럼 직함이 붙은 이름을 찾는다. */
export function findTitledNames(text) {
  return [...new Set([...String(text || '').matchAll(NAME_WITH_TITLE)].map(m => m[1]).filter(n => !NOT_NAMES.has(n)))];
}

const strings = value => typeof value === 'string' ? [value]
  : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

/**
 * 문자열·객체를 깊이 훑어 비식별화한다. 한 번의 호출 안에서는 같은 값에 같은 표기를 쓴다.
 * @param {*} value
 * @param {{ terms?: string[] }} [options] 사용자가 지정한 추가 비식별 단어(기관명·사업명 등)
 * @returns {{ value: *, mapping: Record<string,string>, counts: Record<string,number> }}
 */
export function deidentify(value, { terms = [] } = {}) {
  const session = createDeidentifier({ terms, sample: strings(value).join('\n') });
  const result = session.walk(value);
  return { value: result, mapping: session.mapping(), counts: session.counts };
}

/**
 * 여러 번 나누어 비식별화해도 같은 값에 같은 표기를 쓰는 세션. sample은 직함이 붙은 이름을 미리 찾을 본문이다.
 * 같은 입력을 같은 순서로 처리하면 항상 같은 결과가 나온다(승인 해시가 이 결정성에 기댄다).
 */
export function createDeidentifier({ terms = [], sample = '' } = {}) {
  const { redact, counts, identities } = createRedactor([...terms, ...findTitledNames(sample)]);
  const walk = v => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  const mapping = () => {
    const out = {};
    for (const [key, token] of identities) out[token] = key.slice(key.indexOf(':') + 1);
    return out;
  };
  return { redact, walk, mapping, counts };
}

/** 대체 표기를 원래 값으로 되돌린다. */
export function reidentifyText(text, mapping = {}) {
  let out = String(text ?? '');
  for (const token of Object.keys(mapping).sort((a, b) => b.length - a.length)) out = out.split(token).join(mapping[token]);
  return out;
}

export function reidentifyDeep(value, mapping = {}) {
  const walk = v => typeof v === 'string' ? reidentifyText(v, mapping) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value);
}

/** 전송문에 식별정보 후보가 남아 있는가. 승인된 전송문이 마지막 방어선으로 다시 거치는 검사다. */
export function remainingIdentifiers(text) {
  const body = String(text || '');
  const found = [];
  if (Object.keys(redactLearningText(body).counts).length) found.push('식별번호·연락처·주소 등 패턴');
  if (findTitledNames(body).length) found.push('직함이 붙은 이름');
  return found;
}
