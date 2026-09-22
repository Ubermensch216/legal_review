import { createHash } from 'node:crypto';
import { articleText, containsCitation, inForceAt, isOfficial, normalizedLawName, today } from './evidence.js';
import { normalizeArticleNo } from './lawArticleRef.js';
import { getLearningStore } from './manualLearningStore.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** 수집한 공식 조문 전체. 시행 여부는 따지지 않는다. */
export function allCollectedArticles(context) {
  const e = context.officialEvidence || {};
  const direct = (e.articles || []).map(a => ({ ...a, lawName: a.lawName || e.lawDetail?.lawName,
    source: a.source || e.lawDetail?.source, isMockData: a.isMockData || e.lawDetail?.isMockData }));
  const cascading = Object.values(e.cascadingHierarchy || {}).filter(isOfficial).flatMap(law =>
    (law.articles || []).map(a => ({ ...a, lawName: law.lawName, source: law.source, isMockData: a.isMockData || law.isMockData })));
  return [...direct, ...cascading, ...(e.ordinanceArticles || [])].filter(isOfficial);
}

export function officialLearningArticles(context) {
  return allCollectedArticles(context).filter(a => inForceAt(a, context.meta?.asOfDate || today()));
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
  const matches = (list, c) => list.some(a =>
    normalizedLawName(a.lawName) === normalizedLawName(c.lawName)
    && normalizeArticleNo(a.fullArticleNo || a.articleNo) === normalizeArticleNo(c.articleNo)
    && containsCitation(a, c.articleNo));
  // 시행 중이 아닌 조문을 근거로 든 것과, 아예 확인되지 않는 조문은 사용자가 취할 조치가 다르다.
  const allArticles = allCollectedArticles(context);
  return (card.citations || []).map(c => {
    if (/[~,]|및|부터/.test(c.articleNo)) return { ...c, status: 'UNVERIFIED' };
    if (matches(articles, c)) return { ...c, status: 'VERIFIED_EXISTENCE' };
    return { ...c, status: matches(allArticles, c) ? 'OUT_OF_FORCE' : 'UNVERIFIED' };
  });
}

// 대법원 사건번호(2018두42955), 헌재 사건번호(2019헌가12) 표기.
const CASE_NUMBER = /\b(\d{4}\s*(?:헌[가-힣]|[가-힣]{1,2})\s*\d{1,6})\b/g;
const normalizeCaseNo = value => String(value || '').replace(/\s/g, '');

/**
 * 카드 본문에 적힌 판례·해석례 번호가 이번 검토에서 실제로 확보한 자료에 있는지 본다.
 * 카드 스키마의 citations에는 조문만 들어가므로, 산문 속에 끼워 넣은 사건번호는
 * 지금까지 아무 검증도 받지 않고 '확인된 근거'처럼 읽혔다.
 */
export function checkLearningCases(card, context) {
  const evidence = context.officialEvidence || {};
  const known = new Set();
  for (const item of [...(evidence.precedents || []), ...(evidence.interpretations || [])]) {
    if (!isOfficial(item)) continue;
    for (const value of [item.caseNo, item.itemNo, item.id]) {
      if (value) known.add(normalizeCaseNo(value));
    }
  }
  const text = JSON.stringify({ ...card, citations: undefined });
  const seen = new Map();
  for (const match of text.matchAll(CASE_NUMBER)) {
    const caseNo = normalizeCaseNo(match[1]);
    if (!seen.has(caseNo)) seen.set(caseNo, { caseNo, status: known.has(caseNo) ? 'VERIFIED_EXISTENCE' : 'UNVERIFIED' });
  }
  return [...seen.values()];
}

export const EXCLUSION_REASON = Object.freeze({
  PARENT_MODIFIED: '원 질의서가 변경되었습니다.',
  SCOPE_CHANGED: '검토 유형·기준 법령·기준일이 이 검토와 다릅니다.',
  EVIDENCE_CHANGED: '기준이 된 공식 근거가 변경되었습니다.',
  EXPIRED: '승인 후 90일이 지났습니다.',
  CITATION_UNVERIFIED: '인용한 조문을 공식 근거에서 확인하지 못했습니다.',
  CASE_UNVERIFIED: '본문에 적힌 판례·해석례 번호를 공식 자료에서 확인하지 못했습니다.',
  NOT_RELEVANT: '이 검토의 쟁점어와 충분히 겹치지 않습니다.',
  BUDGET: '입력 예산이 부족해 이번 검토에는 싣지 못했습니다.'
});

