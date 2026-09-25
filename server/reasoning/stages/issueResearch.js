// server/reasoning/stages/issueResearch.js - S2 쟁점별 조사 (LLM 호출 없음)
//
// S1이 정한 쟁점마다 검색어로 판례·해석례를 더 모으고, 후보 근거를 쟁점별로 정렬한다.
// 정렬 점수는 순서를 정하는 데만 쓰고, 개별 특징(문자 일치·참조조문·법원·의미 유사도)을
// 따로 남긴다. 유사도가 높다고 법적으로 유사한 사안은 아니므로 유추·구별은 S4가 판정한다.
//
// 반대 근거 탐색: 입장(지지/반대)은 코드가 판정할 수 없다. 대신 (1) 쟁점 조문의 단서(…x)를
// 반대 후보로 항상 함께 싣고, (2) 쟁점 조문 번호로도 검색해 결론 방향과 무관하게 같은 조문을
// 다룬 판례를 모은다. S4가 각 후보의 입장을 판정한다.
import { searchInterpretationCandidates, searchPrecedentCandidates, getPrecedentDetail, getInterpretationDetail } from '../../law/decisionsApiClient.js';
import { screenEvidenceCandidates, hydrateSelectedCandidates } from '../../law/evidenceScreen.js';
import { isOfficial } from '../../law/evidence.js';
import { authorityKey, formatArticleNo } from '../evidenceRegistry.js';
import { cosine, embedTexts } from '../embeddings.js';
import { contractSeedEvidenceIds } from '../contractReview.js';

export const RESEARCH_LIMITS = Object.freeze({
  termsPerIssue: 2,       // 쟁점당 검색어
  articleQueries: 1,      // 쟁점당 조문 번호 검색
  totalQueries: 10,       // 한 검토 전체 검색어 상한 (쟁점 간 중복은 한 번만 조회)
  perQuery: 3             // 검색어당 목록 건수 (건마다 본문 조회가 붙는다)
});

/** 쟁점별 검색어. 검색어가 겹치면 한 번만 조회한다. */
export function planResearchQueries(issues, registry, limits = RESEARCH_LIMITS) {
  const byIssue = {};
  const all = [];
  for (const issue of issues) {
    const queries = issue.searchTerms.slice(0, limits.termsPerIssue);
    const articles = issue.evidenceIds.map(id => registry.get(id)).filter(e => e && ['ARTICLE', 'ARTICLE_UNIT', 'ARTICLE_PROVISO'].includes(e.kind));
    const seen = new Set();
    for (const entry of articles) {
      const query = `${entry.lawName} ${formatArticleNo(entry.articleNo)}`;
      if (seen.has(query) || seen.size >= limits.articleQueries) continue;
      seen.add(query);
      queries.push(query);
    }
    byIssue[issue.id] = [...new Set(queries)];
    for (const q of byIssue[issue.id]) if (!all.includes(q)) all.push(q);
  }
  const selected = all.slice(0, limits.totalQueries);
  for (const id of Object.keys(byIssue)) byIssue[id] = byIssue[id].filter(q => selected.includes(q));
  return { byIssue, queries: selected, skipped: all.slice(limits.totalQueries) };
}

/**
 * 검색을 실행하고 새로 찾은 공식 본문 자료를 컨텍스트에 덧붙인다.
 * 기존 자료 뒤에 붙이므로 등록부를 다시 만들어도 기존 P·Q 번호는 바뀌지 않는다.
 */
