// server/reasoning/stages/synthesis.js - S5 종합 (LLM 1회, think off) + 기존 검토 형식(v1) 조립
//
// 결론은 이미 쟁점별로 코드가 계산했다. 여기서 모델은 그 결론 표를 읽고 요약·위험·권고만 짧게 쓴다.
// 검토의견서 본문(draftOpinion)은 모델이 쓰지 않고 쟁점 서술·결론 표에서 조립한다.
// 과거 단일 호출은 같은 내용을 legalOpinion과 draftOpinion에 두 번 생성했다.
import { runStage } from '../stageRunner.js';
import { REASONING_SYSTEM } from '../prompts.js';
import { formatArticleNo } from '../evidenceRegistry.js';
import { stripFalseDocumentAbsence } from '../contractReview.js';
import { createTokenCounter } from '../../law/llmBudget.js';

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

const TASK = ({ table, preConsulting, finalReviewData, contractFindings = [] }) => `[과제: 종합]
아래는 쟁점별로 확정된 결론 표다. 결론을 바꾸거나 새로 판단하지 말고 표를 요약한다. 판단 유보인 쟁점은 유보라고 쓴다.
${table}
${contractFindings.length ? `\n[계약 문언상 위험 — 법적 무효 확정이 아님]\n${contractFindings.map(f => `- ${f.issueId} ${f.label}: ${f.facialRisk} [${f.documentSupportIds.join(', ')}]`).join('\n')}\n이 위험은 계약 문언에서 확인한 협상·운영 위험으로 요약하고 법적 효력을 단정하지 않는다.\n` : ''}
${finalReviewData ? `\n[원 검토 구조에 외부 답변을 보충한 최종 검토 데이터]\n${JSON.stringify(finalReviewData)}\n위 데이터의 요건별 판단·남은 공백을 확인해 요약·위험·권고를 작성한다. 결론 표와 충돌하는 새 결론은 만들지 않는다.\n` : ''}
- summary: 400자 이내 요약.
- risks: 위험이 있는 쟁점마다 수준(HIGH/MEDIUM/LOW)과 제목·설명.
- recommendations: 실무 조치 최대 5개.
${preConsulting ? '- positions: 대립 견해마다 타당성 판단(타당/부당/조건부 타당/판단 유보)과 평가.\n- auditConclusion: 처리 의견(수용/반려/일부 수용/판단 유보), 이유, 후속 조치, 근거 ID. 유보된 쟁점이 결론을 좌우하면 판단 유보로 둔다.\n' : ''}출력은 JSON만.`;

/** 쟁점 결과들이 실제로 본 근거 중 인용 가능한(공식·기준일 효력) ID. 스키마 허용값을 이 범위로 좁힌다. */
function citableFrom(results, registry) {
  return [...new Set(results.flatMap(r => r.appliedAuthorities || []))]
    .filter(id => { const e = registry.get(id); return e?.official && e.inForce; });
}

export function compactSynthesisIssues(issues, results, findings = [], maxChars = 900) {
  return issues.map(issue => {
    const result = results.find(r => r.issueId === issue.id);
    const linked = findings.filter(f => f.issueId === issue.id);
    const deciding = (result?.conclusion?.decidingElementIds || []).map(id => result.elements.find(e => e.id === id)?.text).filter(Boolean);
    return { issueId: issue.id, title: issue.question.slice(0, 110),
      documentFinding: linked.map(f => f.label).join(' / ').slice(0, 110),
      facialRisk: linked[0]?.facialRisk || null,
      legalConclusion: LEGAL_LABEL[result?.conclusion?.legal] || '판단 유보',
      topAuthorityIds: (result?.appliedAuthorities || []).slice(0, 5),
      decidingElementIds: (result?.conclusion?.decidingElementIds || []).slice(0, 3),
      decidingElements: deciding.slice(0, 3).map(x => x.slice(0, 110)),
      additionalFacts: [...new Set(linked.flatMap(f => f.additionalFactsRequired || []))].slice(0, 2),
      redlineRequired: linked.some(f => f.facialRisk === 'HIGH' || f.facialRisk === 'MEDIUM') };
  }).map(item => JSON.stringify(item).slice(0, maxChars)).join('\n');
}

