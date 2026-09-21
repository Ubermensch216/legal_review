import { searchLaw, getLawDetail, getLawVersions } from './lawApiClient.js';
import { getLawDetailAt } from './lawVersionAt.js';
import { searchAdminRules } from './decisionsApiClient.js';
import { matchesLaw, isOfficial, articleText, validDate } from './evidence.js';
import { normalizeArticleNo } from './lawArticleRef.js';

/** 하위 법령 본문이 인용한 상위 조문 번호를 수집한다. ("법 제22조제1항에 따른 ..." → 22) */
function citedParentArticles(articles, marker) {
  const numbers = new Set();
  for (const article of articles || []) {
    for (const match of articleText(article).matchAll(/(법|영)\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g)) {
      if (match[1] === marker) numbers.add(match[3] ? `${match[2]}의${match[3]}` : match[2]);
    }
  }
  return numbers;
}

/** Collect explicit textual references to the selected parent articles. Not a complete delegation graph. */
export async function retrieveCascadingHierarchy({ lawName = '', articleNos = [], actArticleNos = [], asOfDate = '' }, dependencies = {}) {
  if (!lawName) return null;
  const api = { searchLaw, getLawDetail, getLawVersions, searchAdminRules, ...dependencies };
  // 기준 시점이 지정되면 법·영·규칙 모두 그 시점 버전으로 맞춘다.
  // 한 단계만 현행 본문이면 법 → 영 → 규칙의 위임 체계가 서로 다른 시점으로 섞인다.
  const asOf = validDate(asOfDate);
  const baseName = lawName.replace(/\s*(시행령|시행규칙)$/, '').trim();
  const selected = new Set(articleNos.map(normalizeArticleNo));
  // articleNos가 어느 단계의 조문 번호인지 구분한다.
  // 시행령 제31조를 기준으로 삼았는데 모법 제31조를 골라오면 전혀 다른 조문이 나온다.
  const tier = /시행규칙$/.test(lawName) ? 'rule' : (/시행령$/.test(lawName) ? 'decree' : 'act');
  const warnings = [];
  const load = async name => {
    try {
      const results = await api.searchLaw(name, 1, 100);
      if (results.fetchStatus) return { status: results.fetchStatus, law: null };
      const match = results.find(l => matchesLaw(l, name));
      if (!match) return { status: 'NOT_FOUND', law: null };
      const detail = asOf
        ? (await getLawDetailAt(match, asOf, api)).detail
        : await api.getLawDetail(match.lawId, match.lawSeq, { enforceDate: match.enforceDate });
      if (!isOfficial(detail) || !matchesLaw(detail, name) || !detail.articles?.length) {
        return { status: asOf ? 'VERSION_UNAVAILABLE' : 'BODY_UNAVAILABLE', law: null };
      }
      return { status: 'COLLECTED', law: detail };
    } catch (err) { warnings.push(`${name}: ${err.message}`); return { status: 'ERROR', law: null }; }
  };
  const [actResult, decreeResult, ruleResult] = await Promise.all([load(baseName), load(`${baseName} 시행령`), load(`${baseName} 시행규칙`)]);
  const related = (result, parentNumbers, marker) => {
    if (!result.law) return null;
    const articles = result.law.articles.filter(article => {
      const text = articleText(article);
      const refs = [...text.matchAll(/(법|영)\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g)];
      return refs.some(m => m[1] === marker && parentNumbers.has(m[3] ? `${m[2]}의${m[3]}` : m[2]));
    }).map(article => ({ ...article, relationEvidence: '하위 조문 본문의 상위 조문 인용', source: result.law.source }));
    return { lawId: result.law.lawId, lawSeq: result.law.lawSeq, lawName: result.law.lawName, lawType: result.law.lawType, source: result.law.source, articles,
      relationStatus: articles.length ? 'TEXT_REFERENCE_FOUND' : 'UNCONFIRMED' };
  };
  // 기준이 시행령이면 selected는 시행령 조문 번호다.
  // 이때 모법 조문은 번호 일치가 아니라 시행령 본문의 "법 제N조" 인용을 따라가 찾는다.
  const selectedDecreeArticles = tier === 'decree'
    ? (decreeResult.law?.articles || []).filter(a => selected.has(normalizeArticleNo(a.fullArticleNo || a.articleNo)))
    : [];
  // 하위 조문이 인용한 모법 조문 + 지식베이스가 지정한 모법 주요 조문을 합친다.
  const actNumbers = tier === 'act'
    ? selected
    : new Set([...citedParentArticles(selectedDecreeArticles, '법'), ...actArticleNos.map(normalizeArticleNo)]);

  const decree = tier === 'decree'
    ? (decreeResult.law ? {
        lawId: decreeResult.law.lawId, lawSeq: decreeResult.law.lawSeq, lawName: decreeResult.law.lawName,
        lawType: decreeResult.law.lawType, source: decreeResult.law.source,
        articles: selectedDecreeArticles.map(a => ({ ...a, relationEvidence: '기준 법령으로 지정된 조문', source: decreeResult.law.source })),
        relationStatus: selectedDecreeArticles.length ? 'SELECTED' : 'UNCONFIRMED'
      } : null)
    : related(decreeResult, actNumbers, '법');
  const decreeNumbers = new Set((decree?.articles || []).map(a => normalizeArticleNo(a.fullArticleNo || a.articleNo)));
  const ruleFromAct = related(ruleResult, actNumbers, '법');
  const ruleFromDecree = related(ruleResult, decreeNumbers, '영');
  const rule = ruleFromAct && { ...ruleFromAct, articles: [...new Map([...ruleFromAct.articles, ...(ruleFromDecree?.articles || [])].map(a => [a.fullArticleNo || a.articleNo, a])).values()] };
  if (rule) rule.relationStatus = rule.articles.length ? 'TEXT_REFERENCE_FOUND' : 'UNCONFIRMED';
  const adminRules = await api.searchAdminRules(baseName, 1, 3).catch(() => []);
  const selectedAct = actResult.law?.articles.filter(a => actNumbers.has(normalizeArticleNo(a.fullArticleNo || a.articleNo)))
    .map(a => ({ ...a, relationEvidence: tier === 'act' ? '기준 법령으로 지정된 조문' : '시행령 본문이 인용한 모법 조문' })) || [];
  return { baseName, act: actResult.law ? { lawId: actResult.law.lawId, lawName: actResult.law.lawName, lawType: actResult.law.lawType, source: actResult.law.source, articles: selectedAct } : null,
    decree, rule, adminRules, stageStatus: { act: actResult.status, decree: decreeResult.status, rule: ruleResult.status },
    isCompleteHierarchy: false, // Textual references are not proof of exhaustive statutory delegation.
    relationStatus: decree?.articles.length || rule?.articles.length ? 'PARTIAL_TEXT_LINKS' : 'UNCONFIRMED',
    asOfDate: asOf || '',
    warnings: [...warnings, '명시적 조문 인용으로 확인한 연계만 제공합니다. 위임 관계 전체 및 하위 규정 부존재는 확정하지 않습니다.',
      ...(asOf ? [`${asOf} 시점에 시행 중이던 버전으로 법·영·규칙을 맞췄습니다. 확인하지 못한 단계는 제외했습니다.`] : [])] };
}
export default { retrieveCascadingHierarchy };