export async function runResearchQueries(context, plan, { clients = {}, limits = RESEARCH_LIMITS, issues = [], provider, model, apiKey,
  session, classify = null } = {}) {
  const api = { searchPrecedents: searchPrecedentCandidates, searchInterpretations: searchInterpretationCandidates,
    getPrecedentDetail, getInterpretationDetail, ...clients };
  const evidence = context.officialEvidence || {};
  const known = new Set([...(evidence.precedents || []).filter(p => isOfficial(p) && p.contentStatus === 'FULL_TEXT').map(p => authorityKey('prec', p)),
    ...(evidence.interpretations || []).filter(q => isOfficial(q) && q.contentStatus === 'FULL_TEXT').map(q => authorityKey('expc', q))]);
  const added = { precedents: [], interpretations: [] };
  const hits = {};
  const warnings = [];
  const screening = [];
  const pools = { precedent: new Map(), interpretation: new Map() };
  for (const query of plan.queries) {
    hits[query] = [];
    const results = await Promise.allSettled([api.searchPrecedents(query, 1, limits.perQuery), api.searchInterpretations(query, 1, limits.perQuery)]);
    for (const [i, result] of results.entries()) {
      const target = i === 0 ? 'prec' : 'expc';
      if (result.status === 'rejected' || !Array.isArray(result.value) || result.value.fetchStatus) {
        warnings.push(`'${query}' ${i === 0 ? '판례' : '해석례'} 조회 미완료`);
        continue;
      }
      const kind = i === 0 ? 'precedent' : 'interpretation';
      for (const item of result.value) {
        if (!item?.id) continue;
        const k = authorityKey(target, item);
        if (known.has(k)) { hits[query].push(k); continue; }
        const pool = pools[kind];
        if (!pool.has(String(item.id))) pool.set(String(item.id), { item, queries: new Set() });
        pool.get(String(item.id)).queries.add(query);
      }
    }
  }
  for (const [kind, pool] of Object.entries(pools)) {
    const candidates = [...pool.values()].map(v => v.item);
    const relevantIssues = issues.filter(issue => (plan.byIssue[issue.id] || []).some(q => plan.queries.includes(q)));
    const issueText = relevantIssues.map(issue => issue.question).join(' / ');
    const protectedIds = candidates.filter(item => {
      const number = kind === 'precedent' ? item.caseNo : item.itemNo;
      return number && issueText.includes(number);
    }).map(item => item.id);
    const screened = await screenEvidenceCandidates({ candidates, kind, query: plan.queries.join(' / '), issue: issueText,
      provider, model, apiKey, session, protectedIds, classify });
    screening.push(...screened.decisions.map(d => ({ ...d, queries: [...(pool.get(d.id)?.queries || [])] })));
    warnings.push(...screened.warnings);
    const hydrated = await hydrateSelectedCandidates({ candidates: screened.selected, kind,
      loadDetail: kind === 'precedent' ? api.getPrecedentDetail : api.getInterpretationDetail });
    warnings.push(...hydrated.warnings);
    const target = kind === 'precedent' ? 'prec' : 'expc';
    const bucket = kind === 'precedent' ? 'precedents' : 'interpretations';
    for (const item of hydrated.items) {
      if (!isOfficial(item) || item.contentStatus !== 'FULL_TEXT') continue;
      const k = authorityKey(target, item);
      for (const query of pool.get(String(item.id))?.queries || []) hits[query].push(k);
      if (!known.has(k)) {
        known.add(k);
        added[bucket].push(item);
      }
    }
  }
  const augmented = { ...context, officialEvidence: { ...evidence,
    precedents: [...(evidence.precedents || []), ...added.precedents],
    interpretations: [...(evidence.interpretations || []), ...added.interpretations] } };
  return { context: augmented, hits, added: { precedents: added.precedents.length, interpretations: added.interpretations.length },
    addedItems: added, screening, warnings };
}

/** 이전 실행에서 조사로 덧붙인 자료를 그대로 다시 붙인다(재검토에서 등록부 번호를 똑같이 맞추기 위해). */
export function reapplyResearch(context, addedItems = {}) {
  const evidence = context.officialEvidence || {};
  return { ...context, officialEvidence: { ...evidence,
    precedents: [...(evidence.precedents || []), ...(addedItems.precedents || [])],
    interpretations: [...(evidence.interpretations || []), ...(addedItems.interpretations || [])] } };
}

const containsTerm = (text, term) => term.length >= 2 && String(text || '').includes(term);

/**
 * 쟁점별 후보 근거를 정렬해 S4에 넘길 ID를 고른다.
 * @returns {Promise<{ evidenceIds: string[], adverseCandidateIds: string[], documentIds: string[], candidates: object[], warning: string|null }>}
 */