export function contractExecutiveSummary(issues, results, findings, modelSummary = '') {
  const value = String(modelSummary || '').trim();
  const wrongCount = [...value.matchAll(/(\d+)\s*(?:가지|개)\s*(?:주요\s*)?(?:계약\s*)?(?:조항|쟁점)/g)]
    .some(match => Number(match[1]) !== issues.length);
  if (value && !wrongCount && !/\bI\d+\b/.test(value)) return value;
  const labels = [...new Set(findings.filter(f => f.facialRisk !== 'NONE').map(f => f.label))].slice(0, 5);
  const conditional = results.filter(r => r.conclusion?.legal === 'CONDITIONAL' || r.stageStatus !== 'OK').length;
  return `계약서의 ${issues.length}개 쟁점을 검토했습니다. ${labels.length ? `${labels.join(', ')} 등의 계약 문언상 위험을 확인했습니다. ` : ''}`
    + `${conditional}개 쟁점은 법적 적용 전제 또는 추가 사실이 필요하여 판단을 유보했습니다. 계약 성질, 발주기관 유형 및 실제 이행 방식을 확인한 뒤 수정안을 확정하십시오.`;
}

/** S5 호출. 실패하면 결론 표만으로 기본 요약을 만든다(결론은 이미 계산되어 있다). */
export async function synthesize({ issues, issueResults, registry, preset, provider, config, session, finalReviewData = null,
  contractFindings = [] }) {
  const preConsulting = preset === 'pre_consulting_audit';
  const table = conclusionTable(issues, issueResults);
  const compactTable = compactSynthesisIssues(issues, issueResults, contractFindings);
  const positions = preConsulting ? issues.flatMap(i => (i.positions || []).map(p => `[${i.id}] ${p.label}: ${p.claim}`)).join('\n') : '';
  const compactPrefix = `[검토 기준일] ${registry.asOf}${positions ? `\n\n[대립 견해]\n${positions}` : ''}`;
  try {
    const counter = createTokenCounter(provider, { model: config.model, apiKey: config.apiKey });
    const makeTask = (rows, data = null) => TASK({ table: rows, preConsulting, finalReviewData: data, contractFindings: [] });
    let task = makeTask(compactTable, finalReviewData ? { remainingGaps: (finalReviewData.remainingGaps || []).slice(0, 12) } : null);
    const limit = config.budget.inputLimit;
    let measured = await counter.measure(REASONING_SYSTEM, `${compactPrefix}\n\n${task}`);
    if (measured.tokens > limit * 0.8) {
      task = makeTask(compactSynthesisIssues(issues, issueResults, contractFindings, 450));
      measured = await counter.measure(REASONING_SYSTEM, `${compactPrefix}\n\n${task}`);
    }
    if (measured.tokens > limit * 0.9) {
      const middle = Math.ceil(issues.length / 2);
      if (issues.length < 2) throw new Error('종합 요약의 입력 예산이 쟁점 1개에도 부족합니다.');
      const halves = [issues.slice(0, middle), issues.slice(middle)];
      const summaries = [];
      for (const group of halves) {
        const groupTask = makeTask(compactSynthesisIssues(group, issueResults, contractFindings, 450));
        const count = await counter.measure(REASONING_SYSTEM, `${compactPrefix}\n\n${groupTask}`);
        if (count.tokens > limit * 0.9) throw new Error('종합 요약의 분할 입력도 예산을 초과합니다.');
        const partial = await runStage({ stage: 's5:partial', provider, system: REASONING_SYSTEM, prefix: compactPrefix,
          task: groupTask, schema: schema({ issueIds: group.map(i => i.id), preConsulting: false, citableIds: [] }),
          config: { ...config, think: false }, session });
        summaries.push(partial.value.summary);
      }
      task = makeTask(summaries.map((summary, index) => `묶음 ${index + 1}: ${summary}`).join('\n'));
    }
    const finalCount = await counter.measure(REASONING_SYSTEM, `${compactPrefix}\n\n${task}`);
    if (finalCount.tokens > limit * 0.9) throw new Error('종합 요약의 최종 입력이 안전 예산을 초과합니다.');
    const { value } = await runStage({ stage: 's5', provider, system: REASONING_SYSTEM, prefix: compactPrefix,
      task, schema: schema({ issueIds: issues.map(i => i.id), preConsulting, citableIds: citableFrom(issueResults, registry) }),
      config: { ...config, think: false }, session });
    const riskMap = new Map((value.risks || []).map(r => [r.issueId, r]));
    for (const finding of contractFindings) riskMap.set(finding.issueId, {
      issueId: finding.issueId, level: finding.riskAxes?.finalLevel || finding.facialRisk, title: finding.label,
      description: `${finding.documentSupportIds.join(', ')} 계약 문언에서 확인된 위험. 법적 효력은 별도 검토가 필요합니다.` });
    return { ...value, summary: preset === 'contract_risk'
      ? contractExecutiveSummary(issues, issueResults, contractFindings, value.summary) : value.summary,
    risks: [...riskMap.values()], table, source: 'LLM' };
  } catch (err) {
    return { summary: `쟁점 ${issues.length}개를 검토했습니다. 쟁점별 결론은 결론 표를 따르십시오.`,
      risks: contractFindings.map(f => ({ issueId: f.issueId, level: f.riskAxes?.finalLevel || f.facialRisk, title: f.label,
        description: `${f.documentSupportIds.join(', ')} 계약 문언에서 확인된 위험. 법적 효력은 별도 검토가 필요합니다.` })), recommendations: [],
      table, source: 'FALLBACK', warning: `종합 요약 생성 실패 — 결론 표만 제공합니다: ${err.message}` };
  }
}

