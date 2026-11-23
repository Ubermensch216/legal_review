// server/reasoning/verify/conclusion.js - 요건 판단에서 쟁점 결론을 코드로 계산한다
//
// 모델은 요건마다 상태만 판단한다. 결론은 여기서 규칙으로 도출하므로
//   - 요건 하나가 UNKNOWN인데 확정 결론이 나오는 일,
//   - 선결 쟁점이 미해결인데 후속 쟁점을 확정하는 일,
//   - 법리상 적용 가능성과 증거상 입증 가능성을 한데 섞는 일
// 이 구조적으로 생기지 않는다. 모델의 서술과 계산된 결론이 어긋나면 결론 표가 우선한다.

export const LEGAL = Object.freeze({
  APPLIES: 'APPLIES', NOT_APPLICABLE: 'NOT_APPLICABLE', EXCEPTION_APPLIES: 'EXCEPTION_APPLIES', CONDITIONAL: 'CONDITIONAL'
});
const OPEN = new Set(['UNKNOWN', 'DISPUTED', 'PARTIALLY_SATISFIED']);

// 문서 검토의 결론. "이 문서가 규정을 지키는가"에 답한다. 위반 '소지'이며 위법 확정이 아니다.
export const COMPLIANCE = Object.freeze({ VIOLATION_RISK: 'VIOLATION_RISK', NO_VIOLATION_FOUND: 'NO_VIOLATION_FOUND', NEEDS_FACTS: 'NEEDS_FACTS' });
export const COMPLIANCE_LABEL = Object.freeze({ VIOLATION_RISK: '위반 소지', NO_VIOLATION_FOUND: '위반 사항 미발견', NEEDS_FACTS: '추가 확인 필요' });

const compactText = value => String(value || '').replace(/\s+/g, '');

/**
 * 모델의 문서 판단을 원문으로 검증한다. 지킨다·어긋난다는 판단은 첨부문서 문장을 글자 그대로 인용했을 때만 인정한다.
 * 소형 모델은 법 조문을 되풀이하며 "충족"이라고 답하는 일이 잦은데, 법령 문구는 문서에 없으므로 여기서 걸러진다.
 */
export function resolveDocumentVerdict(raw, groundTexts = []) {
  if (!raw?.verdict) return raw;
  const quote = String(raw.quote || '').trim();
  const needle = compactText(quote);
  const grounded = needle.length >= 4 && groundTexts.some(text => compactText(text).includes(needle));
  const claimed = raw.verdict === 'COMPLIES' || raw.verdict === 'VIOLATES';
  const verdict = claimed && !grounded ? 'UNCLEAR' : raw.verdict;
  return { ...raw, verdict, quote: grounded ? quote : '', quoteVerified: grounded,
    status: verdict === 'COMPLIES' ? 'SATISFIED' : verdict === 'VIOLATES' ? 'NOT_SATISFIED' : 'UNKNOWN',
    proof: claimed && grounded ? 'SUFFICIENT' : 'NO_EVIDENCE',
    factIds: raw.factIds || [], contraryFactIds: raw.contraryFactIds || [],
    ...(claimed && !grounded ? { verdictDowngraded: raw.verdict } : {}) };
}

/** 결론을 판단 유보로 낮춘다. 문서 검토 결론이면 표시 상태도 함께 낮춘다. */
export const demoteConclusion = (conclusion, reason) => ({ ...conclusion, legal: LEGAL.CONDITIONAL,
  ...(conclusion.compliance ? { compliance: COMPLIANCE.NEEDS_FACTS } : {}),
  reasons: [...(conclusion.reasons || []), ...(reason ? [reason] : [])] });

/**
 * 문서 판단(verdict)에서 쟁점 결론을 계산한다. 원문 인용이 확인된 어긋남이 하나라도 있으면 위반 소지이고,
 * 모든 요건을 지킨다고 확인될 때만 위반 사항 미발견이다. 문서가 다루지 않은 요건이 있으면 지켰다고 보지 않는다.
 */