export async function selectIssueEvidence({ issue, registry, facts, plan, hits, embed = embedTexts, limits = RESEARCH_LIMITS }) {
  // 쟁점이 가리킨 조문(법령·자치법규)의 최상위 ID. 하위 단위를 가리켰어도 조문 단위로 모은다.
  const issueArticleIds = new Set(issue.evidenceIds.map(id => registry.get(id)).filter(Boolean)
    .map(e => e.parentId || e.id).filter(id => /^[AO]\d+$/.test(id)));
  const issueLawNames = [...new Set([...issueArticleIds].map(id => registry.get(id)?.lawName).filter(Boolean))];
  const retrieved = new Set((plan.byIssue[issue.id] || []).flatMap(q => hits[q] || []));
  const authorities = registry.list(e => (e.kind === 'PRECEDENT' || e.kind === 'INTERPRETATION') && e.inForce);

  // 의미 유사도: 쟁점 질문 ↔ 판결요지 명제·해석례 회답. 명제 단위로 재서 가장 가까운 명제를 고른다.
  const units = authorities.flatMap(a => {
    const children = registry.children(a.id).filter(c => ['PRECEDENT_HOLDING', 'INTERPRETATION_ANSWER'].includes(c.kind));
    return (children.length ? children : [a]).map(u => ({ authority: a.id, unit: u }));
  });
  const { vectors, warning } = units.length ? await embed([issue.question, ...units.map(u => u.unit.text)]) : { vectors: [], warning: null };
  const [questionVector, ...unitVectors] = vectors;
  const bestUnit = new Map();
  units.forEach((u, i) => {
    const score = cosine(questionVector, unitVectors[i]);
    const current = bestUnit.get(u.authority);
    if (score !== null && (!current || score > current.score)) bestUnit.set(u.authority, { id: u.unit.id, score });
  });

  const terms = [...issue.searchTerms, ...issue.question.split(/\s+/).filter(w => w.length >= 3)].slice(0, 8);
  const candidates = authorities.map(a => {
    const features = {
      retrievedForIssue: retrieved.has(a.sourceKey),
      namedByS1: issue.evidenceIds.some(id => id === a.id || registry.get(id)?.parentId === a.id),
      articleMatch: (a.referenceIds || []).some(id => issueArticleIds.has(id)),
      termHits: terms.filter(t => containsTerm(a.text, t)).length,
      supremeCourt: /대법원|헌법재판소/.test(a.label),
      semantic: bestUnit.has(a.id) ? Number(bestUnit.get(a.id).score.toFixed(3)) : null
    };
    // 순서를 정하기 위한 합산일 뿐, 관련도나 확률이 아니다.
    const rank = (features.namedByS1 ? 4 : 0) + (features.articleMatch ? 3 : 0) + (features.retrievedForIssue ? 1 : 0)
      + Math.min(features.termHits, 3) * 0.5 + (features.supremeCourt ? 0.5 : 0) + (features.semantic ?? 0) * 4;
    return { id: a.id, focusId: bestUnit.get(a.id)?.id || null, features, rank: Number(rank.toFixed(2)) };
  }).filter(c => c.features.namedByS1 || c.features.articleMatch || c.features.retrievedForIssue || c.features.termHits > 0)
    .sort((a, b) => b.rank - a.rank);

  const classified = candidates.map(candidate => {
    const entry = registry.get(candidate.id);
    const lawMatch = issueLawNames.some(name => String(entry?.referencedArticles || entry?.text || '').includes(name));
    const legalIssueMatch = Math.min(candidate.features.termHits / 2, 1);
    const factText = facts.filter(f => issue.factIds.includes(f.id)).map(f => f.text || '').join(' ');
    const factTerms = factText.split(/\s+/).filter(term => term.length >= 3).slice(0, 8);
    const factualSimilarity = factTerms.length
      ? factTerms.filter(term => containsTerm(entry?.text, term)).length / factTerms.length : 0;
    const gates = { lawMatch, articleMatch: candidate.features.articleMatch,
      legalIssueMatch, factualSimilarity, semanticSimilarity: Math.max(0, candidate.features.semantic || 0) };
    return { ...candidate, gates,
      relevanceRole: candidate.features.articleMatch || candidate.features.namedByS1 && (lawMatch || entry?.kind === 'PRECEDENT') ? 'DIRECT'
        : candidate.features.retrievedForIssue && legalIssueMatch === 1
          && (entry?.kind === 'PRECEDENT' || lawMatch) ? 'ANALOGY' : 'NOT_RELEVANT',
      authorityRelevance: Number(((lawMatch ? 0.3 : 0) + (gates.articleMatch ? 0.25 : 0)
        + legalIssueMatch * 0.25 + factualSimilarity * 0.15
        + gates.semanticSimilarity * 0.05).toFixed(3)) };
  });
  const chosen = classified.filter(candidate => candidate.relevanceRole !== 'NOT_RELEVANT');
  // 판례는 명제 전부를 싣는다. 가장 가까운 명제만 실으면 같은 판례 안의 반대 명제(예외·제한)가
  // 빠져 결론이 한쪽으로 기운다. 판결요지는 짧으므로 입력 부담이 크지 않다. focusId는 표시용이다.
  const authorityIds = chosen.map(c => c.id);
  const contractSeeds = contractSeedEvidenceIds(issue.contractKinds || [], registry);
  const statuteIds = [...new Set(contractSeeds.length ? contractSeeds
    : issue.evidenceIds.filter(id => !/^[PQ]/.test(id)))];
  // 쟁점 조문의 단서는 반대 근거 후보로 항상 싣는다.
  const adverseCandidateIds = [...issueArticleIds].flatMap(id => registry.children(id)).filter(e => e.isException).map(e => e.id);
  const documentIds = [...new Set([...(issue.documentIds || []), ...facts.filter(f => issue.factIds.includes(f.id) && f.docRef && f.docRef !== 'QUERY')
    .map(f => registry.get(f.docRef)?.parentId || f.docRef)])];

  return { evidenceIds: [...new Set([...statuteIds, ...authorityIds])], adverseCandidateIds: adverseCandidateIds.filter(id => !statuteIds.includes(id)),
    documentIds, candidates: classified, warning };
}
