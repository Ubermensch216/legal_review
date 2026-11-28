// server/skills/skillChecks.js - 스킬 문서 점검: 코드 탐색 → 숫자 판정 → 닫힌 질문 → 쟁점 보충·요건 판단 주입
//
// 측정(사례 01, 기본분석): 로컬 소형 모델에게 "문서가 규정을 지키는가 + 원문 인용"을 물으면 원문 인용으로 확인된
// 위반 지적이 0건이었다. 열린 판단과 인용 생성이 모두 어렵기 때문이다. 스킬 점검은 순서를 바꾼다.
//   1) 코드가 첨부문서에서 점검 대상 문장을 먼저 찾는다(인용은 코드가 원문에서 잘라 내므로 항상 원문과 같다).
//   2) 숫자로 판정할 수 있으면(1주 68시간 > 52) 모델을 부르지 않는다.
//   3) 그렇지 않으면 조문 원문과 그 문장만 주고 YES / NO / UNCLEAR 하나만 묻는다(출력 수 토큰).
// 점검 결과는 결론 상한(ceiling)을 넘지 못한다. 위법 확정을 내리지 않고, 판례 판단이 필요한 점검은 '검토 필요'까지만 간다.
// 근거 검증(S6)은 그대로 거친다.
import { runStage, StageError } from '../reasoning/stageRunner.js';
import { REASONING_SYSTEM } from '../reasoning/prompts.js';
import { normalizedLawName } from '../law/evidence.js';
import { normalizeArticleNo } from '../law/lawArticleRef.js';
import { bigramSimilarity } from '../reasoning/stages/caseIssues.js';
import { resolveDocumentVerdict } from '../reasoning/verify/conclusion.js';
import { skillsFor } from './skillRouter.js';

export const CLOSED_ANSWERS = Object.freeze(['YES', 'NO', 'UNCLEAR']);
const QUOTE_MAX = 120;
// 읽기 질문의 출력. evidence(문장 속 표현을 그대로)를 먼저 쓰게 하면 소형 모델의 답이 안정된다.
const closedSchema = { type: 'object', additionalProperties: false, required: ['evidence', 'answer'],
  properties: { evidence: { type: 'string', maxLength: 80 }, answer: { type: 'string', enum: CLOSED_ANSWERS } } };

// ── 문장 탐색 ────────────────────────────────────────────────

const FULLWIDTH = /[０-９]/g;
const toAscii = text => String(text || '').replace(FULLWIDTH, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));

/** 조항 본문을 문장으로 나눈다. 원문 오프셋을 함께 돌려준다(인용이 원문의 부분 문자열이어야 한다). */
export function sentences(text) {
  const value = String(text || '');
  const result = [];
  const re = /[^.。\n]+(?:[.。]|\n|$)/g;
  let m;
  while ((m = re.exec(value))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body.length >= 6) result.push({ text: body, start: m.index + lead });
    if (m[0].length === 0) re.lastIndex++;
  }
  return result;
}

/** 표 행 단위. 개인정보 처리현황표처럼 한 행이 한 처리 건인 문서에 쓴다(마크다운 표 행, CSV·탭 구분 행). */
export function tableRows(text) {
  const value = String(text || '');
  const rows = [];
  let cursor = 0;
  for (const line of value.split(/\r?\n/)) {
    const start = value.indexOf(line, cursor);
    cursor = start + line.length;
    const body = line.trim();
    if (body.length < 6 || /^\|[\s:|-]+\|$/.test(body) || /^[,\s]+$/.test(body)) continue;
    if (/^\|.*\|$/.test(body) || /[,\t]/.test(body)) rows.push({ text: body, start: start + line.indexOf(body) });
  }
  return rows;
}

/** 점검의 문장 조건(all·any·none)이 맞는가. */
export function sentenceMatches(check, text) {
  const value = toAscii(text);
  const c = check.compiled;
  if (!c.all.every(re => re.test(value))) return false;
  if (c.any.length && !c.any.some(re => re.test(value))) return false;
  if (c.none.some(re => re.test(value))) return false;
  return true;
}

