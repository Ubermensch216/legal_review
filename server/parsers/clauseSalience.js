// server/parsers/clauseSalience.js - 질의어·위험 키워드와 무관하게 쟁점이 숨는 자리를 찾는 구조적 표지
//
// 위험 룰셋(legalDocChunker의 RISK_PATTERNS)은 '무엇이 독소조항인가'를 알고 있는 목록이고,
// 질의어 일치는 사용자가 이미 아는 쟁점만 찾는다. 둘 다 없으면 발췌가 조항 앞부분으로 쏠려
// 뒤에 붙은 단서·예외·위임·우선 적용 조건을 통째로 놓친다.
// 아래 표지는 특정 쟁점이 아니라 '법률 문장에서 조건이 뒤집히는 자리'의 문법적 신호다.

export const SALIENCE_PATTERNS = [
  { category: 'PROVISO', weight: 9, patterns: [/다만[,\s]/, /단서/, /그러하지 아니하[다련]/, /예외로/, /에도 불구하고/, /한정한다/, /제외한다/, /하지 아니한다/] },
  { category: 'PRECEDENCE', weight: 9, patterns: [/우선(하여 적용|한다|적용)/, /갈음한다/, /본다\b/, /간주(한다|된다)/, /준용한다/, /효력을 (상실|가지지)/, /무효로/] },
  { category: 'EXTERNAL_REFERENCE', weight: 8, patterns: [/별표/, /별지/, /부속/, /부칙/, /따로 정한다/, /정하는 바에 (따른다|의한다)/, /위임한다/, /협약|각서|합의서/] },
  { category: 'OBLIGATION', weight: 6, patterns: [/하여야 한다/, /해야 한다/, /할 수 없다/, /아니 ?된다/, /금지(한다|된다)/, /의무를 (진다|부담)/] },
  { category: 'TERMINATION', weight: 6, patterns: [/해지|해제(한다|할)/, /계약을 종료/, /취소(한다|할 수)/, /철회(한다|할 수)/, /정지(한다|할 수)/] },
  { category: 'LIABILITY', weight: 6, patterns: [/손해배상/, /배상(한다|하여야|책임)/, /면책/, /책임을 (진다|부담|지지)/, /위약/] },
  { category: 'QUANTITY', weight: 4, patterns: [/\d[\d,]*\s*(원|만원|억원|퍼센트|%|배|일 이내|개월|년간)/, /\d+\s*일\s*(이내|전까지|까지)/] }
];

/**
 * 조항 본문에서 구조적 표지가 나타난 위치 목록.
 * @param {string} text - 조항 본문
 * @param {number} limit - 반환할 최대 위치 수
 * @returns {Array<{position:number, weight:number, category:string}>} 위치 오름차순
 */
export function findSalienceAnchors(text, limit = 24) {
  const value = String(text || '');
  const found = [];
  for (const rule of SALIENCE_PATTERNS) {
    for (const pattern of rule.patterns) {
      const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (const match of value.matchAll(scan)) {
        found.push({ position: match.index, weight: rule.weight, category: rule.category });
        if (found.length >= limit * 4) break;
      }
    }
  }
  return found.sort((a, b) => a.position - b.position || b.weight - a.weight).slice(0, limit);
}

/**
 * 조항 단위 구조적 중요도 점수. 위험 룰셋·질의 일치가 모두 없는 조항이
 * 단순 배경 설명과 같은 순위로 밀려나지 않게 하는 보조 점수다.
 */
export function salienceScore(text) {
  const value = String(text || '');
  const categories = new Set();
  for (const rule of SALIENCE_PATTERNS) {
    if (rule.patterns.some(p => p.test(value))) categories.add(rule.category);
  }
  return [...categories].reduce((sum, category) =>
    sum + (SALIENCE_PATTERNS.find(r => r.category === category)?.weight || 0), 0);
}

export default { SALIENCE_PATTERNS, findSalienceAnchors, salienceScore };
