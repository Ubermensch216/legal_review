// 구조화된 추론 결과를 쟁점별 IRAC와 종합 판단으로 표시한다.
import { createReferenceFormatter, explainDiagnostic } from './learningIssues.js';
import { stripReportMarkup } from './reportFormat.js';
const LEGAL = { APPLIES: ['요건 충족', 'ok'], NOT_APPLICABLE: ['요건 불충족', 'no'], EXCEPTION_APPLIES: ['예외 적용', 'warn'], CONDITIONAL: ['판단 유보', 'hold'] };
const STATUS = { SATISFIED: '충족', NOT_SATISFIED: '불충족', PARTIALLY_SATISFIED: '일부 충족', DISPUTED: '다툼', UNKNOWN: '미확정' };
const PROOF = { SUFFICIENT: '입증 충분', INSUFFICIENT: '입증 부족', CONFLICTING: '자료 상충', NO_EVIDENCE: '입증 자료 없음' };
const RULE_STATUS = { VERIFIED: '규범 원문 확인', UNVERIFIED: '규범 근거 확인 필요', CONFLICTING: '규범 해석 다툼' };
const FACT_STATUS = { DOCUMENT_CONFIRMED: '계약 문언 확인', EXTERNALLY_CONFIRMED: '외부 사실 확인', DISPUTED: '사실관계 다툼', UNKNOWN: '사실 추가 확인' };
const APPLICATION_STATUS = { SATISFIED: '적용 요건 충족', NOT_SATISFIED: '적용 요건 불충족', PARTIAL: '일부 적용', DEPENDS_ON_FACTS: '사실 확인 후 판단', DISPUTED: '적용 다툼' };
const RISK = { HIGH: '높음', MEDIUM: '보통', LOW: '낮음', NONE: '없음',
  HIGH_CANDIDATE: '높은 위험 가능성·법적 근거 확인 필요', UNRATED_NEEDS_AUTHORITY: '법적 근거 확인 필요' };