/** 숫자 판정. 하나라도 위반 비교가 성립하면 그 값과 규칙을 돌려준다. */
export function numericViolation(check, text) {
  const value = toAscii(text);
  for (const rule of check.compiled.numeric) {
    const re = new RegExp(rule.re.source, `${rule.re.flags.replace('g', '')}g`);
    for (const m of value.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && rule.cmp.test(n)) {
        return { value: n, rule: rule.violatesIf, unit: rule.unit || '', note: rule.note || '', matched: m[0] };
      }
    }
  }
  return null;
}

/** 숫자 규칙에 걸리는 숫자가 있었는데 모두 기준 안인가(numericDecides 점검은 이때 해소로 본다). */
export function numericCleared(check, text) {
  if (!check.numericDecides || !check.compiled.numeric.length) return false;
  const value = toAscii(text);
  let seen = false;
  for (const rule of check.compiled.numeric) {
    for (const m of value.matchAll(new RegExp(rule.re.source, `${rule.re.flags.replace('g', '')}g`))) {
      const n = Number(m[1]);
      if (!Number.isFinite(n)) continue;
      if (rule.cmp.test(n)) return false;
      seen = true;
    }
  }
  return seen;
}

/** 점검이 이 문장(행)에 걸리는가: 문장 조건이 맞고, 숫자로 결정되는 점검이면 숫자가 기준을 넘어야 한다. */
export const checkApplies = (check, text) => sentenceMatches(check, text) && !numericCleared(check, text);

/** 긴 문장은 첫 적중 지점 둘레만 원문 그대로 잘라 인용한다. */
function quoteFrom(check, raw) {
  // 표 행에서 잘린 문장은 앞뒤 구분선(|)을 걷어 낸다. 남는 문자열도 원문의 부분 문자열이다.
  const sentence = String(raw).replace(/^[|\s]+|[|\s]+$/g, '');
  if (sentence.length <= QUOTE_MAX) return sentence;
  const value = toAscii(sentence);
  const anchor = [...check.compiled.any, ...check.compiled.all].map(re => value.search(re)).filter(i => i >= 0);
  const at = anchor.length ? Math.min(...anchor) : 0;
  const start = Math.max(0, Math.min(at - 30, sentence.length - QUOTE_MAX));
  return sentence.slice(start, start + QUOTE_MAX).trim();
}

// ── 조문 찾기 ────────────────────────────────────────────────

/** '제1항' → ['1'], '제1항 제2호' → ['1', '2'], '제1항 단서' → ['1x'] (등록부 단위 ID 체계: A3.1, A3.1.2, A3.1x) */
const unitPath = unit => {
  const m = /^제?\s*(\d+)\s*항(?:\s*제?\s*(\d+)\s*호)?(\s*단서)?$/.exec(String(unit || '').trim());
  if (!m) return null;
  const parts = [m[1], m[2]].filter(Boolean);
  if (m[3]) parts[parts.length - 1] += 'x';
  return parts;
};

/** 스킬의 조문 지정을 등록부 ID로 바꾼다. 항을 지정했으면 그 단위 ID, 없으면 조문 ID. */
export function resolveArticle(registry, ref) {
  const wantedLaw = normalizedLawName(ref.lawName);
  const wantedNo = normalizeArticleNo(ref.articleNo);
  const article = registry.list(e => /^(ARTICLE|ORDINANCE_ARTICLE)$/.test(e.kind) && !e.parentId
    && normalizedLawName(e.lawName) === wantedLaw && normalizeArticleNo(e.articleNo) === wantedNo)[0];
  if (!article) return null;
  const parts = unitPath(ref.unit);
  const unit = parts ? registry.get(`${article.id}.${parts.join('.')}`) : null;
  return { articleId: article.id, unitId: unit?.id || null, targetId: unit?.id || article.id, entry: unit || article, article };
}

// ── 점검 실행 ────────────────────────────────────────────────

