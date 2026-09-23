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

/**
 * 모델 판단을 사실 출처 규칙으로 보정한다. 원문으로 확인되지 않은 사실(INFERRED·UNKNOWN)만으로는
 * 입증이 충분하다고 볼 수 없다.
 */
export function applyFactProvenance(assessment, factsById) {
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
export function computeIssueConclusion(elements, assessments, predecessors = []) {
  const byId = new Map(assessments.map(a => [a.elementId, a]));
  const statusOf = e => byId.get(e.id)?.status || 'UNKNOWN';
  const principal = elements.filter(e => !e.isException);
  const mandatory = principal.filter(e => e.mandatory);
  // 필수가 아닌 요건은 같은 조문 안에서 "여러 경우 중 하나"(열거된 호)다. 조문별로 묶어 하나라도 충족되면 충족이다.
  const groups = new Map();
  for (const e of principal.filter(e => !e.mandatory)) {
    const article = e.id.replace(/\.E\d+$/, '');
    (groups.get(article) || groups.set(article, []).get(article)).push(e);
  }
  const groupState = list => list.some(e => statusOf(e) === 'SATISFIED') ? 'SATISFIED'
    : list.every(e => statusOf(e) === 'NOT_SATISFIED') ? 'NOT_SATISFIED' : 'OPEN';
  const exceptions = elements.filter(e => e.isException);

  let legal;
  let deciding;
  const failed = [...mandatory.filter(e => statusOf(e) === 'NOT_SATISFIED'),
    ...[...groups.values()].filter(g => groupState(g) === 'NOT_SATISFIED').flat()];
  const open = [...mandatory.filter(e => OPEN.has(statusOf(e))), ...[...groups.values()].filter(g => groupState(g) === 'OPEN').flat()];
  if (!elements.length) {
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
  if (!elements.length) reasons.push('판단할 요건이 없음');
  const blocked = predecessors.filter(p => p.legal === LEGAL.CONDITIONAL || p.stageStatus === 'FAILED');
  if (blocked.length && legal !== LEGAL.CONDITIONAL) {
    // 선결 쟁점이 풀리지 않았으면 후속 쟁점을 확정하지 않는다. 계산된 결론은 조건부 결론으로 남긴다.
    reasons.push(`선결 쟁점 미해결: ${blocked.map(p => p.issueId).join(', ')}`);
    return { legal: LEGAL.CONDITIONAL, ifResolved: legal, proof: proofOf(deciding, byId), decidingElementIds: deciding.map(e => e.id),
      reasons, derivedBy: 'RULES' };
  }
  if (legal === LEGAL.CONDITIONAL && deciding.length) reasons.push(`판단 미확정 요건: ${deciding.map(e => e.id).join(', ')}`);
  return { legal, proof: proofOf(deciding, byId), decidingElementIds: deciding.map(e => e.id), reasons, derivedBy: 'RULES' };
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
