// server/reasoning/stages/synthesis.js - S5 종합 (LLM 1회, think off) + 기존 검토 형식(v1) 조립
//
// 결론은 이미 쟁점별로 코드가 계산했다. 여기서 모델은 그 결론 표를 읽고 요약·위험·권고만 짧게 쓴다.
// 검토의견서 본문(draftOpinion)은 모델이 쓰지 않고 쟁점 서술·결론 표에서 조립한다.
// 과거 단일 호출은 같은 내용을 legalOpinion과 draftOpinion에 두 번 생성했다.
import { runStage } from '../stageRunner.js';
import { REASONING_SYSTEM } from '../prompts.js';
import { formatArticleNo } from '../evidenceRegistry.js';

export const LEGAL_LABEL = { APPLIES: '요건 충족', NOT_APPLICABLE: '요건 불충족', EXCEPTION_APPLIES: '예외 적용', CONDITIONAL: '판단 유보' };
const PROOF_LABEL = { SUFFICIENT: '입증 충분', INSUFFICIENT: '입증 부족', CONFLICTING: '자료 상충', NO_EVIDENCE: '입증 자료 없음' };
const STATUS_LABEL = { SATISFIED: '충족', NOT_SATISFIED: '불충족', PARTIALLY_SATISFIED: '일부 충족', DISPUTED: '다툼', UNKNOWN: '미확정' };
export const DISCLAIMER = '본 검토의견서는 AI 법령검토 엔진에 의해 작성된 사전 분석 참고자료이며, 구체적인 행정처분, 소송 또는 계약 체결 시에는 법률전문가(변호사)의 최종 감수를 거치시기 바랍니다.';

/** 쟁점별 결론 표. 모델 입력과 보고서 본문에 같은 표를 쓴다. */
export function conclusionTable(issues, issueResults) {
  return issues.map(issue => {
    const r = issueResults.find(x => x.issueId === issue.id);
    const c = r?.conclusion || {};
    const deciding = (c.decidingElementIds || []).map(id => r.elements.find(e => e.id === id)?.text).filter(Boolean);
    return `[${issue.id}] ${issue.question}\n  결론: ${LEGAL_LABEL[c.legal] || '판단 유보'}${c.ifResolved ? ` (선결 쟁점이 풀리면 ${LEGAL_LABEL[c.ifResolved]})` : ''} · ${PROOF_LABEL[c.proof] || ''}`
      + `${deciding.length ? `\n  결정 요건: ${deciding.join(' / ')}` : ''}${r?.counter?.position ? `\n  반대 논리: ${r.counter.position}` : ''}`;
  }).join('\n');
}

const schema = ({ issueIds, preConsulting, citableIds }) => {
  const properties = {
    summary: { type: 'string', maxLength: 400 },
    risks: { type: 'array', maxItems: issueIds.length, items: { type: 'object', additionalProperties: false, required: ['issueId', 'level', 'title', 'description'],
      properties: { issueId: { type: 'string', enum: issueIds }, level: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        title: { type: 'string', maxLength: 60 }, description: { type: 'string', maxLength: 200 } } } },
    recommendations: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 120 } }
  };
  if (preConsulting) {
    properties.positions = { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['issueId', 'label', 'verdict', 'assessment'],
      properties: { issueId: { type: 'string', enum: issueIds }, label: { type: 'string', maxLength: 20 },
        verdict: { type: 'string', enum: ['타당', '부당', '조건부 타당', '판단 유보'] }, assessment: { type: 'string', maxLength: 200 } } } };
    properties.auditConclusion = { type: 'object', additionalProperties: false, required: ['result', 'reason', 'guidance', 'basisIds'],
      properties: { result: { type: 'string', enum: ['수용', '반려', '일부 수용', '판단 유보'] }, reason: { type: 'string', maxLength: 200 },
        guidance: { type: 'string', maxLength: 200 },
        basisIds: { type: 'array', maxItems: 4, items: citableIds.length ? { type: 'string', enum: citableIds } : { type: 'string' } } } };
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
};

const TASK = ({ table, preConsulting }) => `[과제: 종합]
아래는 쟁점별로 확정된 결론 표다. 결론을 바꾸거나 새로 판단하지 말고 표를 요약한다. 판단 유보인 쟁점은 유보라고 쓴다.
${table}
- summary: 400자 이내 요약.
- risks: 위험이 있는 쟁점마다 수준(HIGH/MEDIUM/LOW)과 제목·설명.
- recommendations: 실무 조치 최대 5개.
${preConsulting ? '- positions: 대립 견해마다 타당성 판단(타당/부당/조건부 타당/판단 유보)과 평가.\n- auditConclusion: 처리 의견(수용/반려/일부 수용/판단 유보), 이유, 후속 조치, 근거 ID. 유보된 쟁점이 결론을 좌우하면 판단 유보로 둔다.\n' : ''}출력은 JSON만.`;

