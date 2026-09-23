// server/reasoning/stages/application.js - S4 포섭 (쟁점당 LLM 1회)
//
// 쟁점마다 요건 × 사실 × 근거를 대응시킨다. 모델에게는 닫힌 질문만 묻는다:
// "이 요건은 충족되는가, 어떤 사실과 어떤 근거 ID 때문인가". 결론은 verify/conclusion.js가 계산한다.
//
// 프롬프트: [공통 접두부 P0][사실·쟁점 목록 — 실행 공통][이 쟁점의 요건·근거 원문][과제]
// 앞의 두 부분은 모든 쟁점에서 같으므로 쟁점을 연속으로 돌리면 입력 처리가 캐시에서 나온다.
import { runStage, StageError } from '../stageRunner.js';
import { REASONING_SYSTEM } from '../prompts.js';
import { applyFactProvenance, computeIssueConclusion, narrativeConflicts } from '../verify/conclusion.js';

export const ELEMENT_STATUS = ['SATISFIED', 'NOT_SATISFIED', 'PARTIALLY_SATISFIED', 'DISPUTED', 'UNKNOWN'];
export const PROOF = ['SUFFICIENT', 'INSUFFICIENT', 'CONFLICTING', 'NO_EVIDENCE'];
const ISSUE_EVIDENCE_CHARS = 9000;

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

const TASK = withReasoning => `[과제: 요건별 포섭]
${withReasoning ? '먼저 reasoning에 판단 과정을 300자 이내로 적는다.\n' : ''}1. assessments: [판단할 요건] 각각에 대해
   - status: SATISFIED / NOT_SATISFIED / PARTIALLY_SATISFIED / DISPUTED / UNKNOWN. 자료로 판단할 수 없으면 UNKNOWN이다.
   - proof: 그 판단을 뒷받침하는 사실이 원문으로 입증되는지 — SUFFICIENT / INSUFFICIENT / CONFLICTING / NO_EVIDENCE.
     법리상 충족 여부(status)와 입증 여부(proof)는 따로 판단한다.
   - factIds / contraryFactIds: 요건을 뒷받침하는 사실과 반대되는 사실의 ID.
   - evidenceIds: 판단의 법적 근거 ID. 외부 참고 지식(K…)만으로 판단하지 않는다.
   - analysis: 200자 이내. openQuestion: 자료로는 답할 수 없어 판단을 막는 법리 질문이 있으면 한 문장, 없으면 빈 문자열.
2. precedents: 근거 원문에 있는 판례·해석례 각각이 이 사안과 결정적 사실에서 같은지(ANALOGOUS) 다른지(DISTINGUISH), 무관한지(NOT_RELEVANT),
   그리고 이 쟁점에서 어느 쪽을 지지하는지(SUPPORTS: 요건 충족 쪽 / OPPOSES / NEUTRAL)와 결정적 차이·공통점을 적는다.
3. counter: 가장 강한 반대 논리(반대 근거 후보를 먼저 검토)와 그 근거 ID, 그에 대한 응답. 응답할 수 없으면 response를 빈 문자열로 둔다.
4. narrative: 쟁점 판단을 600자 이내로 쓴다. 법적 주장마다 [ID]를 붙인다. 판단할 수 없는 부분은 유보한다고 쓴다.`;