function complianceConclusion(elements, assessments, predecessors) {
  const byId = new Map(assessments.map(a => [a.elementId, a]));
  const applicable = elements.filter(e => !e.fallback || e.blocksConclusion === true);
  const verdictOf = e => byId.get(e.id)?.verdict;
  const violating = applicable.filter(e => verdictOf(e) === 'VIOLATES');
  const complying = applicable.filter(e => verdictOf(e) === 'COMPLIES');
  const open = applicable.filter(e => !['VIOLATES', 'COMPLIES'].includes(verdictOf(e)));
  const [legal, compliance, deciding] = violating.length ? [LEGAL.NOT_APPLICABLE, COMPLIANCE.VIOLATION_RISK, violating]
    : complying.length && !open.length ? [LEGAL.APPLIES, COMPLIANCE.NO_VIOLATION_FOUND, complying]
      : [LEGAL.CONDITIONAL, COMPLIANCE.NEEDS_FACTS, open];
  const reasons = [];
  if (!applicable.length) reasons.push('검증된 판단 요건이 없음');
  const blocked = predecessors.filter(p => p.legal === LEGAL.CONDITIONAL || p.stageStatus === 'FAILED');
  const base = { proof: proofOf(deciding, byId), decidingElementIds: deciding.map(e => e.id), derivedBy: 'RULES' };
  if (blocked.length && legal !== LEGAL.CONDITIONAL) {
    reasons.push(`선결 쟁점 미해결: ${blocked.map(p => p.issueId).join(', ')}`);
    return { ...base, legal: LEGAL.CONDITIONAL, compliance: COMPLIANCE.NEEDS_FACTS, ifResolved: legal, reasons };
  }
  if (legal === LEGAL.CONDITIONAL && deciding.length) reasons.push(`판단 미확정 요건: ${deciding.map(e => e.id).join(', ')}`);
  return { ...base, legal, compliance, reasons,
    ...(legal === LEGAL.CONDITIONAL && open.length
      ? { scenarios: { pendingElementIds: open.map(e => e.id), ifSatisfied: LEGAL.APPLIES, ifUnsatisfied: LEGAL.NOT_APPLICABLE } } : {}) };
}

/**
 * 모델 판단을 사실 출처 규칙으로 보정한다. 원문으로 확인되지 않은 사실(INFERRED·UNKNOWN)만으로는
 * 입증이 충분하다고 볼 수 없다.
 */
export function applyFactProvenance(assessment, factsById) {
  // 첨부문서 원문 인용으로 이미 확인된 판단이다.
  if (assessment.quoteVerified) return assessment;
  const facts = assessment.factIds.map(id => factsById.get(id)).filter(Boolean);
  const backed = facts.some(f => f.quoteVerified && !['INFERRED', 'UNKNOWN'].includes(f.status));
  if (assessment.proof === 'SUFFICIENT' && !backed) {
    return { ...assessment, proof: 'INSUFFICIENT', proofAdjusted: '원문으로 확인된 사실이 없어 입증 충분으로 볼 수 없음' };
  }
  return assessment;
}

/**
 * 쟁점 결론을 계산한다.
 * @param {object[]} elements  selectIssueElements 결과 (id, mandatory, isException, sourceIds)
 * @param {object[]} assessments 요건별 판단 (elementId, status, proof)
 * @param {object[]} [predecessors] 선결 쟁점의 결론 ({ issueId, legal, stageStatus })
 */
export function computeIssueConclusion(elements, assessments, predecessors = [], options = {}) {
  if (assessments.some(a => a.verdict)) return complianceConclusion(elements, assessments, predecessors);
  const byId = new Map(assessments.map(a => [a.elementId, a]));
  const statusOf = e => byId.get(e.id)?.status || 'UNKNOWN';
  // 원문을 분해하지 못해 만든 골격은 적용 요건으로 검증되기 전까지 결론을 좌우하지 않는다.
  const applicable = elements.filter(e => !e.fallback || e.blocksConclusion === true);
  const principal = applicable.filter(e => !e.isException && e.operator !== 'EXCEPTION');
  const mandatory = principal.filter(e => !['ANY_OF', 'ALTERNATIVE'].includes(e.operator) && e.mandatory !== false);
  // 필수가 아닌 요건은 같은 조문 안에서 "여러 경우 중 하나"(열거된 호)다. 조문별로 묶어 하나라도 충족되면 충족이다.
  const groups = new Map();
  for (const e of principal.filter(e => ['ANY_OF', 'ALTERNATIVE'].includes(e.operator) || e.mandatory === false)) {
    const group = e.logicGroup || e.id.replace(/\.E\d+$/, '');
    (groups.get(group) || groups.set(group, []).get(group)).push(e);
  }
  const groupState = list => list.some(e => statusOf(e) === 'SATISFIED') ? 'SATISFIED'
    : list.every(e => statusOf(e) === 'NOT_SATISFIED') ? 'NOT_SATISFIED' : 'OPEN';
  const exceptions = applicable.filter(e => e.isException || e.operator === 'EXCEPTION');

  let legal;
  let deciding;
  const failed = [...mandatory.filter(e => statusOf(e) === 'NOT_SATISFIED'),
    ...[...groups.values()].filter(g => groupState(g) === 'NOT_SATISFIED').flat()];
  const open = [...mandatory.filter(e => OPEN.has(statusOf(e))), ...[...groups.values()].filter(g => groupState(g) === 'OPEN').flat()];
  if (!applicable.length) {
    legal = LEGAL.CONDITIONAL; deciding = [];
  } else if (failed.length) {
    legal = LEGAL.NOT_APPLICABLE; deciding = failed;
  } else if (open.length) {
    legal = LEGAL.CONDITIONAL; deciding = open;
  } else if (exceptions.some(e => statusOf(e) === 'SATISFIED')) {
    legal = LEGAL.EXCEPTION_APPLIES; deciding = exceptions.filter(e => statusOf(e) === 'SATISFIED');
  } else if (exceptions.some(e => OPEN.has(statusOf(e)))) {
    // 원칙 요건은 충족됐지만 예외 적용 여부를 모른다. 예외를 무시하고 확정하지 않는다.
    legal = LEGAL.CONDITIONAL; deciding = exceptions.filter(e => OPEN.has(statusOf(e)));
  } else {
    legal = LEGAL.APPLIES;
    deciding = [...mandatory, ...[...groups.values()].flatMap(g => g.filter(e => statusOf(e) === 'SATISFIED'))];
  }

  const reasons = [];
  if (!applicable.length) reasons.push('검증된 판단 요건이 없음');
  const blocked = predecessors.filter(p => p.legal === LEGAL.CONDITIONAL || p.stageStatus === 'FAILED');
  if (blocked.length && legal !== LEGAL.CONDITIONAL) {
    // 선결 쟁점이 풀리지 않았으면 후속 쟁점을 확정하지 않는다. 계산된 결론은 조건부 결론으로 남긴다.
    reasons.push(`선결 쟁점 미해결: ${blocked.map(p => p.issueId).join(', ')}`);
    return { legal: LEGAL.CONDITIONAL, ifResolved: legal, proof: proofOf(deciding, byId), decidingElementIds: deciding.map(e => e.id),
      reasons, derivedBy: 'RULES' };
  }
  if (legal === LEGAL.CONDITIONAL && deciding.length) reasons.push(`판단 미확정 요건: ${deciding.map(e => e.id).join(', ')}`);
  const result = { legal, proof: proofOf(deciding, byId), decidingElementIds: deciding.map(e => e.id), reasons, derivedBy: 'RULES' };
  if (legal === LEGAL.CONDITIONAL && deciding.length && options.scenarios !== false) {
    const scenarios = conditionalScenarios(elements, assessments, deciding);
    if (scenarios) result.scenarios = scenarios;
  }
  return result;
}

