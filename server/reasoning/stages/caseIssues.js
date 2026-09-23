// server/reasoning/stages/caseIssues.js - S1 사건·쟁점 (LLM 1회, think off)
//
// 검색·추론 전에 쟁점을 독립 객체로 확정한다. 모델은 사실·쟁점·후보 근거를 ID로 제시하고,
// 코드는 그 결과를 믿기 전에 다음을 확인한다.
//   - 사실의 인용문이 첨부문서(또는 질의)에 실제로 있는가 → 없으면 INFERRED로 강등
//   - 근거 ID가 등록부에 있는가 → 없으면 버리고 rejectedIds에 남긴다
//   - 쟁점 중복·상한·선결관계 순환
import { runStage } from '../stageRunner.js';
import { caseIssuesSchema, PRIORITIES } from '../schemas.js';
import { REASONING_SYSTEM } from '../prompts.js';

const TASK = ({ maxIssues }) => `[과제: 사건 사실과 법률 쟁점 정리]
1. facts: 판단에 필요한 사실만 뽑는다. docRef에는 그 사실이 적힌 첨부문서 조항 ID(D…)를, 질의에만 있으면 "QUERY"를 쓴다.
   quote에는 그 조항에서 사실을 뒷받침하는 원문을 80자 이내로 그대로 옮긴다. 원문에 없으면 status를 INFERRED로 두고 quote는 빈 문자열로 둔다.
   status: CONFIRMED(문서로 확인) / ALLEGED(한쪽 주장) / DISPUTED(다툼) / UNKNOWN(판단에 필요하나 자료에 없음) / INFERRED(추론).
2. issues: 서로 독립된 법률 쟁점을 최대 ${maxIssues}개 세운다. question은 "~인가?" 형태의 한 문장이다.
   type: THRESHOLD(선결) / PRIMARY / DEPENDENT(다른 쟁점 결론에 좌우) / PROCEDURAL / REMEDY / INTERPRETATION(해석 대립).
   dependsOn에는 먼저 풀려야 하는 쟁점 id, factIds에는 관련 사실 id, evidenceIds에는 근거 색인의 관련 ID(하위 ID 권장)를 쓴다.
   searchTerms에는 판례·해석례 검색에 쓸 짧은 법률 용어를 최대 4개 쓴다.
   해석 대립 쟁점은 positions에 각 견해의 이름·주장·근거 ID를 옮긴다.
3. unknownFacts: 결론에 필요하지만 자료에 없는 사실을 적는다.
판단·결론은 쓰지 않는다. 출력 JSON 형식:
{"facts":[{"id":"F1","text":"","status":"CONFIRMED","docRef":"D1","quote":""}],"issues":[{"id":"I1","question":"","type":"PRIMARY","priority":"HIGH","dependsOn":[],"factIds":["F1"],"evidenceIds":["A1.2"],"searchTerms":[""]}],"unknownFacts":[""]}`;

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();

/**
 * 글자 2-gram 자카드 유사도. 같은 쟁점을 표현만 바꿔 두 번 세운 경우를 잡는다.
 * 문장부호와 끝의 높임 어미(요)는 비교에서 뺀다. 임계값은 높게 둔다 — 서로 다른 쟁점을 합치면
 * 쟁점 하나가 사라지므로, 중복이 남는 편이 덜 해롭다.
 */
