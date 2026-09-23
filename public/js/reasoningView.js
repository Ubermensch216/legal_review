// public/js/reasoningView.js - 단계형 검토의 쟁점·요건 보기
//
// 단계형 검토(review.reasoning)는 쟁점마다 요건별 판단과 코드가 계산한 결론을 갖는다.
// 서술문을 문단으로 쪼개 보여주는 대신, 결론이 어느 요건에서 나왔는지 표로 보여준다.
// 단계형이 아닌 검토에는 쓰지 않는다(호출부가 reasoning 유무로 고른다).

const LEGAL = { APPLIES: ['요건 충족', 'ok'], NOT_APPLICABLE: ['요건 불충족', 'no'], EXCEPTION_APPLIES: ['예외 적용', 'warn'], CONDITIONAL: ['판단 유보', 'hold'] };
const STATUS = { SATISFIED: '충족', NOT_SATISFIED: '불충족', PARTIALLY_SATISFIED: '일부 충족', DISPUTED: '다툼', UNKNOWN: '미확정' };
const PROOF = { SUFFICIENT: '입증 충분', INSUFFICIENT: '입증 부족', CONFLICTING: '자료 상충', NO_EVIDENCE: '입증 자료 없음' };
const RELATION = { ANALOGOUS: '유사', DISTINGUISH: '구별', NOT_RELEVANT: '무관' };
const STANCE = { SUPPORTS: '충족 쪽', OPPOSES: '반대 쪽', NEUTRAL: '중립' };
const GAP = { LEGAL_INTERPRETATION: '해석 기준', AUTHORITY_CONFLICT: '근거 충돌', MISSING_AUTHORITY: '근거 부재', STAGE_FAILURE: '판단 실패',
  FACT_UNKNOWN: '사실 확인', COLLECTION_FAILURE: '수집 실패' };

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** [A1.2] 같은 ID를 마우스를 올리면 출처가 보이는 표식으로 바꾼다. */
function idChips(text, labels) {
  return esc(text).replace(/\[([A-Z][A-Za-z0-9._]*)\]/g, (m, id) => labels.has(id)
    ? `<span class="rv-id" title="${esc(labels.get(id))}">${esc(id)}</span>` : m);
}
const chipList = (ids, labels) => (ids || []).map(id => `<span class="rv-id" title="${esc(labels.get(id) || '')}">${esc(id)}</span>`).join(' ');