/**
 * 판단이 유보된 이유가 "아직 확정되지 않은 요건"일 때, 그 요건이 어느 쪽으로 확정되는지에 따라
 * 결론이 어떻게 달라지는지 계산한다. "유보"로 끝내지 않고 확인해야 할 사실과 그 결과를 함께 보여 주기 위한 것이다.
 * 코드가 요건 규칙을 다시 적용할 뿐이며 새 판단을 만들지 않는다.
 */
function conditionalScenarios(elements, assessments, deciding) {
  const pending = new Set(deciding.map(e => e.id));
  const withStatus = status => [...assessments.filter(a => !pending.has(a.elementId)),
    ...deciding.map(e => ({ ...(assessments.find(a => a.elementId === e.id) || {}), elementId: e.id, status, proof: 'SUFFICIENT' }))];
  const ifSatisfied = computeIssueConclusion(elements, withStatus('SATISFIED'), [], { scenarios: false }).legal;
  const ifUnsatisfied = computeIssueConclusion(elements, withStatus('NOT_SATISFIED'), [], { scenarios: false }).legal;
  if (ifSatisfied === LEGAL.CONDITIONAL && ifUnsatisfied === LEGAL.CONDITIONAL) return null;
  if (ifSatisfied === ifUnsatisfied) return null; // 확인 결과가 결론을 바꾸지 않으면 조건부로 보여 줄 이유가 없다.
  return { pendingElementIds: [...pending], ifSatisfied, ifUnsatisfied };
}

/** 결론을 좌우한 요건들의 입증 상태. 하나라도 충분하지 않으면 전체도 충분하지 않다. */
function proofOf(deciding, byId) {
  if (!deciding.length) return 'NO_EVIDENCE';
  const proofs = deciding.map(e => byId.get(e.id)?.proof || 'NO_EVIDENCE');
  if (proofs.includes('CONFLICTING')) return 'CONFLICTING';
  if (proofs.every(p => p === 'SUFFICIENT')) return 'SUFFICIENT';
  return proofs.includes('NO_EVIDENCE') && proofs.every(p => p === 'NO_EVIDENCE') ? 'NO_EVIDENCE' : 'INSUFFICIENT';
}

// 조건부 결론인데 서술이 단정하면 표시한다. 완벽한 판별기가 아니라 명백한 어긋남만 잡는 장치다.
const ASSERTIVE = /(위법하다|무효이다|무효다|적법하다|유효하다|위반된다|위반이다|허용되지 않는다|허용된다)(?![^.。]*(?:가능성|여지|수 있|것으로 보|판단을 유보|확인이 필요))/;

/** 서술이 계산된 결론과 어긋나는지 본다. */
export function narrativeConflicts(narrative, conclusion) {
  if (conclusion.legal !== LEGAL.CONDITIONAL) return [];
  return String(narrative || '').split(/(?<=[.。])\s*/).filter(s => ASSERTIVE.test(s)).map(s => s.trim()).slice(0, 3);
}
