// server/skills/skillCandidates.js - 승인된 외부 전문가 지식 카드 → 스킬 개정 후보 (LLM 호출 없음)
//
// 외부 전문가 질의로 받은 답변이 승인되어 지식 카드가 되면, 같은 도메인에서 반복되는 법리는 스킬에 옮길 가치가 있다.
// 여기서는 후보 목록만 만든다. 스킬 파일을 고치지 않는다(사람이 검토해 스킬에 옮기고 version을 올린다).
// 카드는 공식 근거가 아니며(legalValidity: NOT_CERTIFIED), 카드가 인용한 조문도 공식 본문 확인 전이다.
import { normalizedLawName } from '../law/evidence.js';
import { normalizeArticleNo } from '../law/lawArticleRef.js';

const lawKey = name => normalizedLawName(name);
const articleKey = (lawName, articleNo) => `${lawKey(lawName)}|${normalizeArticleNo(articleNo)}`;

/**
 * @param {object} args
 * @param {object[]} args.skills 카탈로그의 스킬
 * @param {object[]} args.cards 지식 카드 저장 항목(state가 APPROVED인 것만 쓴다)
 * @returns {{ candidates: object[], unmatchedCards: number, approvedCards: number }}
 */
export function skillRevisionCandidates({ skills, cards }) {
  const approved = cards.filter(card => card.state === 'APPROVED' && card.card);
  const candidates = [];
  let unmatchedCards = 0;
  for (const item of approved) {
    const citations = (item.card.citations || []).filter(c => c.lawName && c.articleNo);
    const text = `${item.card.title} ${item.card.issue} ${(item.card.keywords || []).join(' ')}`.replace(/\s+/g, '');
    const matched = skills.filter(skill => skill.kind === 'domain' && (
      citations.some(c => skill.authorities.some(law => lawKey(law.lawName) === lawKey(c.lawName)))
      || skill.keywords.filter(k => text.includes(k.replace(/\s+/g, ''))).length >= 2));
    if (!matched.length) { unmatchedCards++; continue; }
    for (const skill of matched) {
      const known = new Set(skill.authorities.flatMap(law => law.articles.map(no => articleKey(law.lawName, no))));
      const checked = new Set(skill.checks.map(c => articleKey(c.article.lawName, c.article.articleNo)));
      const newArticles = citations.filter(c => !known.has(articleKey(c.lawName, c.articleNo))).map(c => `${c.lawName} ${c.articleNo}`);
      const uncheckedArticles = citations.filter(c => known.has(articleKey(c.lawName, c.articleNo)) && !checked.has(articleKey(c.lawName, c.articleNo)))
        .map(c => `${c.lawName} ${c.articleNo}`);
      candidates.push({ skillId: skill.id, skillName: skill.name, skillVersion: skill.version,
        cardId: item.id, title: item.card.title, issue: item.card.issue, approvedAt: item.approvedAt || item.updatedAt || null,
        source: item.sourceType || item.source || null,
        suggestions: [
          ...(newArticles.length ? [{ type: 'AUTHORITY_SEED', detail: `조문 씨앗 추가 검토: ${newArticles.join(', ')}` }] : []),
          ...(uncheckedArticles.length ? [{ type: 'CHECK', detail: `점검이 없는 조문의 문서 점검 작성 검토: ${uncheckedArticles.join(', ')}` }] : []),
          ...((item.card.checklist || []).length ? [{ type: 'FACT_GUIDANCE', detail: `사실 질문 안내 보강 검토: ${item.card.checklist.slice(0, 2).join(' / ')}` }] : [])
        ] });
    }
  }
  // 같은 스킬에 카드가 둘 이상 모이면 반복되는 법리로 보고 먼저 보여 준다.
  const counts = candidates.reduce((m, c) => m.set(c.skillId, (m.get(c.skillId) || 0) + 1), new Map());
  for (const c of candidates) c.repeated = counts.get(c.skillId) > 1;
  candidates.sort((a, b) => Number(b.repeated) - Number(a.repeated) || String(b.approvedAt).localeCompare(String(a.approvedAt)));
  return { candidates, unmatchedCards, approvedCards: approved.length };
}

/** 화면·API용 카탈로그 요약. 스킬 내용 전체가 아니라 관리에 필요한 정보만 낸다. */
export function catalogSummary({ skills, errors }) {
  return {
    errors,
    skills: skills.map(skill => ({
      id: skill.id, name: skill.name, kind: skill.kind, version: skill.version, origin: skill.origin,
      declaredStatus: skill.declaredStatus, status: skill.effectiveStatus, statusNote: skill.statusNote,
      expertReviewed: skill.expertReviewed, presets: skill.presets, stages: skill.stages, lawSnapshot: skill.lawSnapshot,
      counts: { checks: skill.checks.length, issues: skill.issues.length, elementTrees: skill.elements.length,
        authorities: skill.authorities.reduce((n, law) => n + law.articles.length, 0) },
      snapshotArticles: skill.authorities.reduce((n, law) => n + Object.keys(law.snapshot || {}).length, 0),
      checks: skill.checks.map(c => ({ id: c.id, label: c.label, article: `${c.article.lawName} ${c.article.articleNo}${c.article.unit ? ` ${c.article.unit}` : ''}`,
        ceiling: c.ceiling, numeric: Boolean(c.numeric?.length), closedQuestion: Boolean(c.closedQuestion) })),
      digest: skill.digest
    }))
  };
}