function issueCard(issue, labels, gaps) {
  const [legalLabel, tone] = LEGAL[issue.conclusion?.legal] || LEGAL.CONDITIONAL;
  const elements = new Map((issue.elements || []).map(e => [e.id, e]));
  const rows = (issue.assessments || []).map(a => {
    const e = elements.get(a.elementId) || {};
    const deciding = issue.conclusion?.decidingElementIds?.includes(a.elementId);
    return `<tr class="${deciding ? 'rv-deciding' : ''}">
      <td>${e.isException ? '<span class="rv-tag">예외</span> ' : e.mandatory === false ? '<span class="rv-tag">택일</span> ' : ''}${esc(e.text || a.elementId)}</td>
      <td class="rv-status rv-${esc(a.status).toLowerCase()}">${esc(STATUS[a.status] || a.status)}</td>
      <td>${esc(PROOF[a.proof] || a.proof)}${a.proofAdjusted ? ' <span class="rv-note" title="' + esc(a.proofAdjusted) + '">보정</span>' : ''}</td>
      <td>${chipList(a.evidenceIds, labels)}${a.knowledgeOnly ? ' <span class="rv-note">외부 지식만</span>' : ''}</td>
      <td>${idChips(a.analysis || '', labels)}</td>
    </tr>`;
  }).join('');
  const precedents = (issue.precedents || []).filter(p => p.relation !== 'NOT_RELEVANT').map(p =>
    `<li>${chipList([p.id], labels)} ${esc(RELATION[p.relation])} · ${esc(STANCE[p.stance])} — ${esc(p.decisiveFactor)}</li>`).join('');
  const issueGaps = gaps.filter(g => g.issueId === issue.id);
  return `<div class="opinion-item-card rv-issue">
    <div class="rv-issue-head">
      <h4>[${esc(issue.id)}] ${esc(issue.question)}</h4>
      <span class="rv-verdict rv-${tone}">${esc(legalLabel)}</span>
    </div>
    <div class="rv-meta">${esc(PROOF[issue.conclusion?.proof] || '')}${issue.conclusion?.ifResolved ? ` · 선결 쟁점이 풀리면 ${esc((LEGAL[issue.conclusion.ifResolved] || [])[0])}` : ''}
      ${issue.reused ? ' · 이전 판단 재사용' : ''}${issue.stageStatus === 'FAILED' ? ' · <b>모델 판단 실패</b>' : ''}</div>
    ${(issue.conclusion?.reasons || []).length ? `<p class="rv-reasons">${esc(issue.conclusion.reasons.join(' / '))}</p>` : ''}
    ${rows ? `<table class="rv-table"><thead><tr><th>요건</th><th>판단</th><th>입증</th><th>근거</th><th>분석</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="placeholder-text">판단한 요건이 없습니다.</p>'}
    ${issue.narrative ? `<p class="rv-narrative">${idChips(issue.narrative, labels)}</p>` : ''}
    ${precedents ? `<div class="rv-sub"><b>판례·해석례 대비</b><ul>${precedents}</ul></div>` : ''}
    ${issue.counter?.position ? `<div class="rv-sub"><b>가장 강한 반대 논리</b><p>${idChips(issue.counter.position, labels)}</p>
      <p>${issue.counter.response ? `응답: ${idChips(issue.counter.response, labels)}` : '<span class="rv-note">반박하지 못함 — 검토 필요</span>'}</p></div>` : ''}
    ${issueGaps.length ? `<div class="rv-sub"><b>판단 공백</b><ul>${issueGaps.map(g => `<li><span class="rv-tag">${esc(GAP[g.type] || g.type)}</span>
      ${g.route === 'EXTERNAL_INQUIRY' ? '<span class="rv-route">외부 전문가 질의</span>' : g.route === 'USER' ? '<span class="rv-route">사용자 확인</span>' : ''} ${esc(g.question)}</li>`).join('')}</ul></div>` : ''}
  </div>`;
}

/** 단계형 검토의 쟁점별 카드와 공백 요약. */
export function renderReasoningOpinion(reasoning) {
  const labels = new Map((reasoning.evidence || []).map(e => [e.id, e.label]));
  for (const f of reasoning.facts || []) labels.set(f.id, f.text);
  const gaps = reasoning.gaps || [];
  const inquiry = gaps.filter(g => g.route === 'EXTERNAL_INQUIRY' && ['OPEN', 'STILL_OPEN'].includes(g.state)).length;
  const user = gaps.filter(g => g.route === 'USER').length;
  const transitions = reasoning.reuse?.gapTransitions || [];
  const summary = `<div class="rv-summary">
    <span>쟁점 ${reasoning.issues.length}개</span>
    <span>외부 전문가 질의 필요 <b>${inquiry}</b></span>
    <span>사용자 확인 필요 <b>${user}</b></span>
    ${transitions.length ? `<span>이전 공백 해소 <b>${transitions.filter(t => t.state === 'RESOLVED').length}/${transitions.length}</b></span>` : ''}
    ${reasoning.gate === 'HUMAN_REVIEW_REQUIRED' ? `<span class="rv-note" title="${esc((reasoning.gateReasons || []).join(' / '))}">사람 검토 필요</span>` : ''}
    ${inquiry ? '<button type="button" class="btn btn-xs btn-outline" data-open-learning>외부 전문가 질의로 이동</button>' : ''}
  </div>`;
  return `<div class="opinion-section-block">${summary}${reasoning.issues.map(i => issueCard(i, labels, gaps)).join('')}</div>`;
}