const esc = value => stripReportMarkup(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const list = (items, empty) => items.length ? `<ul class="rv-list">${items.map(x => `<li>${x}</li>`).join('')}</ul>` : `<p class="rv-empty">${empty}</p>`;

function sources(ids, evidence, readable) {
  const unique = [...new Set(ids || [])];
  if (!unique.length) return '<span class="rv-note">연결된 공식 출처 없음 · 확인 필요</span>';
  return unique.map(id => {
    const item = evidence.get(id);
    if (!item) return '<span class="rv-source rv-unverified">출처 확인 필요</span>';
    const valid = item.official && item.inForce;
    return `<span class="rv-source ${valid ? 'rv-official' : 'rv-unverified'}">${valid ? '공식·기준일 유효' : '출처·효력 확인 필요'} · ${esc(readable(id))}</span>`;
  }).join(' ');
}

function step(letter, heading, body) {
  return `<section class="rv-step"><span class="rv-step-mark" aria-hidden="true">${letter}</span><div class="rv-step-content"><h5>${heading}</h5>${body}</div></section>`;
}

function issueCard(issue, index, facts, evidence, gaps, contractFindings = [], readable, readableSource) {
  const c = issue.conclusion || {};
  const contract = contractFindings.filter(f => f.issueId === issue.id);
  const [label, tone] = contract.length ? ['문언상 위험 확인', 'warn'] : (LEGAL[c.legal] || LEGAL.CONDITIONAL);
  const elements = issue.elements || [];
  const assessments = issue.assessments || [];
  const assessmentByElement = new Map(assessments.map(a => [a.elementId, a]));
  const relatedFacts = (issue.factIds || []).map(id => facts.get(id)).filter(Boolean);
  const documentFacts = contract.map(f => `${(f.documentSupportIds || []).map(readable).join(', ')}: ${f.documentFinding}`);
  const legalStatus = contract[0]?.legalValidityConclusion?.status || contract[0]?.legalValidity;
  const legalLabels = { REVIEWED: '공식 근거 검토 완료', REVIEWED_WITH_WARNINGS: '핵심 근거 검토 완료 · 부수 경고',
    CONDITIONAL_ON_MATERIAL_FACT: '결정적 사실 확인 필요', AUTHORITY_INCOMPLETE: '핵심 공식 근거 확인 필요',
    FAILED: '해당 쟁점의 판단 단계가 완료되지 않았습니다.' };
  const materialFacts = contract.flatMap(f => f.additionalFactDetails || []).filter(f => f.materiality === 'OUTCOME_DETERMINATIVE');
  const rules = elements.map(e => {
    const a = assessmentByElement.get(e.id);
    return `<div class="rv-rule"><strong>${esc(readable(e.text || e.id))}</strong>${e.isException ? ' <span class="rv-tag">예외</span>' : e.mandatory === false ? ' <span class="rv-tag">택일</span>' : ''}${e.fallback ? ' <span class="rv-tag">요건 미검증</span>' : ''}<div class="rv-sources">${sources(a?.authorityEvidenceIds || [], evidence, readableSource)}</div></div>`;
  });
  const applications = assessments.map(a => {
    const e = elements.find(x => x.id === a.elementId);
    const supporting = (a.factIds || []).map(id => facts.get(id)).filter(Boolean);
    const contrary = (a.contraryFactIds || []).map(id => facts.get(id)).filter(Boolean);
    const statuses = a.ruleStatus ? `${RULE_STATUS[a.ruleStatus] || '규범 확인 필요'} · ${FACT_STATUS[a.factStatus] || '사실 추가 확인'} · ${APPLICATION_STATUS[a.applicationStatus] || '적용 판단 필요'}`
      : `${STATUS[a.status] || a.status || '미확정'} · ${PROOF[a.proof] || a.proof || '입증 미평가'}`;
    return `<div class="rv-application ${(c.decidingElementIds || []).includes(a.elementId) ? 'rv-deciding' : ''}"><div class="rv-application-head"><strong>${esc(readable(e?.text || '판단 요건'))}</strong><span class="rv-status">${esc(statuses)}</span></div>
      ${supporting.length ? `<p><b>적용 사실</b> ${supporting.map(f => esc(readable(f.text))).join(' / ')}</p>` : contract.length ? '<p class="rv-note">요건별 추가 사실 연결 필요</p>' : '<p class="rv-note">연결된 뒷받침 사실 없음</p>'}
      ${contrary.length ? `<p><b>반대 사실</b> ${contrary.map(f => esc(readable(f.text))).join(' / ')}</p>` : ''}
      <p><b>포섭 판단</b> ${esc(readable(a.analysis || '판단 내용 없음'))}</p>
      ${a.knowledgeOnly ? '<p class="rv-note">외부 지식만 사용 · 공식 근거 확인 필요</p>' : ''}
      ${a.openQuestion ? `<p class="rv-note">추가 확인: ${esc(readable(a.openQuestion))}</p>` : ''}</div>`;
  });
  const issueGaps = gaps.filter(g => g.issueId === issue.id);
  return `<article class="opinion-item-card rv-issue">
    <div class="rv-issue-head"><div><span class="rv-eyebrow">쟁점 ${index + 1}</span><h4>${esc(readable(issue.question))}</h4></div><span class="rv-verdict rv-${tone}">${esc(label)}</span></div>
    ${contract.length ? `<div class="rv-followup"><b>계약 문언상 위험 · ${esc(RISK[contract.map(f => f.facialRisk).includes('HIGH') ? 'HIGH' : 'MEDIUM'])}</b>${list(documentFacts.map(x => esc(readable(x))), '')}<p class="rv-note">법적 효력은 공식 근거와 적용 전제를 별도로 확인합니다.</p></div>` : ''}
    <div class="rv-flow">
      ${step('I', 'Issue · 쟁점', `<p class="rv-question">${esc(readable(issue.question))}</p>${list(relatedFacts.map(f => esc(readable(f.text))), documentFacts.length ? '계약 원문은 위에 표시했습니다.' : '이 쟁점에 연결된 사실이 없습니다.')}`)}
      ${step('R', 'Rule · 적용 규범', rules.length ? rules.join('') : '<p class="rv-empty">확정된 적용 요건이 없습니다. 공식 법령 근거를 확인해야 합니다.</p>')}
      ${step('A', 'Application · 사실에 적용', applications.length ? applications.join('') : '<p class="rv-empty">요건별 적용 판단이 없습니다.</p>')}
      ${step('C', 'Conclusion · 쟁점별 결론', `<div class="rv-conclusion"><strong class="rv-verdict rv-${tone}">${esc(label)}</strong><span>${contract.length ? esc(legalLabels[legalStatus] || legalStatus || '법적 판단 확인 필요') : esc(PROOF[c.proof] || '입증 미평가')}</span></div>${contract.length ? `<p>문언 판단: ${esc(contract.map(f => `${f.facialRisk} — ${f.label}`).join(' / '))}</p><p>법적 판단: ${esc(legalLabels[legalStatus] || legalStatus || '확인 필요')}</p><p>추가 확인사항: ${esc(materialFacts.map(f => f.text).join(' / ') || '결론을 좌우하는 외부 사실 없음')}</p>` : ''}${list((c.reasons || []).map(x => esc(readable(x))), '판단 이유가 기록되지 않았습니다.')}${c.ifResolved && !contract.length ? `<p class="rv-note">선결 쟁점이 해결되면: ${esc((LEGAL[c.ifResolved] || LEGAL.CONDITIONAL)[0])}</p>` : ''}${issue.stageStatus === 'FAILED' && !contract.length ? '<p class="rv-note">해당 쟁점의 판단 단계가 완료되지 않았습니다.</p>' : ''}`)}
    </div>
    ${issue.counter?.position ? `<div class="rv-followup"><b>반대 논리 검토</b><p>${esc(readable(issue.counter.position))}</p><p>${issue.counter.response ? `검토 의견: ${esc(readable(issue.counter.response))}` : '검토 의견 미작성 · 추가 검토 필요'}</p></div>` : ''}
    ${issueGaps.length ? `<div class="rv-followup"><b>남은 확인 사항</b>${list(issueGaps.map(g => esc(readable(g.question))), '')}</div>` : ''}
  </article>`;
}

function synthesis(reasoning, review, readable) {
  const regime = review.contractRegime || reasoning.contractRegime;
  const rows = (reasoning.issues || []).map((issue, index) => {
    const finding = (review.contractFindings || reasoning.contractFindings || []).find(f => f.issueId === issue.id);
    const [label, tone] = finding ? [`문언 위험 ${RISK[finding.facialRisk] || '확인 필요'}`, 'warn'] : (LEGAL[issue.conclusion?.legal] || LEGAL.CONDITIONAL);
    return `<tr><td>${index + 1}</td><td>${esc(readable(issue.question))}</td><td><span class="rv-verdict rv-${tone}">${esc(label)}</span></td><td>${esc(readable((issue.conclusion?.reasons || []).join(' / ') || '판단 이유 미기록'))}</td></tr>`;
  }).join('');
  const open = (reasoning.gaps || []).filter(g => g.state !== 'RESOLVED');
  return `<section class="rv-synthesis"><div class="rv-synthesis-head"><span class="rv-eyebrow">전체 쟁점 종합</span><h4>종합 분석 결과</h4><p>각 쟁점의 작은 결론을 모아 전체 판단과 후속 조치를 확인합니다.</p></div>
    <div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>번호</th><th>쟁점</th><th>쟁점별 결론</th><th>결정 이유</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="rv-overall"><b>종합 판단</b><p>${esc(readable(review.summary || '종합 판단 문장이 제공되지 않았습니다. 위 쟁점별 결론을 확인하십시오.'))}</p>${review.auditConclusion ? `<p><b>처리 의견 · ${esc(review.auditConclusion.result)}</b> ${esc(readable(review.auditConclusion.reason || ''))}</p>` : ''}</div>
    ${regime ? `<div class="rv-open"><b>적용 법체계 선결 사항</b><p>계약 성격: ${esc((regime.contractNature?.candidates || []).join(' / '))} · 약관성: ${esc(regime.termsRegulation?.status === 'NEEDS_FACTS' ? '추가 사실 확인' : regime.termsRegulation?.status || '미확정')} · 발주기관 유형: ${esc(regime.publicProcurement?.institutionType === 'UNKNOWN' ? '확인 필요' : regime.publicProcurement?.institutionType || '확인 필요')}</p></div>` : ''}
    ${open.length ? `<div class="rv-open"><b>결론을 제한하는 남은 확인 사항 · ${open.length}건</b>${list(open.map(g => esc(readable(g.question))), '')}</div>` : ''}
    ${(review.recommendations || []).length ? `<div class="rv-open"><b>후속 조치</b>${list(review.recommendations.map(x => esc(readable(x))), '')}</div>` : ''}
    ${(review.missingClauseAdditions || []).length ? `<div class="rv-open"><b>누락 조항</b>${list(review.missingClauseAdditions.map(m => esc(`${m.title}: ${m.reason} 권고 추가 문안: ${m.suggestedText}`)), '')}</div>` : ''}
    ${reasoning.gate === 'HUMAN_REVIEW_REQUIRED' ? `<p class="rv-note rv-gate">사람 검토 필요 · ${esc((reasoning.gateReasons || []).map(x => explainDiagnostic(x, { reasoning })).join(' / '))}</p>` : ''}
  </section>`;
}

/** 쟁점별 IRAC와 종합 판단. report 모드는 문서 편집기에 불필요한 동작을 숨긴다. */
export function renderReasoningOpinion(reasoning, review = {}, { report = false } = {}) {
  const issues = reasoning?.issues || [];
  if (!issues.length) return '';
  const facts = new Map((reasoning.facts || []).map(f => [f.id, f]));
  const evidence = new Map((reasoning.evidence || []).map(e => [e.id, e]));
  const readable = createReferenceFormatter({ reasoning });
  const readableSource = createReferenceFormatter({ reasoning }, { includePreview: true });
  const inquiry = (reasoning.gaps || []).filter(g => g.route === 'EXTERNAL_INQUIRY' && ['OPEN', 'STILL_OPEN'].includes(g.state)).length;
  return `<div class="rv-report"><div class="rv-intro"><div><span class="rv-eyebrow">IRAC 분석 흐름</span><h3>쟁점별 규범 · 적용 · 결론</h3><p>쟁점마다 적용 규범과 사실 포섭을 연결한 뒤 작은 결론을 도출합니다.</p></div><span class="rv-count">${issues.length}개 쟁점</span></div>
    ${!report && inquiry ? `<div class="rv-summary">외부 전문가 질의 필요 ${inquiry}건 <button type="button" class="btn btn-xs btn-outline" data-open-learning>질의로 이동</button></div>` : ''}
    ${issues.map((issue, index) => issueCard(issue, index, facts, evidence, reasoning.gaps || [], review.contractFindings || reasoning.contractFindings || [], readable, readableSource)).join('')}
    ${synthesis(reasoning, review, readable)}</div>`;
}