const redlineSchema = citableIds => ({ type: 'object', additionalProperties: false, required: ['revisedText', 'reason', 'evidenceIds'],
  properties: { revisedText: { type: 'string', maxLength: 600 }, reason: { type: 'string', maxLength: 200 },
    evidenceIds: { type: 'array', maxItems: 4, items: citableIds.length ? { type: 'string', enum: citableIds } : { type: 'string' } } } });

const REDLINE_GUIDANCE = {
  TERMINATION: '귀책해지는 위반통지·합리적 시정기간·미시정 시 해지로, 사업계획 변경 등 편의해지는 사전 서면통지·기성대가·확정 투입비용 정산·인수인계로 분리한다. 편의해지에 시정기간을 두지 않는다.',
  LIABILITY: '양 당사자 책임을 각 귀책비율로 배분하고, 고의·중과실, 제3자 청구, 간접·특별손해 및 총 책임한도를 구분한다.',
  INTELLECTUAL_PROPERTY: '기존 지식재산은 원 권리자에게 존속시킨다. 신규 산출물의 귀속·이용권, 제3자·오픈소스 라이선스, 발주자 이용 범위, 일반화 기술 재사용을 조문에 직접 정한다.',
  DISPUTE_WAIVER: '관할법원과 협의·조정·중재의 순서, 법정 이의신청 및 권리보전 절차를 구분한다. 법정 절차의 일괄 포기를 명시하지 않는다.'
};
const CONTRACT_REDLINE_FALLBACK = {
  TERMINATION: '당사자 일방의 귀책사유로 계약을 해지하려는 경우 상대방에게 위반 내용을 서면 통지하고 합리적인 시정기간을 부여한 후 미시정 시 해지할 수 있다. 발주자의 사업계획 변경 등 편의해지는 사전 서면통지로 하며, 종료일까지의 기성대가와 이미 확정적으로 투입된 합리적 비용을 정산하고 당사자는 인수인계에 협력한다.',
  LIABILITY: '각 당사자는 자신의 귀책비율에 따른 직접손해를 배상한다. 통상적인 책임의 총액은 상호 합의한 한도로 하되 고의·중과실과 제3자 청구의 처리 및 한도 적용 여부는 별도로 정한다. 간접·특별손해는 그 발생 가능성과 범위를 합의한 경우에 한해 처리한다.',
  INTELLECTUAL_PROPERTY: '계약 전부터 보유한 기존 지식재산은 원 권리자에게 존속한다. 본 사업에서 새로 만든 산출물의 권리 귀속과 발주자의 업무 목적 이용권은 별표에 정한다. 제3자 및 오픈소스 구성요소는 원 라이선스 조건을 따른다. 수급인의 일반화 기술과 노하우는 비밀정보를 침해하지 않는 범위에서 재사용할 수 있다.',
  DISPUTE_WAIVER: '분쟁이 발생하면 당사자는 우선 성실히 협의한다. 협의가 성립하지 않으면 적용 가능한 조정 또는 중재 절차를 이용할 수 있으며, 법령상 이의신청과 권리보전 절차는 제한하지 않는다. 소송의 관할은 민사소송법상 유효한 서면 합의에 따라 정한다.'
};
export function ensureOperationalRedline(text, kinds = []) {
  const value = String(text || '');
  const checks = {
    TERMINATION: /시정기간/.test(value) && /기성/.test(value) && /서면통지/.test(value)
      && !/사업계획 변경.{0,35}시정기간|시정기간.{0,35}사업계획 변경/.test(value),
    LIABILITY: /귀책/.test(value) && /한도/.test(value) && /고의/.test(value) && /간접/.test(value),
    INTELLECTUAL_PROPERTY: /기존/.test(value) && /신규|새로/.test(value) && /제3자/.test(value) && /재사용/.test(value),
    DISPUTE_WAIVER: /관할/.test(value) && /협의/.test(value) && /조정/.test(value) && /권리보전/.test(value)
  };
  const critical = kinds.find(kind => kind in CONTRACT_REDLINE_FALLBACK && !checks[kind]);
  return critical ? { text: CONTRACT_REDLINE_FALLBACK[critical], substituted: true } : { text: value, substituted: false };
}
const REDLINE_TASK = ({ clause, issueLines, contractMode = false, kinds = [] }) => `[과제: 수정 조문 작성]
아래 첨부문서 조항을, 연결된 쟁점의 결론과 근거에 맞게 고친 문구로 다시 쓴다. 조항의 목적은 유지하고 위험한 부분만 고친다.
${contractMode ? '계약 문언의 위험을 완화하는 협상용 문안이다. 조항이 무효라고 단정하지 않는다.' : '결론이 판단 유보인 쟁점은 확정된 것처럼 고치지 말고, 확인이 필요한 조건을 문구에 반영한다.'}
${[...new Set(kinds)].map(kind => REDLINE_GUIDANCE[kind]).filter(Boolean).join('\n')}
${/별표|별지/.test(clause.label) ? '원문이 표이면 열과 행 구조를 유지한 표 형식으로 수정한다.' : ''}
[원문 ${clause.id}] ${clause.label}
${clause.text}
[연결된 쟁점]
${issueLines}
- revisedText: 고친 조항 전문(600자 이내). reason: 고친 이유(200자 이내). evidenceIds: 근거 ID.
출력은 JSON만.`;

