// 구조화된 추론 결과를 쟁점별 IRAC와 종합 판단으로 표시한다.
const LEGAL = { APPLIES: ['요건 충족', 'ok'], NOT_APPLICABLE: ['요건 불충족', 'no'], EXCEPTION_APPLIES: ['예외 적용', 'warn'], CONDITIONAL: ['판단 유보', 'hold'] };
const STATUS = { SATISFIED: '충족', NOT_SATISFIED: '불충족', PARTIALLY_SATISFIED: '일부 충족', DISPUTED: '다툼', UNKNOWN: '미확정' };
const PROOF = { SUFFICIENT: '입증 충분', INSUFFICIENT: '입증 부족', CONFLICTING: '자료 상충', NO_EVIDENCE: '입증 자료 없음' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const list = (items, empty) => items.length ? `<ul class="rv-list">${items.map(x => `<li>${x}</li>`).join('')}</ul>` : `<p class="rv-empty">${empty}</p>`;

function sources(ids, evidence) {
  const unique = [...new Set(ids || [])];
  if (!unique.length) return '<span class="rv-note">연결된 공식 출처 없음 · 확인 필요</span>';
  return unique.map(id => {
    const item = evidence.get(id);
    if (!item) return `<span class="rv-source rv-unverified">${esc(id)} · 출처 확인 필요</span>`;
    const valid = item.official && item.inForce;
    return `<span class="rv-source ${valid ? 'rv-official' : 'rv-unverified'}" title="${esc(id)}">${valid ? '공식·기준일 유효' : '출처·효력 확인 필요'} · ${esc(item.label || id)}</span>`;
  }).join(' ');
}

function step(letter, heading, body) {
  return `<section class="rv-step"><span class="rv-step-mark" aria-hidden="true">${letter}</span><div class="rv-step-content"><h5>${heading}</h5>${body}</div></section>`;
}

function issueCard(issue, index, facts, evidence, gaps) {
  const c = issue.conclusion || {};
  const [label, tone] = LEGAL[c.legal] || LEGAL.CONDITIONAL;
  const elements = issue.elements || [];
  const assessments = issue.assessments || [];
  const assessmentByElement = new Map(assessments.map(a => [a.elementId, a]));
  const relatedFacts = (issue.factIds || []).map(id => facts.get(id)).filter(Boolean);
  const rules = elements.map(e => {
    const a = assessmentByElement.get(e.id);
    return `<div class="rv-rule"><strong>${esc(e.text || e.id)}</strong>${e.isException ? ' <span class="rv-tag">예외</span>' : e.mandatory === false ? ' <span class="rv-tag">택일</span>' : ''}${e.fallback ? ' <span class="rv-tag">요건 미검증</span>' : ''}<div class="rv-sources">${sources([...(e.sourceIds || []), ...(a?.evidenceIds || [])], evidence)}</div></div>`;
  });
  const applications = assessments.map(a => {
    const e = elements.find(x => x.id === a.elementId);
    const supporting = (a.factIds || []).map(id => facts.get(id)).filter(Boolean);
    const contrary = (a.contraryFactIds || []).map(id => facts.get(id)).filter(Boolean);
    return `<div class="rv-application ${(c.decidingElementIds || []).includes(a.elementId) ? 'rv-deciding' : ''}"><div class="rv-application-head"><strong>${esc(e?.text || a.elementId)}</strong><span class="rv-status">${esc(STATUS[a.status] || a.status || '미확정')} · ${esc(PROOF[a.proof] || a.proof || '입증 미평가')}</span></div>
      ${supporting.length ? `<p><b>적용 사실</b> ${supporting.map(f => esc(f.text)).join(' / ')}</p>` : '<p class="rv-note">연결된 뒷받침 사실 없음</p>'}
      ${contrary.length ? `<p><b>반대 사실</b> ${contrary.map(f => esc(f.text)).join(' / ')}</p>` : ''}
      <p><b>포섭 판단</b> ${esc(a.analysis || '판단 내용 없음')}</p>
      ${a.knowledgeOnly ? '<p class="rv-note">외부 지식만 사용 · 공식 근거 확인 필요</p>' : ''}
      ${a.openQuestion ? `<p class="rv-note">추가 확인: ${esc(a.openQuestion)}</p>` : ''}</div>`;
  });
  const issueGaps = gaps.filter(g => g.issueId === issue.id);
  return `<article class="opinion-item-card rv-issue">
    <div class="rv-issue-head"><div><span class="rv-eyebrow">쟁점 ${index + 1} · ${esc(issue.id)}</span><h4>${esc(issue.question)}</h4></div><span class="rv-verdict rv-${tone}">${esc(label)}</span></div>
    <div class="rv-flow">
      ${step('I', 'Issue · 쟁점', `<p class="rv-question">${esc(issue.question)}</p>${list(relatedFacts.map(f => esc(f.text)), '이 쟁점에 연결된 사실이 없습니다.')}`)}
      ${step('R', 'Rule · 적용 규범', rules.length ? rules.join('') : '<p class="rv-empty">확정된 적용 요건이 없습니다. 공식 법령 근거를 확인해야 합니다.</p>')}
      ${step('A', 'Application · 사실에 적용', applications.length ? applications.join('') : '<p class="rv-empty">요건별 적용 판단이 없습니다.</p>')}
      ${step('C', 'Conclusion · 쟁점별 결론', `<div class="rv-conclusion"><strong class="rv-verdict rv-${tone}">${esc(label)}</strong><span>${esc(PROOF[c.proof] || '입증 미평가')}</span></div>${list((c.reasons || []).map(esc), '판단 이유가 기록되지 않았습니다.')}${c.ifResolved ? `<p class="rv-note">선결 쟁점이 해결되면: ${esc((LEGAL[c.ifResolved] || LEGAL.CONDITIONAL)[0])}</p>` : ''}${issue.stageStatus && issue.stageStatus !== 'OK' ? '<p class="rv-note">해당 쟁점의 판단 단계가 완료되지 않았습니다.</p>' : ''}`)}
    </div>
    ${issue.counter?.position ? `<div class="rv-followup"><b>반대 논리 검토</b><p>${esc(issue.counter.position)}</p><p>${issue.counter.response ? `검토 의견: ${esc(issue.counter.response)}` : '검토 의견 미작성 · 추가 검토 필요'}</p></div>` : ''}
    ${issueGaps.length ? `<div class="rv-followup"><b>남은 확인 사항</b>${list(issueGaps.map(g => esc(g.question)), '')}</div>` : ''}
  </article>`;
}

function synthesis(reasoning, review) {
  const rows = (reasoning.issues || []).map((issue, index) => {
    const [label, tone] = LEGAL[issue.conclusion?.legal] || LEGAL.CONDITIONAL;
    return `<tr><td>${index + 1}</td><td>${esc(issue.question)}</td><td><span class="rv-verdict rv-${tone}">${esc(label)}</span></td><td>${esc((issue.conclusion?.reasons || []).join(' / ') || '판단 이유 미기록')}</td></tr>`;
  }).join('');
  const open = (reasoning.gaps || []).filter(g => g.state !== 'RESOLVED');
  return `<section class="rv-synthesis"><div class="rv-synthesis-head"><span class="rv-eyebrow">전체 쟁점 종합</span><h4>종합 분석 결과</h4><p>각 쟁점의 작은 결론을 모아 전체 판단과 후속 조치를 확인합니다.</p></div>
    <div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>번호</th><th>쟁점</th><th>쟁점별 결론</th><th>결정 이유</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="rv-overall"><b>종합 판단</b><p>${esc(review.summary || '종합 판단 문장이 제공되지 않았습니다. 위 쟁점별 결론을 확인하십시오.')}</p>${review.auditConclusion ? `<p><b>처리 의견 · ${esc(review.auditConclusion.result)}</b> ${esc(review.auditConclusion.reason || '')}</p>` : ''}</div>
    ${open.length ? `<div class="rv-open"><b>결론을 제한하는 남은 확인 사항 · ${open.length}건</b>${list(open.map(g => esc(g.question)), '')}</div>` : ''}
    ${(review.recommendations || []).length ? `<div class="rv-open"><b>후속 조치</b>${list(review.recommendations.map(esc), '')}</div>` : ''}
    ${reasoning.gate === 'HUMAN_REVIEW_REQUIRED' ? `<p class="rv-note rv-gate">사람 검토 필요 · ${esc((reasoning.gateReasons || []).join(' / '))}</p>` : ''}
  </section>`;
}

/** 쟁점별 IRAC와 종합 판단. report 모드는 문서 편집기에 불필요한 동작을 숨긴다. */
export function renderReasoningOpinion(reasoning, review = {}, { report = false } = {}) {
  const issues = reasoning?.issues || [];
  if (!issues.length) return '';
  const facts = new Map((reasoning.facts || []).map(f => [f.id, f]));
  const evidence = new Map((reasoning.evidence || []).map(e => [e.id, e]));
  const inquiry = (reasoning.gaps || []).filter(g => g.route === 'EXTERNAL_INQUIRY' && ['OPEN', 'STILL_OPEN'].includes(g.state)).length;
  return `<div class="rv-report"><div class="rv-intro"><div><span class="rv-eyebrow">IRAC 분석 흐름</span><h3>쟁점별 규범 · 적용 · 결론</h3><p>쟁점마다 적용 규범과 사실 포섭을 연결한 뒤 작은 결론을 도출합니다.</p></div><span class="rv-count">${issues.length}개 쟁점</span></div>
    ${!report && inquiry ? `<div class="rv-summary">외부 전문가 질의 필요 ${inquiry}건 <button type="button" class="btn btn-xs btn-outline" data-open-learning>질의로 이동</button></div>` : ''}
    ${issues.map((issue, index) => issueCard(issue, index, facts, evidence, reasoning.gaps || [])).join('')}
    ${synthesis(reasoning, review)}</div>`;
}
