import { buildConsultingAuditOpinion } from './consultingAuditReport.js';
import { historicalReviewNotice } from '../law/evidence.js';
import { expandReferences, explainDiagnostic } from '../../public/js/learningIssues.js';
export function sanitizeExportText(value) {
  return String(value ?? '')
    .replace(/\b(?:merge_type|flag|gavel|rate_review|checklist)\b/gi, '')
    .replace(/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^\s*\|(.+)\|\s*$/gm, (_line, cells) => cells.split('|').map(cell => cell.trim()).join(' · '))
    .replace(/\n{3,}/g, '\n\n').trim();
}
export function reportWarnings(data = {}) {
  const review = data.review || {};
  const collectionDiagnostic = warning => /본문 수집 실패|공식 자료 조회 미완료|목록 \d+건 중 본문|입력 예산 때문에 근거|입력 예산을 초과해 제외|입력 한도 때문에 첨부문서 조항/.test(warning);
  const warnings = [...(data.reliability?.warnings || []), ...(data.meta?.dataIntegrity?.warnings || []), ...(review.warnings || [])]
    .filter(w => !collectionDiagnostic(String(w || '')));
  // 시점 검토 표식은 meta에서 직접 읽는다. 룰베이스 폴백은 review.warnings를 채우지 않으므로
  // 검토 본문에만 의존하면 과거 시점 검토라는 사실이 보고서에서 빠진다.
  if (data.meta?.targetDate) warnings.push(historicalReviewNotice(data.meta.targetDate));
  if (review.isFallback) warnings.push('규칙 기반 점검입니다. 법리 검토를 완료하지 못했습니다.');
  if (review.fallbackReason) warnings.push(review.fallbackReason);
  if (review.reviewStatus && review.reviewStatus !== 'COMPLETE') warnings.push('검토 상태: 일부 판단이 완료되지 않아 추가 검토가 필요합니다.');
  if ((review.redlineDiffs || []).some(d => d.sourceVerified === false)) warnings.push('수정 대비표에 원문과 일치 여부가 확인되지 않은 문구가 있습니다.');
  return [...new Set(warnings.filter(w => typeof w === 'string' && w.trim())
    .map(w => review.reasoning ? explainDiagnostic(w, data) : w))];
}

export function reportText(data = {}, content = '', { preserveStructure = false } = {}) {
  const review = data.review || {};
  const warnings = reportWarnings(data);
  // 사전 컨설팅감사 결과가 있으면 해당 서식으로 조립한다.
  // (범용 검토의견서 본문은 갑설/을설과 수용·반려 결과를 담지 못한다)
  const auditBody = data.review?.auditConclusion
    ? buildConsultingAuditOpinion(data, data.documentText || '')
    : '';
  const body = content || auditBody || data.review?.draftOpinion || data.review?.legalOpinion || '';
  const used = data.review?.evidenceUsed || {};
  const usedParts = [['articles', '법령 조문'], ['precedents', '판례'], ['interpretations', '유권해석례'],
    ['ordinances', '자치법규 조문'], ['adminRules', '행정규칙']]
    .filter(([key]) => Number.isInteger(used[key]) && used[key] > 0)
    .map(([key, label]) => `${label} ${used[key]}건`);
  const evidenceLine = usedParts.length ? `[검토에 사용한 자료] ${usedParts.join(' · ')}` : '';
  const unverified = (data.review?.legalBasis || []).filter(b => b.verificationStatus === 'UNVERIFIED');
  const citationNote = unverified.length
    ? `[인용 확인 사항] 원문 대조가 완료되지 않은 인용 ${unverified.length}건: ${unverified.map(b => `${b.lawName || ''} ${b.articleNo || ''} (${b.verificationNote || '공식 원문 확인 필요'})`.trim()).join(', ')}.`
    : '';
  let displayBody = data.review?.reasoning ? expandReferences(body, data) : body;
  if (data.meta?.preset === 'contract_risk')
    displayBody = displayBody.replace(/^#\s*계약서 법률검토의견서\s*\n+/, '');
  const warrantStatus = { SUPPORTED: '근거 확인', UNCONFIRMED: '관계 확인 필요',
    NOT_SUPPORTED: '근거 불일치', NO_OFFICIAL_SUPPORT: '공식 근거 없음' };
  const appendix = review.appendix && data.review?.reasoning ? [
    '[근거 부록]',
    '실제 적용 근거', ...(review.appendix.authorities || []).map(id => `- ${expandReferences(id, data)}`),
    '명제별 근거 검증', ...(review.appendix.warrants || []).map(item =>
      `- ${item.claim}: ${warrantStatus[item.result] || '검증 필요'}${item.authorityIds?.length ? ` · ${item.authorityIds.map(id => expandReferences(id, data)).join(', ')}` : ''}`),
    '검색 후보', ...(review.appendix.researchCandidates || []).map(item =>
      `- ${item.issue}: ${item.ids.map(id => expandReferences(id, data)).join(', ') || '없음'}`),
    '미확인 주장', ...(review.appendix.unconfirmed || []).map(item => `- ${item}`),
    '인력 지휘 사실 확인 요소', ...(review.appendix.dispatchFactors || []).map(item =>
      `- ${item.question}: ${item.status === 'DOCUMENT_INDICATES_DIRECTION' ? '계약 문언상 직접 관리' : '실제 운영 확인 필요'}`),
    '상세 추가 확인사항', ...(review.appendix.additionalChecks || []).map(item => `- ${item}`),
    '외부 지식 영향', ...(review.appendix.knowledgeImpact || []).map(item =>
      `- ${item.usedFor}: ${item.officiallyVerified ? '공식 근거 연결 확인' : '공식 근거 추가 확인 필요'}`)
  ].join('\n') : '';
  const assembled = [warnings.length ? `[검토 제한 및 출처 안내]\n${warnings.map(w => `- ${w}`).join('\n')}` : '',
    evidenceLine, displayBody, appendix ? expandReferences(appendix, data) : '', citationNote].filter(Boolean).join('\n\n');
  return preserveStructure ? assembled : sanitizeExportText(assembled);
}