/**
 * 첨부문서 조항에서 점검 대상 문장을 찾는다. LLM을 부르지 않는다.
 * @returns {object[]} 적중 목록. 같은 점검이 여러 조항에 걸리면 조항마다 하나씩이다.
 */
export function findCheckHits(skills, registry, { disabledChecks = new Set() } = {}) {
  const documents = registry.list(e => e.kind === 'DOCUMENT');
  const hits = [];
  for (const skill of skillsFor(skills, 's4-checks')) {
    for (const check of skill.checks) {
      if (disabledChecks.has(`${skill.id}:${check.id}`)) continue;
      for (const doc of documents) {
        const units = check.scope === 'ROW' ? tableRows(doc.text) : sentences(doc.text);
        const candidates = units.filter(u => checkApplies(check, u.text));
        // 제목 줄("■ 쟁점 2 — 청문 절차의 생략")보다 내용 문장을 인용한다.
        const unit = candidates.find(u => u.text.length >= 20) || candidates[0];
        if (!unit) continue;
        hits.push({ skillId: skill.id, checkId: check.id, issueTemplateId: check.issueId, label: check.label,
          documentId: doc.id, documentLabel: doc.label, quote: quoteFrom(check, unit.text), sentence: unit.text,
          numeric: numericViolation(check, unit.text), ceiling: check.ceiling, route: check.route,
          article: check.article, factQuestions: check.factQuestions || [], legalQuestion: check.legalQuestion || '' });
        if (check.scope !== 'ROW') continue;
        // 행 단위 점검은 같은 문서의 다른 행도 따로 본다(행마다 독립 처리 건이다).
        for (const row of candidates.filter(u => u !== unit)) {
          hits.push({ ...hits[hits.length - 1], quote: quoteFrom(check, row.text), sentence: row.text, numeric: numericViolation(check, row.text) });
        }
      }
    }
  }
  return hits;
}

// 조문 원문은 싣지 않는다. 실측(gemma4:e2b, 2026-11-28): 조문과 함께 "규정을 어기는가"류로 물으면 6문항 모두 NO(3/6),
// 조문 없이 "문장에 그런 내용이 적혀 있는가"만 묻고 근거 표현을 먼저 옮기게 하면 6/6이었다.
// 그 내용이 조문 요건과 어긋난다는 판단은 스킬 작성자(점검 정의)가 한 것이고, 모델은 문장을 읽기만 한다.
const CLOSED_TASK = ({ quote, question, guidance }) => `[과제: 문서 문장 읽기]
[문서 문장] ${quote}
${guidance ? `${guidance}\n` : ''}질문: ${question}
evidence에 판단의 근거가 된 문장 속 표현을 그대로 옮긴다. 그런 내용이 적혀 있으면 YES, 적혀 있지 않으면 NO, 문장만으로 알 수 없으면 UNCLEAR.
출력 JSON 형식: {"evidence":"","answer":"YES"}`;

const compact = text => String(text || '').replace(/\s+/g, '');
/** YES인데 근거 표현이 문장에 없으면(지어낸 근거) 확정하지 않는다. */
export function groundedAnswer(value, quote) {
  if (value.answer !== 'YES') return value.answer;
  const evidence = compact(value.evidence);
  return evidence.length >= 2 && compact(quote).includes(evidence) ? 'YES' : 'UNCLEAR';
}

/**
 * 적중마다 판정한다. 조문이 등록부에 없으면 판정하지 않는다(공식 근거 없이 위반 소지를 올리지 않는다).
 * @param {object} args
 * @param {boolean} args.askModel false면 닫힌 질문을 부르지 않는다(auto 방식의 shadow 진단).
 * @returns {Promise<{ findings: object[], calls: number, warnings: string[] }>}
 */
