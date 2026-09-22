import { createHash } from 'node:crypto';
import { articleText, containsCitation, inForceAt, isOfficial, normalizedLawName, today } from './evidence.js';
import { normalizeArticleNo } from './lawArticleRef.js';
import { getLearningStore } from './manualLearningStore.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function officialLearningArticles(context) {
  const e = context.officialEvidence || {};
  const direct = (e.articles || []).map(a => ({ ...a, lawName: a.lawName || e.lawDetail?.lawName,
    source: a.source || e.lawDetail?.source, isMockData: a.isMockData || e.lawDetail?.isMockData }));
  const cascading = Object.values(e.cascadingHierarchy || {}).filter(isOfficial).flatMap(law =>
    (law.articles || []).map(a => ({ ...a, lawName: law.lawName, source: law.source, isMockData: a.isMockData || law.isMockData })));
  return [...direct, ...cascading, ...(e.ordinanceArticles || [])]
    .filter(a => isOfficial(a) && inForceAt(a, context.meta?.asOfDate || today()));
}

export function learningScope(context) {
  // A conservative snapshot match. Knowledge cannot carry an old law version into a new review.
  const e = context.officialEvidence || {};
  const source = { lawDetail: e.lawDetail, articles: e.articles, cascadingHierarchy: e.cascadingHierarchy,
    ordinanceArticles: e.ordinanceArticles, adminRuleDetails: e.adminRuleDetails, annexes: e.annexes,
    precedents: e.precedents, interpretations: e.interpretations };
  return { preset: context.meta?.preset || 'compliance', primaryLaw: normalizedLawName(context.meta?.primaryLawName),
    targetDate: context.meta?.targetDate || 'CURRENT', evidenceHash: digest(source),
    hasOfficialArticles: officialLearningArticles(context).length > 0 };
}

export function checkLearningCitations(card, context) {
  const articles = officialLearningArticles(context);
  return (card.citations || []).map(c => ({ ...c, status: !/[~,]|및|부터/.test(c.articleNo) && articles.some(a =>
    normalizedLawName(a.lawName) === normalizedLawName(c.lawName)
    && normalizeArticleNo(a.fullArticleNo || a.articleNo) === normalizeArticleNo(c.articleNo)
    && containsCitation(a, c.articleNo)) ? 'VERIFIED_EXISTENCE' : 'UNVERIFIED' }));
}

export function findLearningKnowledge(context, query, store = getLearningStore()) {
  const scope = learningScope(context);
  if (!scope.hasOfficialArticles) return [];
  const needle = String(query || '').toLowerCase();
  return store.list('knowledge', 'APPROVED').filter(item => {
    const parent = store.get(item.parentId);
    if (parent?.state !== 'READY' || digest(parent.text) !== item.inquiryHash) return false;
    if (!item.scope || item.scope.primaryLaw !== scope.primaryLaw || item.scope.preset !== scope.preset
      || item.scope.targetDate !== scope.targetDate || item.scope.evidenceHash !== scope.evidenceHash) return false;
    if (Date.now() - Date.parse(item.approvedAt) > 90 * 86400000 || !Number.isFinite(Date.parse(item.approvedAt))) return false;
    const citations = checkLearningCitations(item.card, context);
    return citations.length > 0 && citations.every(c => c.status === 'VERIFIED_EXISTENCE');
  }).map(item => ({ ...item, matches: [...new Set(item.card.keywords)].filter(k => needle.includes(k.toLowerCase())).length }))
    .filter(item => item.matches >= 2).sort((a, b) => b.matches - a.matches).slice(0, 2)
    .map(item => ({ id: item.id, title: item.card.title, card: item.card, source: 'USER_APPROVED_EXTERNAL_AI',
      approvedAt: item.approvedAt }));
}