export function bigramSimilarity(a, b) {
  const grams = text => {
    const t = normalize(text).replace(/[^\p{L}\p{N}]/gu, '').replace(/요$/, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const x = grams(a); const y = grams(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * 사실의 인용문을 원문과 대조한다.
 * @returns {{ docRef: string, verified: boolean }}
 */
function locateQuote(fact, registry, query) {
  const quote = normalize(fact.quote);
  if (quote.length < 4) return { docRef: '', verified: false };
  const inEntry = entry => [entry, ...registry.children(entry.id)].some(e => normalize(e.text).includes(quote));
  const claimed = registry.get(fact.docRef);
  if (claimed && claimed.kind.startsWith('DOCUMENT') && inEntry(claimed.parentId ? registry.get(claimed.parentId) : claimed)) {
    return { docRef: claimed.id, verified: true };
  }
  if (normalize(query).includes(quote)) return { docRef: 'QUERY', verified: true };
  // 모델이 조항 ID를 틀리게 적었어도 인용문이 다른 조항에 있으면 그 조항으로 바로잡는다.
  const found = registry.list(e => e.kind === 'DOCUMENT').find(inEntry);
  return found ? { docRef: found.id, verified: true } : { docRef: '', verified: false };
}

/**
 * 선결관계에서 순환을 만드는 간선을 끊는다. 간선을 쟁점 순서대로 하나씩 그래프에 넣으면서,
 * 넣으려는 간선의 끝(dep)에서 이미 시작점(issue)에 닿을 수 있으면 그 간선이 순환을 닫으므로 버린다.
 */
function breakCycles(issues) {
  const accepted = new Map(issues.map(i => [i.id, []]));
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (accepted.get(from) || []).some(next => reaches(next, target, seen));
  };
  const removed = [];
  for (const issue of issues) {
    for (const dep of issue.dependsOn) {
      if (reaches(dep, issue.id)) removed.push(`${issue.id}→${dep}`);
      else accepted.get(issue.id).push(dep);
    }
  }
  for (const issue of issues) issue.dependsOn = accepted.get(issue.id);
  return removed;
}

/**
 * 모델 출력을 검증·정리한다. LLM 호출과 분리해 두어 결정적 규칙을 따로 시험할 수 있게 한다.
 */
export function normalizeCaseIssues(raw, { registry, query, maxIssues = 5 }) {
  const diagnostics = { rejectedIds: [], downgradedFacts: [], mergedIssues: [], droppedIssues: [], removedDependencies: [] };

  // ── 사실 ──
  const factMap = new Map();
  const facts = [];
  for (const fact of raw.facts || []) {
    const text = normalize(fact.text);
    if (!text) continue;
    const id = `F${facts.length + 1}`;
    factMap.set(fact.id, id);
    const located = fact.status === 'UNKNOWN' ? { docRef: '', verified: false } : locateQuote(fact, registry, query);
    let status = fact.status;
    // 원문으로 확인되지 않은 사실은 확정 사실처럼 쓰지 못하게 한다.
    if (!located.verified && ['CONFIRMED', 'ALLEGED', 'DISPUTED'].includes(status)) {
      diagnostics.downgradedFacts.push({ id, from: status });
      status = 'INFERRED';
    }
    facts.push({ id, text, status, docRef: located.docRef, quote: located.verified ? normalize(fact.quote) : '', quoteVerified: located.verified });
  }

  // ── 근거 ID ──
  const cleanEvidence = (ids, owner) => {
    const { found, unknown } = registry.resolve(ids);
    for (const id of unknown) diagnostics.rejectedIds.push({ owner, id });
    // 첨부문서는 사실의 출처이지 법적 근거가 아니다.
    return found.filter(e => !e.kind.startsWith('DOCUMENT')).map(e => e.id);
  };

  // ── 쟁점: 정리 → 중복 병합 → 상한 ──
  let issues = [];
  for (const issue of raw.issues || []) {
    const question = normalize(issue.question);
    if (!question) continue;
    const candidate = { rawId: issue.id, question, type: issue.type, priority: issue.priority,
      dependsOn: [...new Set(issue.dependsOn || [])], factIds: [...new Set((issue.factIds || []).map(f => factMap.get(f)).filter(Boolean))],
      evidenceIds: cleanEvidence(issue.evidenceIds, issue.id),
      searchTerms: [...new Set((issue.searchTerms || []).map(normalize).filter(t => t.length >= 2))],
      ...(issue.positions?.length ? { positions: issue.positions.map(p => ({ label: normalize(p.label), claim: normalize(p.claim),
        evidenceIds: cleanEvidence(p.evidenceIds, `${issue.id}:${p.label}`) })) } : {}) };
    const duplicate = issues.find(i => bigramSimilarity(i.question, question) >= 0.8);
    if (duplicate) {
      diagnostics.mergedIssues.push({ kept: duplicate.rawId, merged: issue.id });
      duplicate.aliases = [...(duplicate.aliases || []), issue.id];
      for (const key of ['factIds', 'evidenceIds', 'searchTerms', 'dependsOn']) duplicate[key] = [...new Set([...duplicate[key], ...candidate[key]])];
      if (PRIORITIES.indexOf(candidate.priority) < PRIORITIES.indexOf(duplicate.priority)) duplicate.priority = candidate.priority;
      continue;
    }
    issues.push(candidate);
  }
  if (issues.length > maxIssues) {
    // 우선순위가 높은 것부터 남기되 원래 순서는 유지한다.
    const keep = new Set([...issues].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)).slice(0, maxIssues));
    diagnostics.droppedIssues = issues.filter(i => !keep.has(i)).map(i => i.question);
    issues = issues.filter(i => keep.has(i));
  }

  // ── ID 재부여와 선결관계 정리 ──
  const issueMap = new Map();
  issues.forEach((issue, i) => {
    const id = `I${i + 1}`;
    issueMap.set(issue.rawId, id);
    for (const alias of issue.aliases || []) issueMap.set(alias, id);
    issue.id = id;
  });
  for (const issue of issues) {
    issue.dependsOn = [...new Set(issue.dependsOn.map(d => issueMap.get(d)).filter(d => d && d !== issue.id))];
    delete issue.rawId;
    delete issue.aliases;
  }
  diagnostics.removedDependencies = breakCycles(issues);

  const unknownFacts = [...new Set((raw.unknownFacts || []).map(normalize).filter(Boolean))];
  return { facts, issues, unknownFacts, diagnostics };
}

/**
 * S1 실행.
 * @param {object} args
 * @param {object} args.registry 근거 등록부
 * @param {string} args.prefix buildCommonPrefix(...).text — 이후 단계와 공유한다
 * @param {object} args.config 게이트웨이 설정(budget, model). think는 여기서 false로 고정한다.
 */
export async function planCaseAndIssues({ registry, query, prefix, provider, config, session, maxIssues = 5 }) {
  const schema = caseIssuesSchema({ maxIssues: maxIssues + 2 }); // 병합·상한 정리 여지를 조금 둔다
  const { value, attempts } = await runStage({ stage: 's1', provider, system: REASONING_SYSTEM,
    prefix, task: TASK({ maxIssues }), schema, config: { ...config, think: false }, session });
  const result = normalizeCaseIssues(value, { registry, query, maxIssues });
  result.diagnostics.attempts = attempts;
  return result;
}
