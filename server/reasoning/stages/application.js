// server/reasoning/stages/application.js - S4 포섭 (쟁점의 요건·근거를 작은 묶음으로 처리)
//
// 쟁점마다 요건 × 사실 × 근거를 대응시킨다. 모델에게는 닫힌 질문만 묻는다:
// "이 요건은 충족되는가, 어떤 사실과 어떤 근거 ID 때문인가". 결론은 verify/conclusion.js가 계산한다.
//
// 프롬프트: [쟁점 관련 사실][최대 4개 요건·근거 원문][과제].
import { runStage, StageError } from '../stageRunner.js';
import { REASONING_SYSTEM } from '../prompts.js';
import { applyFactProvenance, computeIssueConclusion, narrativeConflicts } from '../verify/conclusion.js';
import { stripFalseDocumentAbsence } from '../contractReview.js';

export const ELEMENT_STATUS = ['SATISFIED', 'NOT_SATISFIED', 'PARTIALLY_SATISFIED', 'DISPUTED', 'UNKNOWN'];
export const PROOF = ['SUFFICIENT', 'INSUFFICIENT', 'CONFLICTING', 'NO_EVIDENCE'];
const ISSUE_EVIDENCE_CHARS = 9000;
const ELEMENT_BATCH = 4;
const FRAGMENT_CHARS = 900;
const fragmentToken = (id, start, end) => `${id}@fragment:${start}:${end}`;
const parseFragment = value => String(value).match(/^([A-Z][A-Za-z0-9._]*)@fragment:(\d+):(\d+)$/);
// 길이 상한은 곧 출력 토큰 상한이다. 실측(사례 01): 쟁점당 출력 958~1,835토큰, 이 단계가 전체 모델 시간의 약 60%.

const FACT_LABEL = { CONFIRMED: '확인', ALLEGED: '주장', DISPUTED: '다툼', UNKNOWN: '자료 없음', INFERRED: '추론(원문 미확인)' };

/** 실행 공통 접두부: P0 뒤에 S1이 확정한 사실과 쟁점 목록을 붙인다. 쟁점마다 바뀌지 않는다. */
export function buildRunPrefix(commonPrefix, { facts, issues, unknownFacts = [] }) {
  const factLines = facts.map(f => `[${f.id}] (${FACT_LABEL[f.status] || f.status}${f.docRef ? `, ${f.docRef}` : ''}) ${f.text}`);
  const issueLines = issues.map(i => `[${i.id}] ${i.question}${i.dependsOn.length ? ` (선결: ${i.dependsOn.join(', ')})` : ''}`);
  return `${commonPrefix}\n\n[정리된 사실 — 원문 미확인 사실은 입증 근거로 쓰지 않는다]\n${factLines.join('\n') || '(없음)'}`
    + `${unknownFacts.length ? `\n[자료에 없는 사실]\n${unknownFacts.map(u => `- ${u}`).join('\n')}` : ''}`
    + `\n\n[쟁점 목록]\n${issueLines.join('\n')}`;
}

const LEGAL_LABEL = { APPLIES: '요건 충족', NOT_APPLICABLE: '요건 불충족', EXCEPTION_APPLIES: '예외 적용', CONDITIONAL: '판단 유보' };

function issueBlock({ issue, elements, evidenceText, omittedEvidence, adverseIds, predecessors }) {
  return [
    `[검토 쟁점 ${issue.id}] ${issue.question}`,
    issue.positions?.length ? `[대립 견해]\n${issue.positions.map(p => `- ${p.label}: ${p.claim}${p.evidenceIds.length ? ` (${p.evidenceIds.join(', ')})` : ''}`).join('\n')}` : '',
    predecessors.length ? `[선결 쟁점 결론]\n${predecessors.map(p => `- ${p.issueId}: ${LEGAL_LABEL[p.legal] || p.legal}`).join('\n')}` : '',
    `[판단할 요건]\n${elements.map(e => `[${e.id}] ${e.isException ? '(예외) ' : e.mandatory ? '(필수) ' : '(택일) '}${e.text} — 출처 ${e.sourceIds.join(', ')}`).join('\n')}`,
    `[이 쟁점의 근거 원문]${omittedEvidence.length ? ` (분량 제한으로 제외: ${omittedEvidence.join(', ')})` : ''}\n${evidenceText || '(없음)'}`,
    adverseIds.length ? `[반대 근거 후보 — 결론을 뒤집을 수 있는 단서·예외]: ${adverseIds.join(', ')}` : ''
  ].filter(Boolean).join('\n\n');
}