export async function evaluateCheckHits({ hits, skills, registry, provider, config, session, askModel = true }) {
  const findings = [];
  const warnings = [];
  let calls = 0;
  const checkOf = hit => skills.find(s => s.id === hit.skillId)?.checks.find(c => c.id === hit.checkId);
  for (const hit of hits) {
    const check = checkOf(hit);
    const skill = skills.find(s => s.id === hit.skillId);
    const resolved = resolveArticle(registry, hit.article);
    const base = { ...hit, articleId: resolved?.articleId || null, evidenceId: resolved?.targetId || null,
      articleLabel: resolved?.entry?.label || `${hit.article.lawName} ${hit.article.articleNo}` };
    if (!resolved || !resolved.article.official || !resolved.article.inForce) {
      findings.push({ ...base, answer: null, outcome: 'NO_AUTHORITY', derivedBy: 'NONE' });
      continue;
    }
    if (hit.numeric) {
      findings.push({ ...base, answer: 'YES', outcome: outcomeOf('YES', hit.ceiling), derivedBy: 'SKILL_RULE' });
      continue;
    }
    if (!check.closedQuestion) {
      // 닫힌 질문이 없는 점검은 사실 확인 항목으로만 남긴다(검토 필요 상한).
      findings.push({ ...base, answer: 'UNCLEAR', outcome: 'REVIEW_POINT', derivedBy: 'SKILL_RULE' });
      continue;
    }
    if (!askModel) { findings.push({ ...base, answer: null, outcome: 'NOT_ASKED', derivedBy: 'NONE' }); continue; }
    try {
      calls++;
      const { value } = await runStage({ stage: `skill:${hit.checkId}`, provider, system: REASONING_SYSTEM,
        prefix: `[검토 기준일] ${registry.asOf}`,
        task: CLOSED_TASK({ quote: hit.quote, question: check.closedQuestion, guidance: skill?.s4Guidance }),
        schema: closedSchema, config: { ...config, think: false }, session });
      const answer = groundedAnswer(value, hit.quote);
      findings.push({ ...base, answer, modelEvidence: String(value.evidence || ''), ...(answer !== value.answer ? { answerDowngraded: value.answer } : {}),
        outcome: outcomeOf(answer, hit.ceiling), derivedBy: 'SKILL_CLOSED_QUESTION' });
    } catch (err) {
      if (!(err instanceof StageError)) throw err;
      warnings.push(`스킬 점검 ${hit.checkId}(${hit.documentId}) 판정 실패: ${err.message}`);
      findings.push({ ...base, answer: null, outcome: 'FAILED', derivedBy: 'NONE' });
    }
  }
  return { findings, calls, warnings };
}

/** 답과 상한에서 결과를 정한다. 상한이 '검토 필요'면 YES여도 위반 소지로 올리지 않는다. */
export function outcomeOf(answer, ceiling) {
  if (answer === 'YES') return ceiling === 'VIOLATION_RISK' ? 'VIOLATION_RISK' : 'REVIEW_POINT';
  if (answer === 'UNCLEAR') return 'REVIEW_POINT';
  if (answer === 'NO') return 'CLEARED';
  return 'NOT_EVALUATED';
}

/** 결과에 반영할 판정만. 해소(NO)·미평가·근거 없음은 반영하지 않는다. */
export const actionableFindings = findings => findings.filter(f => ['VIOLATION_RISK', 'REVIEW_POINT'].includes(f.outcome));

// ── 쟁점 보충 ────────────────────────────────────────────────

const issueArticleKeys = (issue, registry) => new Set(issue.evidenceIds.map(id => registry.get(id)).filter(Boolean)
  .map(e => (e.parentId ? registry.get(e.parentId) : e)).filter(Boolean)
  .filter(e => /^(ARTICLE|ORDINANCE_ARTICLE)$/.test(e.kind))
  .map(e => `${normalizedLawName(e.lawName)}|${normalizeArticleNo(e.articleNo)}`));
const refKey = ref => `${normalizedLawName(ref.lawName)}|${normalizeArticleNo(ref.articleNo)}`;
const keywordGroupsHit = (groups, text) => (groups || []).length > 0
  && groups.every(group => group.some(term => String(text).replace(/\s+/g, '').includes(term.replace(/\s+/g, ''))));