export function normalizeTableRedline(value, original) {
  const columnCount = String(original || '').split('\n').find(line => line.trim().startsWith('|'))?.split('|').length - 2;
  if (!columnCount) return null;
  const lines = String(value || '').split('\n').map(line => {
    const trimmed = line.trim();
    return trimmed.startsWith('|') && !trimmed.endsWith('|') ? `${line.trimEnd()} |` : line;
  });
  const rows = lines.filter(line => line.trim().startsWith('|'));
  if (!rows.length || rows.some(line => line.split('|').length - 2 !== columnCount)) return null;
  return lines.join('\n');
}

/**
 * 위험이 있다고 정리된 쟁점에 연결된 첨부문서 조항마다 수정 문구를 만든다.
 * 원문(originalText)은 모델이 쓰지 않고 첨부문서 조항에서 그대로 가져온다.
 */
export async function draftRedlines({ issues, issueResults, synthesis, registry, provider, config, session, contractFindings = [] }) {
  const risky = new Map((synthesis.risks || []).filter(r => r.level !== 'LOW').map(r => [r.issueId, r.level]));
  for (const finding of contractFindings.filter(f => ['HIGH', 'MEDIUM'].includes(f.facialRisk)))
    risky.set(finding.issueId, finding.riskAxes?.finalLevel || finding.facialRisk);
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
      + `${result.appliedAuthorities?.length ? ` (근거 ${result.appliedAuthorities.slice(0, 5).join(', ')})` : ''}`).join('\n');
    try {
      const { value } = await runStage({ stage: `s5r:${entry.id}`, provider, system: REASONING_SYSTEM,
        prefix: `[검토 기준일] ${registry.asOf}`,
        task: REDLINE_TASK({ clause: entry, issueLines, contractMode: contractFindings.length > 0,
          kinds: linked.flatMap(({ issue }) => issue.contractKinds || []) }),
        schema: redlineSchema(citable), config: { ...config, think: false }, session });
      if (!String(value.revisedText || '').trim()) { warnings.push(`${entry.label} 수정 문구가 비어 있습니다.`); continue; }
      let revisedText = /별표|별지/.test(entry.label)
        ? normalizeTableRedline(value.revisedText, entry.text) : value.revisedText;
      if (!revisedText) { warnings.push(`${entry.label} 수정 문구의 표 열 구조가 원문과 다릅니다.`); continue; }
      const kinds = linked.flatMap(({ issue }) => issue.contractKinds || []);
      if (contractFindings.length && !/별표|별지/.test(entry.label)) {
        const checked = ensureOperationalRedline(revisedText, kinds);
        revisedText = checked.text;
        if (checked.substituted) warnings.push(`${entry.label} 수정 문구가 핵심 정산·책임·권리·절차를 빠뜨려 기본 보완 문안으로 대체했습니다.`);
      }
      const verifiedIds = (value.evidenceIds || []).filter(id => citable.includes(id));
      if (verifiedIds.length !== (value.evidenceIds || []).length) warnings.push(`${entry.label} 수정 이유에서 미확인 법적 근거 ID를 제거했습니다.`);
      const reason = String(value.reason || '').replace(/\[([A-Z][A-Za-z0-9._]*)\]/g, (match, id) => citable.includes(id) ? match : '');
      if (reason !== value.reason) warnings.push(`${entry.label} 수정 이유에서 확인되지 않은 근거 표기를 제거했습니다.`);
      redlines.push({ clauseNo: entry.label.replace(/^첨부문서\s*/, ''), originalText: entry.text, revisedText,
        reason: `${contractFindings.length ? '법적 효력의 확정 판단이 아닌 위험 완화 권고: ' : ''}${expandMarkers(reason, registry)}`,
        riskLevel: level, evidenceIds: verifiedIds,
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
export function renderReview({ caseIssues, issueResults, synthesis, gaps, registry, preset, redlines = [],
  contractFindings = [], missingClauseAdditions = [], missingClauseAudit = [], contractRegime = null }) {
  const { issues, facts } = caseIssues;
  const byIssue = id => issueResults.find(r => r.issueId === id);
  const clean = value => preset === 'contract_risk' ? stripFalseDocumentAbsence(value, registry).text : value;
  const summary = clean(synthesis.summary);

  // 원칙과 단서는 같은 조·항으로 인용되므로 한 항목으로 합친다(단서를 썼는지는 따로 표시).
  const basis = new Map();
  for (const r of issueResults) {
    for (const a of r.assessments || []) {
      for (const id of a.authorityEvidenceIds || []) {
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
    if (preset === 'contract_risk') {
      const linked = contractFindings.filter(f => f.issueId === issue.id);
      const sources = [...new Set([...linked.flatMap(f => f.documentSupportIds), ...(issue.documentIds || [])])]
        .map(id => registry.get(id)).filter(Boolean);
      const redline = redlines.find(d => d.issueIds?.includes(issue.id));
      return [`[쟁점 ${issue.id.slice(1)}] ${issue.question}`,
        `[조항]\n${sources.map(e => `[${e.id}] ${e.label}: ${e.text.slice(0, 220)}${e.text.length > 220 ? '…' : ''}`).join('\n') || '원문 연결 미완료'}`,
        `[문언상 위험]\n${linked.map(f => `${f.facialRisk} · ${f.label}`).join('\n') || '별도 문언 위험 분류 없음'}`,
        `[법률 검토]\n${(r?.rulePropositions || []).filter(p => p.verified)
          .map(p => `- ${p.text} — ${p.authorityIds.map(id => registry.get(id)?.label).filter(Boolean).join(', ')}`)
          .join('\n') || '- 적용 규범의 공식 근거 확인 필요'}`,
        ...linked.flatMap(f => [
          ...(f.legalPaths?.length ? [`[계약 성질에 따른 적용 경로]\n${f.legalPaths.map(p => `- ${p.condition}: ${p.lawName} 제${p.articleNo}조`).join('\n')}`] : []),
          ...(f.penaltyClassification ? [`[위약금 성격]\n${f.penaltyClassification === 'UNCLEAR' ? '손해배상액 예정인지 진정한 위약벌인지 추가 판단 필요' : '손해배상액 예정 가능성 · 실제 약정 성격 확인 필요'}`] : []),
          ...(f.actualDispatchStatus ? [`[실제 근로자파견 성립 여부]\n${f.actualDispatchStatus}`] : [])]),
        `[현재 판단]\n${linked.length ? '조항 문언의 존재는 확인됨. ' : ''}법적 효력 ${linked[0]?.legalValidity === 'NOT_REVIEWED' ? '공식 근거 부족 또는 검토 미완료' : '적용 전제와 추가 사실에 따라 달라짐'}${c.reasons?.length ? ` · ${c.reasons.join('; ')}` : ''}`,
        `[판단을 바꿀 추가 사실]\n${[...new Set(linked.flatMap(f => f.additionalFactsRequired))].map(x => `- ${x}`).join('\n') || '- 없음'}`,
        `[권고 수정안]\n${redline?.revisedText || '수정 문안 검토 필요'}`].join('\n');
    }
    const issueFacts = (issue.factIds || []).map(id => facts.find(f => f.id === id)?.text).filter(Boolean);
    const rules = (r?.elements || []).map(e => {
      const assessment = (r.assessments || []).find(a => a.elementId === e.id);
      const authorities = [...new Set(assessment?.authorityEvidenceIds || [])]
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

  const legalOpinion = clean(issueSections.join('\n\n'));
  const furtherChecks = [...new Set([...userGaps.map(g => g.question),
    ...inquiryGaps.map(g => `[외부 전문가 질의 필요] ${g.question}`),
    ...contractFindings.flatMap(f => f.additionalFactsRequired || []),
    ...(caseIssues.unreviewedCandidates || []).map(c => `[원문 연결 필요] ${c.question}`)].map(clean).filter(Boolean))];
  const materialChecks = [...new Set(contractFindings.flatMap(f => f.additionalFactsRequired || []))]
    .sort((a, b) => {
      const priority = value => /발주기관의 법적 유형/.test(value) ? 0 : /도급·위임|혼합 성격/.test(value) ? 1
        : /실제 업무방법|근무시간|휴가/.test(value) ? 2 : /개별교섭|표준약관/.test(value) ? 3 : 4;
      return priority(a) - priority(b);
    }).slice(0, 10);
  const missingSection = missingClauseAdditions.length
    ? ['## 누락 조항 검토', ...missingClauseAdditions.map(m => `### ${m.title}\n${m.reason}\n구분: ${m.classification}\n권고 추가 문안: ${m.suggestedText}`)] : [];
  const regimeSection = contractRegime ? ['## 적용 법체계 선결 사항',
    `계약 성격: ${contractRegime.contractNature.candidates.join(' / ')} 중 추가 판단 필요`,
    `약관성: ${contractRegime.termsRegulation.needsFacts.join(' / ')} 확인 필요`,
    `발주기관 유형: ${contractRegime.publicProcurement.institutionType} · ${contractRegime.publicProcurement.needsFacts.join(' / ')}`] : [];
  const draftOpinion = ['# 법률 검토의견서', '## 1. 검토 요지', summary,
    '## 2. 사실관계', facts.map(f => `- ${f.text}${f.status === 'INFERRED' ? ' (원문 미확인)' : ''}`).join('\n') || '- (정리된 사실 없음)',
    ...regimeSection,
    '## 3. 쟁점별 검토', legalOpinion,
    '## 4. 결론 표 및 전체 쟁점 종합 분석', clean(synthesis.table), `종합 판단: ${summary}`,
    ...(auditConclusion ? ['## 5. 처리 의견', `${auditConclusion.result} — ${auditConclusion.reason}\n후속 조치: ${auditConclusion.guidance}`] : []),
    `## ${auditConclusion ? 6 : 5}. 추가 확인 사항`, furtherChecks.map(x => `- ${x}`).join('\n') || '- 없음',
    ...missingSection,
    '---', DISCLAIMER].join('\n\n');
  const contractDraft = preset === 'contract_risk' ? [
    '# 계약서 법률검토의견서', '## 1. 검토 요약', summary,
    '## 2. 핵심 위험', ...(synthesis.risks || []).slice(0, 5).map(r => `- ${r.title}: ${r.description}`),
    '## 3. 전체 쟁점', clean(synthesis.table),
    '## 4. 조항별 검토', legalOpinion,
    '## 5. 권고 수정안', ...redlines.map(d => `${d.clauseNo}: ${d.revisedText}`),
    '## 6. 추가 확인사항', ...(materialChecks.length ? materialChecks : ['없음']),
    ...missingSection, DISCLAIMER
  ].join('\n\n') : null;

  return {
    isFallback: false, reviewEngine: 'LLM_STAGED',
    summary,
    coreIssues: issues.map(i => clean(i.question)),
    facts: clean(facts.map(f => f.text).join(' / ')),
    legalBasis: [...basis.values()].map(({ isException, ...item }) => item),
    legalOpinion,
    risks: (synthesis.risks || []).map(r => ({ level: r.level, title: clean(r.title), description: clean(r.description), issueId: r.issueId })),
    recommendations: (synthesis.recommendations || []).map(clean).filter(Boolean),
    redlineDiffs: preset === 'contract_risk' ? redlines.map(d => ({ ...d, reason: clean(d.reason) })) : redlines,
    contractFindings, missingClauseAdditions, missingClauseAudit, contractRegime,
    opposingViews, auditConclusion, furtherChecks, draftOpinion: clean(contractDraft || draftOpinion), disclaimer: DISCLAIMER
  };
}