const TASK = (withReasoning, contractMode = false) => `[과제: 요건별 포섭]
${withReasoning ? '먼저 reasoning에 판단 과정을 200자 이내로 적는다.\n' : ''}1. assessments: [판단할 요건] 각각에 대해
   - status: SATISFIED / NOT_SATISFIED / PARTIALLY_SATISFIED / DISPUTED / UNKNOWN. 자료로 판단할 수 없으면 UNKNOWN이다.
   - proof: 그 판단을 뒷받침하는 사실이 원문으로 입증되는지 — SUFFICIENT / INSUFFICIENT / CONFLICTING / NO_EVIDENCE.
     법리상 충족 여부(status)와 입증 여부(proof)는 따로 판단한다.
   - factIds / contraryFactIds: 요건을 뒷받침하는 사실과 반대되는 사실의 ID.
   - evidenceIds: 판단의 법적 근거 ID. 외부 참고 지식(K…)만으로 판단하지 않는다.
${contractMode ? '   - documentSupportIds: 계약서 문언을 뒷받침하는 D ID. 법적 근거인 evidenceIds와 구별한다. 계약에 권한이 적혀 있다는 사실과 실제 행사 사실을 구별한다.\n' : ''}
   - analysis: 120자 이내. openQuestion: 자료로는 답할 수 없어 판단을 막는 법리 질문이 있으면 한 문장(120자 이내), 없으면 빈 문자열.
2. precedents: 근거 원문에 있는 판례·해석례 각각이 이 사안과 결정적 사실에서 같은지(ANALOGOUS) 다른지(DISTINGUISH), 무관한지(NOT_RELEVANT),
   그리고 이 쟁점에서 어느 쪽을 지지하는지(SUPPORTS: 요건 충족 쪽 / OPPOSES / NEUTRAL)와 결정적 차이·공통점을 적는다.
3. counter: 가장 강한 반대 논리(반대 근거 후보를 먼저 검토)와 그 근거 ID, 그에 대한 응답. 응답할 수 없으면 response를 빈 문자열로 둔다.
4. narrative: 쟁점 판단을 400자 이내로 쓴다. 법적 주장마다 [ID]를 붙인다. 판단할 수 없는 부분은 유보한다고 쓴다.`;

