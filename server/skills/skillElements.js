// server/skills/skillElements.js - 스킬 요건 트리 공급과 조문 개정 감지 (LLM 호출 없음)
//
// 스킬은 작성 당시 조문 문언에 기대어 점검·요건 트리를 쓴다. 실행할 때 공식 본문의 해시가 기록과 다르면
// 조문이 개정됐거나 다른 시점 본문이므로, 그 조문에 걸린 점검과 요건 트리를 끄고 경고한다.
// 등록부에 그 조문이 없으면(수집 실패 등) 비교할 수 없으므로 끄지 않는다. 그런 점검은 어차피 근거가 없어
// 결과에 반영되지 않는다(skillChecks의 NO_AUTHORITY).
import { normalizedLawName } from '../law/evidence.js';
import { normalizeArticleNo } from '../law/lawArticleRef.js';
import { resolveArticle } from './skillChecks.js';
import { skillsFor } from './skillRouter.js';

const key = (lawName, articleNo) => `${normalizedLawName(lawName)}|${normalizeArticleNo(articleNo)}`;

/**
 * @returns {{ staleArticles: object[], disabledChecks: Set<string>, warnings: string[], verifiedArticles: number }}
 */
export function checkSkillStaleness({ skills, registry }) {
  const staleArticles = [];
  const disabledChecks = new Set();
  const warnings = [];
  let verifiedArticles = 0;
  const articles = new Map(registry.list(e => e.kind === 'ARTICLE' && !e.parentId).map(e => [key(e.lawName, e.articleNo), e]));
  for (const skill of skills) {
    const stale = new Set();
    for (const law of skill.authorities) {
      for (const [articleNo, snap] of Object.entries(law.snapshot || {})) {
        const entry = articles.get(key(law.lawName, articleNo));
        if (!entry || !snap?.textHash) continue;
        if (entry.textHash === snap.textHash) { verifiedArticles++; continue; }
        stale.add(key(law.lawName, articleNo));
        staleArticles.push({ skillId: skill.id, lawName: law.lawName, articleNo, recorded: snap.enforceDate || null,
          current: entry.enforceDate || null, registryId: entry.id });
      }
    }
    for (const check of skill.checks) {
      if (stale.has(key(check.article.lawName, check.article.articleNo))) disabledChecks.add(`${skill.id}:${check.id}`);
    }
    if (stale.size) {
      warnings.push(`분석 스킬 '${skill.name}' 작성 이후 조문 문언이 달라졌습니다(${[...stale].map(k => k.replace('|', ' 제') + '조').join(', ')}). `
        + '해당 조문에 걸린 스킬 점검과 요건 트리를 끄고 기존 분석으로 처리했습니다.');
    }
  }
  return { staleArticles, disabledChecks, warnings, verifiedArticles };
}

/**
 * 검수된 요건 트리를 S3 결과 형태로 돌려준다. 공식 원문 해시가 기록과 같을 때만 쓴다.
 * @returns {Map<string, { elements: object[], burden: string, source: 'SKILL', skillId: string }>} 등록부 조문 ID → 요건
 */
export function skillElementTrees({ skills, registry }) {
  const result = new Map();
  for (const skill of skillsFor(skills, 's3')) {
    for (const tree of skill.elements) {
      const resolved = resolveArticle(registry, { lawName: tree.lawName, articleNo: tree.articleNo });
      if (!resolved || resolved.article.textHash !== tree.textHash || result.has(resolved.articleId)) continue;
      const articleId = resolved.articleId;
      const elements = tree.elements.map((e, n) => {
        const unit = resolveArticle(registry, { lawName: tree.lawName, articleNo: tree.articleNo, unit: e.unit });
        return { id: `${articleId}.E${n + 1}`, text: e.text, mandatory: e.mandatory, isException: e.isException,
          operator: e.operator, logicGroup: e.logicGroup || '', relevance: 'UNASSESSED',
          sourceIds: [unit?.targetId || articleId], skillChecks: e.checks || [], origin: 'SKILL', skillId: skill.id };
      });
      result.set(articleId, { elements, burden: tree.burden || '', source: 'SKILL', skillId: skill.id });
    }
  }
  return result;
}
