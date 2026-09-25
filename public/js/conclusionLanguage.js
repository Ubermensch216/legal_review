// 화면과 저장되는 검토의견서에서 같은 뜻의 결론 설명을 사용한다.
export const CONTRACT_LEGAL_EXPLANATION = {
  REVIEWED: '결론에 필요한 공식 근거의 검토가 완료되었습니다. 이 표시는 조항이 유효하거나 무효라는 판정 자체를 뜻하지 않습니다.',
  REVIEWED_WITH_WARNINGS: '결론에 직접 쓰인 주요 근거는 확인됐지만, 다른 인용 자료에는 확인되지 않은 부분이 남아 있습니다. 그 부분이 판단에 영향을 주는지 확인해야 합니다.',
  CONDITIONAL_ON_MATERIAL_FACT: '법적 판단을 바꿀 수 있는 사실이 아직 확인되지 않았습니다. 아래 사실을 확인한 뒤 판단해야 합니다.',
  AUTHORITY_INCOMPLETE: '계약 문구의 위험은 확인했지만, 이 조항에 적용할 핵심 공식 근거의 검증이 끝나지 않았습니다. 현재 결과만으로 유효·무효를 단정할 수 없습니다.',
  FAILED: '법적 판단 과정이 완료되지 않아 이 조항의 효력을 결론 내릴 수 없습니다.'
};

export const CONTRACT_RISK_LABEL = { HIGH: '높음', MEDIUM: '보통', LOW: '낮음', NONE: '없음' };
const CONTRACT_RISK_SENTENCE = {
  HIGH: '계약 문구의 위험도가 높게 평가됐습니다.',
  MEDIUM: '계약 문구에 검토가 필요한 위험이 있습니다.',
  LOW: '계약 문구의 위험도가 낮게 평가됐습니다.',
  NONE: '계약 문구에서 별도의 위험이 확인되지 않았습니다.'
};

export function explainContractRisk(finding) {
  return `${finding.label}: ${CONTRACT_RISK_SENTENCE[finding.facialRisk] || '계약 문구의 위험도를 확인해야 합니다.'} 이는 문구에 대한 평가이며 조항의 무효 판정은 아닙니다.`;
}

export const isSourcePlaceholder = value => /출처를 확인하지 못한 자료|출처 확인 필요|공식 근거 확인 필요/.test(value);

export function explainConclusionReason(reason, elements = [], readable = value => value) {
  if (reason === '검증된 판단 요건이 없음')
    return '관련 법 조항에서 이 사안에 적용할 판단 기준을 검증하지 못했습니다. 따라서 법적 효력에 관한 결론을 낼 수 없습니다.';
  const undecided = String(reason).match(/^판단 미확정 요건:\s*(.+)$/);
  if (undecided) {
    const ids = undecided[1].split(/\s*,\s*/);
    const names = ids.map(id => elements.find(e => e.id === id)?.text || readable(id));
    if (names.some(isSourcePlaceholder))
      return '판단에 사용된 자료의 출처를 확인하지 못했습니다. 어떤 공식 자료인지와 이 조항에 어떻게 적용되는지를 확인해야 합니다.';
    return `다음 판단 기준을 충족하는지 확인되지 않았습니다: ${names.join(' / ')}`;
  }
  if (String(reason).startsWith('선결 쟁점 미해결:'))
    return `먼저 판단해야 할 쟁점이 해결되지 않았습니다: ${readable(reason.slice('선결 쟁점 미해결:'.length).trim())}`;
  if (reason === '인용 근거가 주장을 충분히 뒷받침하는지 확인되지 않음')
    return '인용한 법령이나 자료가 이 판단을 실제로 뒷받침하는지 확인되지 않았습니다.';
  return readable(reason);
}

export function explainConclusionReasons(conclusion = {}, elements = [], readable = value => value) {
  const reasons = (conclusion.reasons || []).map(reason => explainConclusionReason(reason, elements, readable));
  if (reasons.length || conclusion.legal !== 'CONDITIONAL') return reasons;
  return [elements.length
    ? '이 쟁점의 법률 요건 충족 여부가 아직 정리되지 않았습니다. 적용할 법률 기준과 관련 사실을 다시 확인해야 합니다.'
    : explainConclusionReason('검증된 판단 요건이 없음')];
}

export function explainExternalFacts(details = []) {
  const material = details.filter(f => f.materiality === 'OUTCOME_DETERMINATIVE');
  return material.length
    ? `다음 사실을 확인해야 판단할 수 있습니다: ${material.map(f => f.text).join(' / ')}`
    : '현재 분석에서는 결론을 바꿀 외부 사실을 따로 지정하지 않았습니다. 법적 근거까지 확인됐다는 뜻은 아닙니다.';
}