/** 쟁점 결과들이 실제로 본 근거 중 인용 가능한(공식·기준일 효력) ID. 스키마 허용값을 이 범위로 좁힌다. */
function citableFrom(results, registry) {
  return [...new Set(results.flatMap(r => r.evidenceIds || []).flatMap(id => [id, ...registry.children(id).map(c => c.id)]))]
    .filter(id => { const e = registry.get(id); return e?.official && e.inForce; });
}

/** S5 호출. 실패하면 결론 표만으로 기본 요약을 만든다(결론은 이미 계산되어 있다). */
export async function synthesize({ issues, issueResults, registry, preset, provider, config, session }) {
  const preConsulting = preset === 'pre_consulting_audit';
  const table = conclusionTable(issues, issueResults);
  const positions = preConsulting ? issues.flatMap(i => (i.positions || []).map(p => `[${i.id}] ${p.label}: ${p.claim}`)).join('\n') : '';
  const compactPrefix = `[검토 기준일] ${registry.asOf}${positions ? `\n\n[대립 견해]\n${positions}` : ''}`;
  try {
    const { value } = await runStage({ stage: 's5', provider, system: REASONING_SYSTEM, prefix: compactPrefix, task: TASK({ table, preConsulting }),
      schema: schema({ issueIds: issues.map(i => i.id), preConsulting, citableIds: citableFrom(issueResults, registry) }), config: { ...config, think: false }, session });
    return { ...value, table, source: 'LLM' };
  } catch (err) {
    return { summary: `쟁점 ${issues.length}개를 검토했습니다. 쟁점별 결론은 결론 표를 따르십시오.`, risks: [], recommendations: [],
      table, source: 'FALLBACK', warning: `종합 요약 생성 실패 — 결론 표만 제공합니다: ${err.message}` };
  }
}

const redlineSchema = citableIds => ({ type: 'object', additionalProperties: false, required: ['revisedText', 'reason', 'evidenceIds'],
  properties: { revisedText: { type: 'string', maxLength: 600 }, reason: { type: 'string', maxLength: 200 },
    evidenceIds: { type: 'array', maxItems: 4, items: citableIds.length ? { type: 'string', enum: citableIds } : { type: 'string' } } } });

const REDLINE_TASK = ({ clause, issueLines }) => `[과제: 수정 조문 작성]
아래 첨부문서 조항을, 연결된 쟁점의 결론과 근거에 맞게 고친 문구로 다시 쓴다. 조항의 목적은 유지하고 위험한 부분만 고친다.
결론이 판단 유보인 쟁점은 확정된 것처럼 고치지 말고, 확인이 필요한 조건을 문구에 반영한다.
[원문 ${clause.id}] ${clause.label}
${clause.text}
[연결된 쟁점]
${issueLines}
- revisedText: 고친 조항 전문(600자 이내). reason: 고친 이유(200자 이내). evidenceIds: 근거 ID.
출력은 JSON만.`;

/**
 * 위험이 있다고 정리된 쟁점에 연결된 첨부문서 조항마다 수정 문구를 만든다.
 * 원문(originalText)은 모델이 쓰지 않고 첨부문서 조항에서 그대로 가져온다.
 */
export async function draftRedlines({ issues, issueResults, synthesis, registry, provider, config, session }) {
  const risky = new Map((synthesis.risks || []).filter(r => r.level !== 'LOW').map(r => [r.issueId, r.level]));
  const clauses = new Map();
  for (const issue of issues.filter(i => risky.has(i.id))) {
    const r = issueResults.find(x => x.issueId === issue.id);
    for (const id of r?.documentIds || []) {
      const entry = registry.get(id);
      if (!entry || entry.kind !== 'DOCUMENT') continue;
      if (!clauses.has(id)) clauses.set(id, { entry, issues: [], level: risky.get(issue.id) });
      clauses.get(id).issues.push({ issue, result: r });
      if (risky.get(issue.id) === 'HIGH') clauses.get(id).level = 'HIGH';
    }
  }
  const ordered = [...clauses.values()].sort((a, b) => (b.level === 'HIGH') - (a.level === 'HIGH'));
  const redlines = [];
  const warnings = [];
  for (const { entry, issues: linked, level } of ordered) {
    const citable = citableFrom(linked.map(l => l.result), registry);
    const issueLines = linked.map(({ issue, result }) => `- [${issue.id}] ${issue.question} → ${LEGAL_LABEL[result.conclusion?.legal] || '판단 유보'}`
      + `${result.evidenceIds?.length ? ` (근거 ${result.evidenceIds.slice(0, 6).join(', ')})` : ''}`).join('\n');
    try {
      const { value } = await runStage({ stage: `s5r:${entry.id}`, provider, system: REASONING_SYSTEM,
        prefix: `[검토 기준일] ${registry.asOf}`,
        task: REDLINE_TASK({ clause: entry, issueLines }), schema: redlineSchema(citable), config: { ...config, think: false }, session });
      redlines.push({ clauseNo: entry.label.replace(/^첨부문서\s*/, ''), originalText: entry.text, revisedText: value.revisedText,
        reason: expandMarkers(value.reason, registry), riskLevel: level, evidenceIds: value.evidenceIds,
        issueIds: linked.map(l => l.issue.id), sourceVerified: true, source: 'REASONING_PIPELINE' });
    } catch (err) {
      warnings.push(`${entry.label} 수정 문구 생성 실패: ${err.message}`);
    }
  }
  return { redlines, warnings };
}