/**
 * S1이 세운 쟁점 중 스킬 쟁점 서식을 이미 다루는 것.
 * 같은 조문만으로는 같은 쟁점이라 하지 않는다(포괄임금 쟁점도 연장근로 조문을 가리킨다). 판정 문장이 있는 문서 조항을
 * 함께 보는 쟁점을 먼저 찾고, 그다음 문장이 닮았거나 쟁점어 묶음이 모두 닿는 쟁점을 찾는다.
 */
export function findCoveringIssue(issues, template, registry, documentIds = []) {
  const wanted = new Set(template.articles.map(refKey));
  const articleHit = issue => [...issueArticleKeys(issue, registry)].some(k => wanted.has(k));
  const textHit = issue => bigramSimilarity(issue.question, template.question) >= 0.5 || keywordGroupsHit(template.keywords, issue.question);
  let best = null;
  for (const issue of issues) {
    const overlap = (issue.documentIds || []).filter(id => documentIds.includes(id)).length;
    const article = articleHit(issue);
    const text = textHit(issue);
    if (!((overlap && (article || text)) || (article && text))) continue;
    const score = overlap * 2 + (article ? 3 : 0) + (text ? 2 : 0);
    if (!best || score > best.score) best = { issue, score };
  }
  return best?.issue || null;
}

/**
 * 반영할 점검 판정에 맞춰 쟁점을 보충하거나 기존 쟁점에 문서 조항·조문을 잇는다.
 * 새 쟁점은 쟁점 상한과 무관하게 붙인다. 판정이 있는 점검에서만 만들기 때문이다.
 * @returns {{ added: object[], linked: object[] }} 진단용 기록
 */
export function coverSkillIssues({ caseIssues, skills, findings, registry }) {
  const added = [];
  const linked = [];
  const byTemplate = new Map();
  for (const finding of actionableFindings(findings)) {
    const key = `${finding.skillId}:${finding.issueTemplateId}`;
    (byTemplate.get(key) || byTemplate.set(key, []).get(key)).push(finding);
  }
  for (const [key, group] of byTemplate) {
    const [skillId, templateId] = key.split(':');
    const template = skills.find(s => s.id === skillId)?.issues.find(i => i.id === templateId);
    if (!template) continue;
    const evidenceIds = [...new Set(group.map(f => f.evidenceId).filter(Boolean))];
    const documentIds = [...new Set(group.map(f => f.documentId))];
    const existing = findCoveringIssue(caseIssues.issues, template, registry, documentIds);
    let issue = existing;
    if (existing) {
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...evidenceIds])];
      existing.documentIds = [...new Set([...(existing.documentIds || []), ...documentIds])];
      linked.push({ issueId: existing.id, templateId, skillId });
    } else {
      issue = { id: `I${caseIssues.issues.length + 1}`, question: template.question, type: template.type, priority: template.priority,
        dependsOn: [], factIds: [], evidenceIds, searchTerms: template.searchTerms || [], documentIds,
        origin: 'SKILL', skillId, skillTemplateId: templateId };
      caseIssues.issues.push(issue);
      added.push({ issueId: issue.id, templateId, skillId, question: template.question });
    }
    issue.skillCheckIds = [...new Set([...(issue.skillCheckIds || []), ...group.map(f => `${f.skillId}:${f.checkId}`)])];
    for (const f of group) f.issueId = issue.id;
  }
  return { added, linked };
}

// ── S4 주입 ──────────────────────────────────────────────────

/** 판정을 받을 요건. 스킬 요건 트리는 점검 ID로 정확히 잇고, 모델이 분해한 요건은 출처 단위로 잇는다. */
export function elementForFinding(elements, finding, registry) {
  const tagged = elements.find(e => (e.skillChecks || []).includes(finding.checkId));
  if (tagged) return tagged;
  const principal = elements.filter(e => !e.isException && e.operator !== 'EXCEPTION');
  if (finding.evidenceId && finding.evidenceId !== finding.articleId) {
    const byUnit = principal.find(e => (e.sourceIds || []).includes(finding.evidenceId));
    if (byUnit) return byUnit;
  }
  return principal.find(e => (e.sourceIds || []).some(id => (registry.get(id)?.parentId || id) === finding.articleId)) || null;
}

