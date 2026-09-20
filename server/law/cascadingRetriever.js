import { searchLaw, getLawDetail } from './lawApiClient.js';
import { searchAdminRules } from './decisionsApiClient.js';
import { matchesLaw, isOfficial, articleText } from './evidence.js';
import { normalizeArticleNo } from './lawArticleRef.js';

/** Collect explicit textual references to the selected parent articles. Not a complete delegation graph. */
export async function retrieveCascadingHierarchy({ lawName = '', articleNos = [] }, dependencies = {}) {
  if (!lawName) return null;
  const api = { searchLaw, getLawDetail, searchAdminRules, ...dependencies };
  const baseName = lawName.replace(/\s*(시행령|시행규칙)$/, '').trim();
  const selected = new Set(articleNos.map(normalizeArticleNo));
  const warnings = [];
  const load = async name => {
    try {
      const results = await api.searchLaw(name, 1, 100);
      if (results.fetchStatus) return { status: results.fetchStatus, law: null };
      const match = results.find(l => matchesLaw(l, name));
      if (!match) return { status: 'NOT_FOUND', law: null };
      const detail = await api.getLawDetail(match.lawId, match.lawSeq, { enforceDate: match.enforceDate });
      if (!isOfficial(detail) || !matchesLaw(detail, name) || !detail.articles?.length) return { status: 'BODY_UNAVAILABLE', law: null };
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
  const decree = related(decreeResult, selected, '법');
  const decreeNumbers = new Set((decree?.articles || []).map(a => normalizeArticleNo(a.fullArticleNo || a.articleNo)));
  const ruleFromAct = related(ruleResult, selected, '법');
  const ruleFromDecree = related(ruleResult, decreeNumbers, '영');
  const rule = ruleFromAct && { ...ruleFromAct, articles: [...new Map([...ruleFromAct.articles, ...(ruleFromDecree?.articles || [])].map(a => [a.fullArticleNo || a.articleNo, a])).values()] };
  if (rule) rule.relationStatus = rule.articles.length ? 'TEXT_REFERENCE_FOUND' : 'UNCONFIRMED';
  const adminRules = await api.searchAdminRules(baseName, 1, 3).catch(() => []);
  const selectedAct = actResult.law?.articles.filter(a => selected.has(normalizeArticleNo(a.fullArticleNo || a.articleNo))) || [];
  return { baseName, act: actResult.law ? { lawId: actResult.law.lawId, lawName: actResult.law.lawName, lawType: actResult.law.lawType, source: actResult.law.source, articles: selectedAct } : null,
    decree, rule, adminRules, stageStatus: { act: actResult.status, decree: decreeResult.status, rule: ruleResult.status },
    isCompleteHierarchy: false, // Textual references are not proof of exhaustive statutory delegation.
    relationStatus: decree?.articles.length || rule?.articles.length ? 'PARTIAL_TEXT_LINKS' : 'UNCONFIRMED',
    warnings: [...warnings, '명시적 조문 인용으로 확인한 연계만 제공합니다. 위임 관계 전체 및 하위 규정 부존재는 확정하지 않습니다.'] };
}
export default { retrieveCascadingHierarchy };