export function applicationSchema({ elementIds, evidenceIds, factIds, authorityIds, withReasoning }) {
  const idList = (values, max) => values.length
    ? { type: 'array', maxItems: max, items: { type: 'string', enum: values } }
    : { type: 'array', maxItems: 0, items: { type: 'string' } };
  const properties = {
    ...(withReasoning ? { reasoning: { type: 'string', maxLength: 300 } } : {}),
    assessments: { type: 'array', maxItems: elementIds.length, items: { type: 'object', additionalProperties: false,
      required: ['elementId', 'status', 'proof', 'factIds', 'contraryFactIds', 'evidenceIds', 'analysis', 'openQuestion'],
      properties: { elementId: { type: 'string', enum: elementIds }, status: { type: 'string', enum: ELEMENT_STATUS },
        proof: { type: 'string', enum: PROOF }, factIds: idList(factIds, 6), contraryFactIds: idList(factIds, 4),
        evidenceIds: idList(evidenceIds, 6), analysis: { type: 'string', maxLength: 200 }, openQuestion: { type: 'string', maxLength: 160 } } } },
    precedents: { type: 'array', maxItems: authorityIds.length, items: { type: 'object', additionalProperties: false,
      required: ['id', 'relation', 'stance', 'decisiveFactor'],
      properties: { id: authorityIds.length ? { type: 'string', enum: authorityIds } : { type: 'string' },
        relation: { type: 'string', enum: ['ANALOGOUS', 'DISTINGUISH', 'NOT_RELEVANT'] },
        stance: { type: 'string', enum: ['SUPPORTS', 'OPPOSES', 'NEUTRAL'] }, decisiveFactor: { type: 'string', maxLength: 120 } } } },
    counter: { type: 'object', additionalProperties: false, required: ['position', 'evidenceIds', 'response'],
      properties: { position: { type: 'string', maxLength: 200 }, evidenceIds: idList(evidenceIds, 4), response: { type: 'string', maxLength: 200 } } },
    narrative: { type: 'string', maxLength: 600 }
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

/**
 * 한 쟁점의 포섭을 실행한다. 실패해도 예외를 올리지 않고 쟁점을 FAILED로 표시해 돌려준다.
 * 한 쟁점의 실패가 다른 쟁점 결과를 버리게 하지 않기 위함이다.
 */
export async function applyIssue({ issue, elements, research, registry, facts, runPrefix, predecessors = [], provider, config, session }) {
  const factsById = new Map(facts.map(f => [f.id, f]));
  const evidenceIds = [...new Set([...research.evidenceIds, ...research.adverseCandidateIds])];
  const rendered = registry.renderFull([...evidenceIds, ...research.documentIds], { maxChars: ISSUE_EVIDENCE_CHARS });
  const allowedEvidence = [...new Set(rendered.included.flatMap(id => [id, ...registry.children(id).map(c => c.id)])
    .filter(id => !registry.get(id).kind.startsWith('DOCUMENT')))];
  const authorityIds = [...new Set(allowedEvidence.map(id => registry.get(id)).filter(e => /^(PRECEDENT|INTERPRETATION)/.test(e.kind))
    .map(e => e.parentId || e.id))];
  const withReasoning = config.think !== true;
  const schema = applicationSchema({ elementIds: elements.map(e => e.id), evidenceIds: allowedEvidence,
    factIds: facts.map(f => f.id), authorityIds, withReasoning });

  const base = { issueId: issue.id, elements, evidenceIds: rendered.included, omittedEvidence: rendered.omitted, documentIds: research.documentIds };
  if (!elements.length) {
    return { ...base, stageStatus: 'SKIPPED', assessments: [], precedents: [], counter: null, narrative: '', openQuestions: [],
      conclusion: computeIssueConclusion([], [], predecessors), warnings: ['판단할 요건이 없어 포섭을 생략했습니다(쟁점에 연결된 조문 없음).'] };
  }

  let value;
  let attempts;
  try {
    ({ value, attempts } = await runStage({ stage: `s4:${issue.id}`, provider, system: REASONING_SYSTEM,
      prefix: `${runPrefix}\n\n${issueBlock({ issue, elements, evidenceText: rendered.text, omittedEvidence: rendered.omitted,
        adverseIds: research.adverseCandidateIds.filter(id => rendered.included.includes(id) || rendered.included.includes(registry.get(id)?.parentId)), predecessors })}`,
      task: TASK(withReasoning), schema, config, session }));
  } catch (err) {
    if (!(err instanceof StageError)) throw err;
    const assessments = elements.map(e => ({ elementId: e.id, status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [], contraryFactIds: [],
      evidenceIds: [], analysis: '모델 판단 실패', openQuestion: '' }));
    return { ...base, stageStatus: 'FAILED', error: err.message, assessments, precedents: [], counter: null, narrative: '',
      openQuestions: [], conclusion: { ...computeIssueConclusion(elements, assessments, predecessors), reasons: ['포섭 단계 실패'] }, warnings: [] };
  }

  const warnings = [];
  // 요건별 판단: 빠진 요건은 UNKNOWN, 원문 미확인 사실만으로는 입증 충분으로 보지 않는다.
  const given = new Map(value.assessments.map(a => [a.elementId, a]));
  const assessments = elements.map(e => {
    const raw = given.get(e.id);
    if (!raw) { warnings.push(`요건 ${e.id} 판단 누락 — UNKNOWN으로 처리`); return { elementId: e.id, status: 'UNKNOWN', proof: 'NO_EVIDENCE', factIds: [], contraryFactIds: [], evidenceIds: [], analysis: '판단 누락', openQuestion: '' }; }
    const adjusted = applyFactProvenance({ ...raw, openQuestion: String(raw.openQuestion || '').trim() }, factsById);
    const official = adjusted.evidenceIds.some(id => registry.get(id)?.official);
    return { ...adjusted, knowledgeOnly: adjusted.evidenceIds.length > 0 && !official };
  });

  const conclusion = computeIssueConclusion(elements, assessments, predecessors);
  const allowed = new Set([...allowedEvidence, ...facts.map(f => f.id), ...elements.map(e => e.id), ...research.documentIds]);
  const narrative = cleanNarrative(value.narrative, allowed);
  if (narrative.removed.length) warnings.push(`서술에서 이 쟁점의 근거가 아닌 표기 제거: ${narrative.removed.join(', ')}`);
  const conflicts = narrativeConflicts(narrative.text, conclusion);
  if (conflicts.length) warnings.push(`서술이 판단 유보 결론과 달리 단정합니다: "${conflicts[0]}" — 결론 표를 따르십시오.`);

  // 게이트 사유: 사람이 반드시 봐야 하는 경우.
  const decidingAssessments = assessments.filter(a => conclusion.decidingElementIds.includes(a.elementId));
  const gateReasons = [];
  if (!assessments.some(a => a.evidenceIds.some(id => registry.get(id)?.official))) gateReasons.push('공식 근거에 기댄 요건 판단이 없음');
  if (decidingAssessments.some(a => a.knowledgeOnly)) gateReasons.push('결론을 좌우한 요건이 외부 참고 지식에만 기댐');
  if (value.counter?.position && !value.counter.response) gateReasons.push('가장 강한 반대 논리에 대한 응답 없음');

  return { ...base, stageStatus: 'OK', attempts, reasoning: value.reasoning || null, assessments,
    precedents: value.precedents, counter: value.counter, narrative: narrative.text,
    openQuestions: assessments.filter(a => a.openQuestion).map(a => ({ elementId: a.elementId, question: a.openQuestion })),
    conclusion, gateReasons, warnings };
}