/** [A1.2] 같은 표기를 읽을 수 있는 인용으로 바꾼다. */
export function expandMarkers(text, registry) {
  return String(text || '').replace(/\[([A-Z][A-Za-z0-9._]*)\]/g, (match, id) => {
    const entry = registry.get(id);
    return entry && !entry.kind.startsWith('DOCUMENT') && !/^F\d/.test(id) ? `(${entry.label})` : match;
  });
}

/** 조문 계열 ID를 기존 legalBasis 항목으로 바꾼다. 인용 검증기가 법령명·조·항·호를 다시 대조한다. */
function toLegalBasis(entry, registry, relevance) {
  const article = entry.parentId ? registry.get(entry.parentId) : entry;
  const unit = entry.id.slice(article.id.length).replace(/^\./, '').replace(/x$/, '');
  const [paragraph, item] = unit ? unit.split('.') : [];
  const articleNo = `${formatArticleNo(article.articleNo)}${paragraph ? ` 제${paragraph}항` : ''}${item ? ` 제${item}호` : ''}`;
  return { lawName: article.lawName, articleNo, title: article.title || '', relevance, isException: Boolean(entry.isException) };
}

/**
 * 추론 결과를 기존 검토 형식(v1)으로 조립한다. 화면·이력·내보내기·인용 검증기가 그대로 동작하도록
 * 필드 이름과 형태를 유지한다.
 */
