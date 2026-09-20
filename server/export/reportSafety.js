export function reportWarnings(data = {}) {
  const review = data.review || {};
  const warnings = [...(data.reliability?.warnings || []), ...(data.meta?.dataIntegrity?.warnings || []), ...(review.warnings || [])];
  if (review.isFallback) warnings.push('규칙 기반 점검입니다. 법리 검토를 완료하지 못했습니다.');
  if (review.fallbackReason) warnings.push(review.fallbackReason);
  if (review.reviewStatus && review.reviewStatus !== 'COMPLETE') warnings.push(`검토 상태: ${review.reviewStatus} (미완료 또는 부분 결과)`);
  for (const basis of review.legalBasis || []) {
    if (basis.verificationStatus !== 'VERIFIED') warnings.push(`미검증 인용: ${basis.lawName || ''} ${basis.articleNo || ''}. ${basis.verificationNote || '공식 원문 확인 필요'}`);
  }
  if ((review.redlineDiffs || []).some(d => d.sourceVerified === false)) warnings.push('수정 대비표에 원문과 일치 여부가 확인되지 않은 문구가 있습니다.');
  if (!(review.legalBasis || []).length) warnings.push('검증할 인용 근거가 제시되지 않았습니다.');
  return [...new Set(warnings.filter(w => typeof w === 'string' && w.trim()))];
}

export function reportText(data = {}, content = '') {
  const warnings = reportWarnings(data);
  const body = content || data.review?.draftOpinion || data.review?.legalOpinion || '';
  return [warnings.length ? `[검토 제한 및 출처 안내]\n${warnings.map(w => `- ${w}`).join('\n')}` : '', body].filter(Boolean).join('\n\n');
}