/** 왜 제외되었는지 남긴다. 조용히 빠지면 사용자는 "답변을 다 넣었는데 반영이 안 됐다"고만 느낀다. */
const excluded = (item, reason) => ({ id: item.id, title: item.card?.title || '', reason,
  message: EXCLUSION_REASON[reason], inCase: Boolean(item.inCase) });

/**
 * 승인된 지식 중 이번 검토에 쓸 수 있는 것을 고른다.
 * `historyId`를 주면 그 검토에서 파생된 지식은 쟁점어 일치를 요구하지 않는다. 방금 그 사건을 위해
 * 만든 지식이 키워드 게이트에 걸려 조용히 빠지는 것을 막기 위함이다.
 * 승인 상태·질의서 연결·근거 스냅샷·기간·인용 검증 네 조건은 어느 경우에도 완화하지 않는다.
 */
export function findLearningKnowledge(context, query, store = getLearningStore(), { historyId = null, limit = 2 } = {}) {
  const scope = learningScope(context);
  if (!scope.hasOfficialArticles) return { used: [], excluded: [] };
  const needle = String(query || '').toLowerCase();
  const drops = [];
  const kept = [];

  for (const item of store.list('knowledge', 'APPROVED')) {
    const inCase = Boolean(historyId) && item.historyId === historyId;
    const tagged = { ...item, inCase };
    const parent = store.get(item.parentId);
    if (parent?.state !== 'READY' || digest(parent.text) !== item.inquiryHash) { drops.push(excluded(tagged, 'PARENT_MODIFIED')); continue; }
    if (!item.scope || item.scope.primaryLaw !== scope.primaryLaw || item.scope.preset !== scope.preset
      || item.scope.targetDate !== scope.targetDate) { drops.push(excluded(tagged, 'SCOPE_CHANGED')); continue; }
    if (item.scope.evidenceHash !== scope.evidenceHash) { drops.push(excluded(tagged, 'EVIDENCE_CHANGED')); continue; }
    if (Date.now() - Date.parse(item.approvedAt) > 90 * 86400000 || !Number.isFinite(Date.parse(item.approvedAt))) {
      drops.push(excluded(tagged, 'EXPIRED')); continue;
    }
    const citations = checkLearningCitations(item.card, context);
    if (!citations.length || !citations.every(c => c.status === 'VERIFIED_EXISTENCE')) {
      drops.push(excluded(tagged, 'CITATION_UNVERIFIED')); continue;
    }
    // 산문에 끼워 넣은 사건번호도 확인되지 않으면 쓰지 않는다. 조문만 맞고 판례가 지어낸 것이면
    // 그 지식은 근거 없는 법리를 검토에 실어 나른다.
    if (checkLearningCases(item.card, context).some(c => c.status !== 'VERIFIED_EXISTENCE')) {
      drops.push(excluded(tagged, 'CASE_UNVERIFIED')); continue;
    }
    const matches = [...new Set(item.card.keywords)].filter(k => needle.includes(k.toLowerCase())).length;
    if (!inCase && matches < 2) { drops.push(excluded(tagged, 'NOT_RELEVANT')); continue; }
    kept.push({ ...tagged, matches });
  }

  // 같은 사건에서 만든 지식을 먼저 싣는다. 그 다음이 쟁점어가 많이 겹치는 순서다.
  kept.sort((a, b) => Number(b.inCase) - Number(a.inCase) || b.matches - a.matches);
  for (const item of kept.slice(limit)) drops.push(excluded(item, 'BUDGET'));

  return {
    used: kept.slice(0, limit).map(item => ({ id: item.id, title: item.card.title, card: item.card,
      source: 'USER_APPROVED_EXTERNAL_AI', approvedAt: item.approvedAt, inCase: item.inCase })),
    excluded: drops
  };
}