export function applicationSchema({ elementIds, evidenceIds, documentIds = [], factIds, authorityIds, withReasoning }) {
  const idList = (values, max) => values.length
    ? { type: 'array', maxItems: max, items: { type: 'string', enum: values } }
    : { type: 'array', maxItems: 0, items: { type: 'string' } };
  const properties = {
    ...(withReasoning ? { reasoning: { type: 'string', maxLength: 200 } } : {}),
    assessments: { type: 'array', maxItems: elementIds.length, items: { type: 'object', additionalProperties: false,
      required: ['elementId', 'status', 'proof', 'factIds', 'contraryFactIds', 'evidenceIds', 'analysis', 'openQuestion'],
      properties: { elementId: { type: 'string', enum: elementIds }, status: { type: 'string', enum: ELEMENT_STATUS },
        proof: { type: 'string', enum: PROOF }, factIds: idList(factIds, 6), contraryFactIds: idList(factIds, 4),
        evidenceIds: idList(evidenceIds, 6), documentSupportIds: idList(documentIds, 6),
        analysis: { type: 'string', maxLength: 120 }, openQuestion: { type: 'string', maxLength: 120 } } } },
    precedents: { type: 'array', maxItems: authorityIds.length, items: { type: 'object', additionalProperties: false,
      required: ['id', 'relation', 'stance', 'decisiveFactor'],
      properties: { id: authorityIds.length ? { type: 'string', enum: authorityIds } : { type: 'string' },
        relation: { type: 'string', enum: ['ANALOGOUS', 'DISTINGUISH', 'NOT_RELEVANT'] },
        stance: { type: 'string', enum: ['SUPPORTS', 'OPPOSES', 'NEUTRAL'] }, decisiveFactor: { type: 'string', maxLength: 80 } } } },
    counter: { type: 'object', additionalProperties: false, required: ['position', 'evidenceIds', 'response'],
      properties: { position: { type: 'string', maxLength: 150 }, evidenceIds: idList(evidenceIds, 4), response: { type: 'string', maxLength: 150 } } },
    narrative: { type: 'string', maxLength: 400 }
  };
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

/** 서술 속 [ID] 표기 중 이 쟁점에서 허용되지 않은 것을 걷어낸다. */
export function cleanNarrative(narrative, allowed) {
  const removed = [];
  const text = String(narrative || '').replace(/\[([A-Z][A-Za-z0-9._]*)\]/g, (match, id) => {
    if (allowed.has(id)) return match;
    removed.push(id);
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
  return { text, removed };
}

/** S4는 S1/S5의 사건 전체 접두부 대신 쟁점에 연결된 사실만 받는다. */
export function buildIssuePrefix(registry, issue, facts) {
  const relevant = facts.filter(f => issue.factIds.includes(f.id));
  return `[검토 기준일] ${registry.asOf}\n\n[이 쟁점의 사실 — 원문 미확인 사실은 입증 근거로 쓰지 않는다]\n`
    + (relevant.map(f => `[${f.id}] (${FACT_LABEL[f.status] || f.status}${f.docRef ? `, ${f.docRef}` : ''}) ${f.text}`).join('\n') || '(없음)');
}

/** 여러 근거 묶음의 판단이 충돌하면 확정하지 않고 DISPUTED로 합친다. */
function mergeApplications(values, elements) {
  if (values.length === 1) return values[0];
  const unique = items => [...new Set(items)];
  const assessments = elements.map(element => {
    const rows = values.flatMap(v => v.assessments || []).filter(a => a.elementId === element.id);
    const material = rows.filter(a => a.status !== 'UNKNOWN');
    const statuses = unique(material.map(a => a.status));
    const first = material[0] || rows[0];
    if (!first) return null;
    return { ...first, status: statuses.length > 1 ? 'DISPUTED' : statuses[0] || 'UNKNOWN',
      proof: statuses.length > 1 ? 'CONFLICTING' : material.some(a => a.proof === 'CONFLICTING') ? 'CONFLICTING' : first.proof,
      factIds: unique(rows.flatMap(a => a.factIds || [])), contraryFactIds: unique(rows.flatMap(a => a.contraryFactIds || [])),
      evidenceIds: unique(rows.flatMap(a => a.evidenceIds || [])),
      documentSupportIds: unique(rows.flatMap(a => a.documentSupportIds || [])),
      analysis: statuses.length > 1 ? '근거 묶음 사이 판단 불일치' : first.analysis,
      openQuestion: statuses.length > 1 ? '상충하는 근거의 적용 관계 확인 필요' : first.openQuestion };
  }).filter(Boolean);
  const precedents = [...new Map(values.flatMap(v => v.precedents || []).map(p => [p.id, p])).values()];
  return { assessments, precedents, counter: values.map(v => v.counter).find(c => c?.position && c?.response)
    || values.map(v => v.counter).find(Boolean) || null,
  narrative: values.map(v => v.narrative || '').filter(Boolean).join('\n'),
  reasoning: values.map(v => v.reasoning || '').filter(Boolean).join('\n') };
}

function validateContractCounter(counter, registry) {
  if (!counter?.position) return null;
  const position = String(counter.position);
  if (/자료로 확인되지|추측하지 않|모른다고 표시|시스템|프롬프트|검토 원칙|자료 부족|당사자.{0,8}합의.{0,15}유효할 수도/.test(position)) return null;
  const basisIds = (counter.evidenceIds || []).filter(id => registry.get(id)?.official && registry.get(id)?.inForce);
  if (!basisIds.length) return null;
  return { ...counter, basisIds, basisType: 'AUTHORITY' };
}

/**
 * 한 쟁점의 포섭을 실행한다. 실패해도 예외를 올리지 않고 쟁점을 FAILED로 표시해 돌려준다.
 * 한 쟁점의 실패가 다른 쟁점 결과를 버리게 하지 않기 위함이다.
 */
export async function applyIssue({ issue, elements, research, registry, facts, runPrefix, predecessors = [], provider, config, session,
  contractMode = false }) {
  const factsById = new Map(facts.map(f => [f.id, f]));
  const evidenceIds = [...new Set([...research.evidenceIds, ...research.adverseCandidateIds])];
  const withReasoning = config.think !== true;
  const base = { issueId: issue.id, elements, evidenceIds: [], omittedEvidence: [], documentIds: research.documentIds };
  if (!elements.length) {
    return { ...base, stageStatus: 'SKIPPED', assessments: [], precedents: [], counter: null, narrative: '', openQuestions: [],
      conclusion: computeIssueConclusion([], [], predecessors), warnings: ['판단할 요건이 없어 포섭을 생략했습니다(쟁점에 연결된 조문 없음).'] };
  }

  const values = [];
  const included = [];
  const allowedEvidence = new Set();
  const warnings = [];
  const failedIds = [];
  let attempts = 0;
  let lastError = null;
  const elementGroups = [];
  for (let i = 0; i < elements.length; i += ELEMENT_BATCH) elementGroups.push(elements.slice(i, i + ELEMENT_BATCH));
  for (const [groupIndex, groupElements] of elementGroups.entries()) {
  let pending = [...evidenceIds, ...research.documentIds];
  let maxChars = ISSUE_EVIDENCE_CHARS;
  for (let batch = 0; pending.length || batch === 0; batch++) {
    const fragment = pending.length ? parseFragment(pending[0]) : null;
    const rendered = fragment ? (() => {
      const [, id, rawStart, rawEnd] = fragment;
      const entry = registry.get(id);
      const start = Number(rawStart); const end = Number(rawEnd);
      return { text: `[${id}] ${entry.label} (원문 ${start}-${end})\n${entry.text.slice(start, end)}`,
        included: [id], omitted: pending.slice(1) };
    })() : registry.renderFull(pending, { maxChars });
    if (pending.length && !rendered.included.length) {
      const first = pending[0];
      const kind = registry.get(first)?.kind;
      const allChildren = registry.children(first).filter(e => e.text);
      const canSplit = ['DOCUMENT', 'PRECEDENT', 'INTERPRETATION', 'ADMIN_RULE'].includes(kind)
        || (['ARTICLE', 'ORDINANCE_ARTICLE'].includes(kind) && allChildren.some(e => e.kind === 'ARTICLE_UNIT'));
      const children = canSplit ? allChildren : [];
      if (children.length && maxChars <= 2500) { pending = [...children.map(e => e.id), ...pending.slice(1)]; maxChars = ISSUE_EVIDENCE_CHARS; batch--; continue; }
      if (maxChars > 1200) { maxChars = Math.floor(maxChars / 2); batch--; continue; }
      const entry = registry.get(first);
      if (entry?.text.length > 180 && !children.length) {
        const tokens = [];
        const step = entry.text.length > FRAGMENT_CHARS ? FRAGMENT_CHARS : Math.ceil(entry.text.length / 2);
        for (let start = 0; start < entry.text.length; start += step)
          tokens.push(fragmentToken(first, start, Math.min(entry.text.length, start + step)));
        pending = [...tokens, ...pending.slice(1)]; maxChars = ISSUE_EVIDENCE_CHARS; batch--; continue;
      }
      warnings.push(`근거 ${first}는 한 호출의 입력 예산을 초과해 제외했습니다.`);
      failedIds.push(first);
      pending = pending.slice(1);
      continue;
    }
    const batchEvidence = [...new Set(rendered.included.flatMap(id => [id, ...registry.children(id).map(c => c.id)])
      .filter(id => !registry.get(id).kind.startsWith('DOCUMENT')))];
    const authorityIds = [...new Set(batchEvidence.map(id => registry.get(id)).filter(e => /^(PRECEDENT|INTERPRETATION)/.test(e.kind))
      .map(e => e.parentId || e.id))];
    const schema = applicationSchema({ elementIds: groupElements.map(e => e.id), evidenceIds: batchEvidence,
      documentIds: rendered.included.filter(id => registry.get(id)?.kind.startsWith('DOCUMENT')),
      factIds: facts.map(f => f.id), authorityIds, withReasoning });
    try {
      const result = await runStage({ stage: groupIndex || batch ? `s4:${issue.id}:part:${groupIndex + 1}:${batch + 1}` : `s4:${issue.id}`,
        provider, system: REASONING_SYSTEM,
        prefix: `${runPrefix}\n\n${issueBlock({ issue, elements: groupElements, evidenceText: rendered.text, omittedEvidence: rendered.omitted,
          adverseIds: research.adverseCandidateIds.filter(id => rendered.included.includes(id) || rendered.included.includes(registry.get(id)?.parentId)), predecessors })}`,
        task: TASK(withReasoning, contractMode), schema, config, session });
      values.push(result.value); attempts += result.attempts;
      included.push(...rendered.included);
      batchEvidence.forEach(id => allowedEvidence.add(id));
      pending = rendered.omitted;
      maxChars = ISSUE_EVIDENCE_CHARS;
    } catch (err) {
      if (!(err instanceof StageError)) throw err;
      lastError = err;
      if ((err.budgetExceeded || err.cause?.truncated) && fragment && Number(fragment[3]) - Number(fragment[2]) > 180) {
        const [, id, rawStart, rawEnd] = fragment;
        const start = Number(rawStart); const end = Number(rawEnd); const middle = Math.floor((start + end) / 2);
        pending = [fragmentToken(id, start, middle), fragmentToken(id, middle, end), ...rendered.omitted];
        maxChars = ISSUE_EVIDENCE_CHARS; batch--; continue;
      }
      if ((err.budgetExceeded || err.cause?.truncated) && maxChars > 1200) {
        maxChars = Math.floor(maxChars / 2); batch--; continue;
      }
      warnings.push(`근거 묶음 ${rendered.included.join(', ')} 판단 실패: ${err.message}`);
      failedIds.push(...rendered.included);
      pending = rendered.omitted;
    }
  }
  base.omittedEvidence.push(...pending);
  }
  base.evidenceIds = [...new Set(included)];
  base.omittedEvidence = [...new Set([...base.omittedEvidence, ...failedIds])];
  if (!values.length) {
    const assessments = elements.map(e => ({ elementId: e.id, status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [], contraryFactIds: [],
      evidenceIds: [], analysis: '모델 판단 실패', openQuestion: '' }));
    return { ...base, stageStatus: 'FAILED', error: lastError?.message || '근거 묶음 처리 실패', assessments, precedents: [], counter: null, narrative: '',
      openQuestions: [], conclusion: { ...computeIssueConclusion(elements, assessments, predecessors), reasons: ['포섭 단계 실패'] }, warnings };
  }
  const value = mergeApplications(values, elements);
  // 요건별 판단: 빠진 요건은 UNKNOWN, 원문 미확인 사실만으로는 입증 충분으로 보지 않는다.
  const given = new Map(value.assessments.map(a => [a.elementId, a]));
  const assessments = elements.map(e => {
    const raw = given.get(e.id);
    if (!raw) { warnings.push(`요건 ${e.id} 판단 누락 — UNKNOWN으로 처리`); return { elementId: e.id, status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [], contraryFactIds: [], evidenceIds: [], analysis: '판단 누락', openQuestion: '' }; }
    const documentSupportIds = [...new Set([...(raw.documentSupportIds || []),
      ...(raw.factIds || []).map(id => factsById.get(id)?.docRef).filter(id => id?.startsWith('D'))])]
      .filter(id => research.documentIds.includes(registry.get(id)?.parentId || id));
    const sourceIds = contractMode ? (e.sourceIds || []).filter(id => registry.get(id)?.official && registry.get(id)?.inForce) : [];
    const sourceArticles = new Set(sourceIds.map(id => registry.get(id)?.parentId || id));
    const evidenceIds = [...new Set([...sourceIds, ...(raw.evidenceIds || []).filter(id => {
      const entry = registry.get(id);
      return !contractMode || !/^(ARTICLE|ORDINANCE_ARTICLE)/.test(entry?.kind || '')
        || !sourceArticles.size || sourceArticles.has(entry.parentId || id);
    })])];
    const adjusted = applyFactProvenance({ ...raw, evidenceIds, documentSupportIds,
      authorityEvidenceIds: evidenceIds.filter(id => registry.get(id)?.official && registry.get(id)?.inForce),
      openQuestion: String(raw.openQuestion || '').trim() }, factsById);
    if (contractMode) {
      for (const field of ['analysis', 'openQuestion']) {
        const cleaned = stripFalseDocumentAbsence(adjusted[field], registry);
        if (cleaned.removed) { adjusted[field] = cleaned.text; warnings.push(`요건 ${e.id} 서술에서 존재하는 문서의 부재 주장 제거`); }
      }
    }
    const official = adjusted.evidenceIds.some(id => registry.get(id)?.official);
    return { ...adjusted, knowledgeOnly: adjusted.evidenceIds.length > 0 && !official };
  });

  let conclusion = computeIssueConclusion(elements, assessments, predecessors);
  const decisiveIds = new Set(conclusion.decidingElementIds || []);
  const decisive = elements.filter(e => decisiveIds.has(e.id));
  const missingMaterialExternalFact = decisive.some(e => (e.factRequirement === 'EXTERNAL'
    || /실제|현장|손해.{0,8}발생|채무불이행.{0,8}발생/.test(e.text))
    && !assessments.find(a => a.elementId === e.id)?.factIds?.some(id => {
      const fact = factsById.get(id);
      return fact?.sourceType !== 'DOCUMENT' && fact?.quoteVerified && fact?.status === 'CONFIRMED';
    }));
  if (contractMode && missingMaterialExternalFact && conclusion.legal !== 'CONDITIONAL') {
    conclusion = { ...conclusion, ifResolved: conclusion.legal, legal: 'CONDITIONAL',
      legalOutcome: 'CONDITIONAL_ON_MATERIAL_FACT',
      reasons: [...(conclusion.reasons || []), '결론을 좌우하는 외부 사실 확인 필요'] };
  }
  const decisiveIncomplete = decisive.some(e => (e.fallback && e.blocksConclusion === true)
    || (e.sourceIds || []).some(id => base.omittedEvidence.includes(id))
    || !assessments.some(a => a.elementId === e.id && a.analysis !== '판단 누락'));
  if (decisiveIncomplete && conclusion.legal !== 'CONDITIONAL') {
    conclusion = { ...conclusion, legal: 'CONDITIONAL', reasons: [...(conclusion.reasons || []), '일부 요건 또는 근거를 검토하지 못함'] };
  }
  const allowed = new Set([...allowedEvidence, ...facts.map(f => f.id), ...elements.map(e => e.id), ...research.documentIds]);
  const narrative = cleanNarrative(value.narrative, allowed);
  if (contractMode) {
    const cleaned = stripFalseDocumentAbsence(narrative.text, registry);
    if (cleaned.removed) { narrative.text = cleaned.text; warnings.push('서술에서 존재하는 문서의 부재 주장 제거'); }
  }
  if (narrative.removed.length) warnings.push(`서술에서 이 쟁점의 근거가 아닌 표기 제거: ${narrative.removed.join(', ')}`);
  const conflicts = narrativeConflicts(narrative.text, conclusion);
  if (conflicts.length) warnings.push(`서술이 판단 유보 결론과 달리 단정합니다: "${conflicts[0]}" — 결론 표를 따르십시오.`);

  // 게이트 사유: 사람이 반드시 봐야 하는 경우.
  const decidingAssessments = assessments.filter(a => conclusion.decidingElementIds.includes(a.elementId));
  const gateReasons = [];
  if (decisiveIncomplete && warnings.some(w => w.includes('판단 실패'))) gateReasons.push('결론 요건의 근거 묶음 판단 실패');
  if (decisiveIncomplete && base.omittedEvidence.length) gateReasons.push(`결론 요건에서 처리하지 못한 근거: ${base.omittedEvidence.join(', ')}`);
  if (decisive.some(e => e.fallback && e.blocksConclusion === true)) gateReasons.push('결론 요건이 골격으로 대체됨');
  if (decidingAssessments.length && !decidingAssessments.some(a => a.evidenceIds.some(id => registry.get(id)?.official)))
    gateReasons.push('결론 요건의 공식 근거 판단이 없음');
  if (decidingAssessments.some(a => a.knowledgeOnly)) gateReasons.push('결론을 좌우한 요건이 외부 참고 지식에만 기댐');
  if (warnings.some(w => w.includes('존재하는 문서의 부재 주장'))) gateReasons.push('계약 원문과 충돌하는 서술을 제거함');
  const validCounter = contractMode ? validateContractCounter(value.counter, registry) : value.counter;
  if (validCounter?.position && !validCounter.response) gateReasons.push('가장 강한 반대 논리에 대한 응답 없음');

  const hasWarnings = warnings.some(w => w.includes('판단 실패')) || base.omittedEvidence.length || elements.some(e => e.fallback);
  return { ...base, stageStatus: decisiveIncomplete ? 'PARTIAL' : hasWarnings ? 'OK_WITH_WARNINGS' : 'OK',
    attempts, reasoning: value.reasoning || null, assessments,
    precedents: value.precedents, counter: validCounter, narrative: narrative.text,
    openQuestions: assessments.filter(a => a.openQuestion).map(a => ({ elementId: a.elementId, question: a.openQuestion })),
    conclusion, gateReasons, warnings };
}