/**
 * 쟁점 하나에 대한 스킬 판정을 요건 판단으로 만든다. 같은 요건에 여러 판정이 걸리면 위반 소지가 앞선다.
 * @returns {Map<string, object>} elementId → 요건 판단(문서 판단 형식)
 */
export function skillAssessmentsFor({ issue, elements, findings, registry, documentIds }) {
  const out = new Map();
  const relevant = actionableFindings(findings).filter(f => f.issueId === issue.id
    || (documentIds.includes(f.documentId) && (issue.skillCheckIds || []).includes(`${f.skillId}:${f.checkId}`)));
  const rank = f => (f.outcome === 'VIOLATION_RISK' ? 0 : 1);
  for (const finding of [...relevant].sort((a, b) => rank(a) - rank(b))) {
    const element = elementForFinding(elements, finding, registry);
    if (!element || out.has(element.id)) continue;
    const violation = finding.outcome === 'VIOLATION_RISK';
    const groundTexts = [registry.get(finding.documentId)?.text || ''];
    const raw = { elementId: element.id, verdict: violation ? 'VIOLATES' : 'UNCLEAR', quote: finding.quote,
      evidenceIds: [finding.evidenceId].filter(Boolean),
      analysis: `${finding.label}${finding.numeric ? ` (${finding.numeric.value}${finding.numeric.unit} — 기준 ${finding.numeric.rule})` : ''}`.slice(0, 120),
      openQuestion: violation ? '' : (finding.legalQuestion || finding.factQuestions[0] || ''), factIds: [], contraryFactIds: [] };
    const resolved = resolveDocumentVerdict(raw, groundTexts);
    out.set(element.id, { ...resolved,
      // 검토 필요 상한의 판정도 문서 문장은 코드가 원문에서 찾은 것이므로 인용을 남긴다.
      quote: finding.quote, quoteVerified: groundTexts.some(t => t.replace(/\s+/g, '').includes(finding.quote.replace(/\s+/g, ''))),
      derivedBy: finding.derivedBy, reviewPoint: !violation,
      skillCheck: { skillId: finding.skillId, checkId: finding.checkId, answer: finding.answer, outcome: finding.outcome,
        ceiling: finding.ceiling, numeric: finding.numeric || null, documentId: finding.documentId } });
  }
  return out;
}

// ── 공백 ─────────────────────────────────────────────────────

/** 스킬 판정이 남긴 확인 항목. 법리 질문은 외부 전문가 질의로, 사실 질문은 사용자 확인으로 보낸다. */
export function skillGaps(findings, issueResults) {
  const gaps = [];
  for (const f of actionableFindings(findings)) {
    if (!f.issueId) continue;
    const result = issueResults.find(r => r.issueId === f.issueId);
    const assessment = result?.assessments?.find(a => a.skillCheck?.checkId === f.checkId && a.skillCheck?.skillId === f.skillId);
    if (!assessment) continue;
    if (f.outcome === 'REVIEW_POINT' && f.legalQuestion && f.route === 'EXTERNAL_INQUIRY') {
      gaps.push({ issueId: f.issueId, elementId: assessment.elementId, changesOutcome: true, priority: 3,
        type: 'LEGAL_INTERPRETATION', question: f.legalQuestion, origin: `${f.skillId}:${f.checkId}` });
    }
    for (const question of f.factQuestions) {
      gaps.push({ issueId: f.issueId, elementId: assessment.elementId, changesOutcome: f.outcome === 'REVIEW_POINT', priority: 2,
        type: 'FACT_UNKNOWN', question: `${f.label}: ${question}`, origin: `${f.skillId}:${f.checkId}` });
    }
  }
  return gaps;
}