export function renderReview({ caseIssues, issueResults, synthesis, gaps, registry, preset, redlines = [] }) {
  const { issues, facts } = caseIssues;
  const byIssue = id => issueResults.find(r => r.issueId === id);

  // 원칙과 단서는 같은 조·항으로 인용되므로 한 항목으로 합친다(단서를 썼는지는 따로 표시).
  const basis = new Map();
  for (const r of issueResults) {
    for (const a of r.assessments || []) {
      for (const id of a.evidenceIds) {
        const entry = registry.get(id);
        if (!entry?.official || !/^(ARTICLE|ORDINANCE_ARTICLE)/.test(entry.kind)) continue;
        const item = toLegalBasis(entry, registry, r.elements.find(e => e.id === a.elementId)?.text || '');
        const key = `${item.lawName}|${item.articleNo}`;
        const existing = basis.get(key);
        if (!existing) { basis.set(key, { ...item, evidenceIds: [id], includesProviso: item.isException }); continue; }
        if (!existing.evidenceIds.includes(id)) existing.evidenceIds.push(id);
        existing.includesProviso ||= item.isException;
      }
    }
  }

  const issueSections = issues.map(issue => {
    const r = byIssue(issue.id);
    const c = r?.conclusion || {};
    const issueFacts = (issue.factIds || []).map(id => facts.find(f => f.id === id)?.text).filter(Boolean);
    const rules = (r?.elements || []).map(e => {
      const assessment = (r.assessments || []).find(a => a.elementId === e.id);
      const authorities = [...new Set([...(e.sourceIds || []), ...(assessment?.evidenceIds || [])])]
        .map(id => registry.get(id)).filter(Boolean);
      const official = authorities.filter(x => x.official && x.inForce);
      return `- ${e.isException ? '(예외) ' : ''}${e.text} — ${official.length ? official.map(x => x.label).join(', ') : '공식 근거 확인 필요'}`;
    });
    const rows = (r?.assessments || []).map(a => {
      const element = r.elements.find(e => e.id === a.elementId);
      const appliedFacts = (a.factIds || []).map(id => facts.find(f => f.id === id)?.text).filter(Boolean);
      const contraryFacts = (a.contraryFactIds || []).map(id => facts.find(f => f.id === id)?.text).filter(Boolean);
      return `- ${element?.text || a.elementId}: ${STATUS_LABEL[a.status] || a.status} · ${PROOF_LABEL[a.proof] || a.proof}`
        + ` | 적용 사실: ${appliedFacts.join(' / ') || '연결된 사실 없음'}`
        + `${contraryFacts.length ? ` | 반대 사실: ${contraryFacts.join(' / ')}` : ''}`
        + ` | 포섭: ${a.analysis ? expandMarkers(a.analysis, registry) : '판단 내용 없음'}`;
    });
    return [`[쟁점 ${issue.id.slice(1)}] ${issue.question}`,
      `I · 쟁점: ${issue.question}\n관련 사실: ${issueFacts.join(' / ') || '연결된 사실 없음'}`,
      `R · 적용 규범:\n${rules.join('\n') || '- 확정된 적용 요건 없음 · 공식 법령 근거 확인 필요'}`,
      `A · 사실에 적용:\n${rows.join('\n') || '- 요건별 적용 판단 없음'}${r?.narrative ? `\n판단 보충: ${expandMarkers(r.narrative, registry)}` : ''}`,
      `C · 쟁점별 결론:\n결론: ${LEGAL_LABEL[c.legal] || '판단 유보'} (${PROOF_LABEL[c.proof] || '입증 미평가'})${c.reasons?.length ? ` — ${c.reasons.join('; ')}` : ''}`,
      c.ifResolved ? `선결 쟁점 해결 시: ${LEGAL_LABEL[c.ifResolved] || '판단 유보'}` : '',
      r?.counter?.position ? `반대 논리: ${expandMarkers(r.counter.position, registry)}${r.counter.response ? `\n응답: ${expandMarkers(r.counter.response, registry)}` : '\n응답: (반박하지 못함 — 검토 필요)'}` : '',
      r?.stageStatus === 'FAILED' ? '이 쟁점은 모델 판단에 실패해 결론을 내지 못했습니다.' : ''
    ].filter(Boolean).join('\n');
  });

  const inquiryGaps = gaps.filter(g => g.route === 'EXTERNAL_INQUIRY');
  const userGaps = gaps.filter(g => g.route === 'USER');
  const opposingViews = preset === 'pre_consulting_audit'
    ? issues.flatMap(issue => (issue.positions || []).map(p => {
      const verdict = (synthesis.positions || []).find(v => v.issueId === issue.id && v.label === p.label);
      return { label: p.label, holder: '', position: p.claim, citedBasis: p.evidenceIds.map(id => registry.get(id)?.label).filter(Boolean),
        assessment: verdict?.assessment || '', verdict: verdict?.verdict || '판단 유보', basisSource: 'REASONING_PIPELINE' };
    })) : [];
  const auditConclusion = preset === 'pre_consulting_audit' && synthesis.auditConclusion
    ? { result: synthesis.auditConclusion.result, reason: synthesis.auditConclusion.reason, guidance: synthesis.auditConclusion.guidance,
      basis: synthesis.auditConclusion.basisIds.map(id => registry.get(id)?.label).filter(Boolean).join(', ') } : null;

  const legalOpinion = issueSections.join('\n\n');
  const furtherChecks = [...userGaps.map(g => g.question), ...inquiryGaps.map(g => `[외부 전문가 질의 필요] ${g.question}`)];
  const draftOpinion = ['# 법률 검토의견서', '## 1. 검토 요지', synthesis.summary,
    '## 2. 사실관계', facts.map(f => `- ${f.text}${f.status === 'INFERRED' ? ' (원문 미확인)' : ''}`).join('\n') || '- (정리된 사실 없음)',
    '## 3. 쟁점별 검토', legalOpinion,
    '## 4. 결론 표 및 전체 쟁점 종합 분석', synthesis.table, `종합 판단: ${synthesis.summary}`,
    ...(auditConclusion ? ['## 5. 처리 의견', `${auditConclusion.result} — ${auditConclusion.reason}\n후속 조치: ${auditConclusion.guidance}`] : []),
    `## ${auditConclusion ? 6 : 5}. 추가 확인 사항`, furtherChecks.map(x => `- ${x}`).join('\n') || '- 없음',
    '---', DISCLAIMER].join('\n\n');

  return {
    isFallback: false, reviewEngine: 'LLM_STAGED',
    summary: synthesis.summary,
    coreIssues: issues.map(i => i.question),
    facts: facts.map(f => f.text).join(' / '),
    legalBasis: [...basis.values()].map(({ isException, ...item }) => item),
    legalOpinion,
    risks: (synthesis.risks || []).map(r => ({ level: r.level, title: r.title, description: r.description, issueId: r.issueId })),
    recommendations: synthesis.recommendations || [],
    redlineDiffs: redlines,
    opposingViews, auditConclusion, furtherChecks, draftOpinion, disclaimer: DISCLAIMER
  };
}
