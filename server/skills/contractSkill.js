// server/skills/contractSkill.js - 이관 스킬 contract-services의 계약 규칙 데이터 (LLM 호출 없음)
//
// 계약 검토 경로(contract_risk)가 코드에 갖고 있던 규칙(RULES·CLAUSE_CHECKS 등)을 skills/contract-services/contract.json으로 옮겼다.
// 이 모듈은 그 데이터를 원래 코드와 같은 모양(정규식 객체, test 함수)으로 돌려준다. 정규식은 공백 변환 없이 그대로 컴파일한다.
// 계약 검토의 핵심 경로이므로 데이터를 읽지 못하면 조용히 넘어가지 않고 오류를 던진다.
import path from 'node:path';
import { loadSkill, SKILLS_DIR, SkillError } from './skillLoader.js';

let cached = null;

const regex = (source, flags = '') => new RegExp(source, flags);

/** 계약 규칙. 서버 수명 동안 한 번 읽는다. */
export function contractSkillData() {
  if (cached) return cached;
  const skill = loadSkill(path.join(SKILLS_DIR, 'contract-services'));
  const data = skill.contract;
  if (!data?.rules?.length || !data.clauseChecks?.length) throw new SkillError(skill.id, 'contract.json에 rules·clauseChecks가 없습니다');
  cached = {
    skillId: skill.id, version: skill.version, digest: skill.digest,
    rules: data.rules.map(rule => {
      const all = rule.test.all.map(source => regex(source));
      const highIf = rule.risk?.highIf ? regex(rule.risk.highIf) : null;
      return { kind: rule.kind, label: rule.label, question: rule.question, searchTerms: rule.searchTerms, facts: rule.facts,
        test: text => all.every(re => re.test(text)),
        risk: rule.risk?.constant ? () => rule.risk.constant : highIf ? text => (highIf.test(text) ? 'HIGH' : rule.risk.else) : undefined };
    }),
    clauseChecks: data.clauseChecks.map(check => ({ kind: check.kind, title: check.title, present: regex(check.present, check.flags || ''), text: check.text })),
    topicMention: Object.fromEntries(Object.entries(data.topicMention).map(([k, v]) => [k, regex(v)])),
    issueTerms: Object.fromEntries(Object.entries(data.issueTerms).map(([k, v]) => [k, regex(v)])),
    lawSeeds: data.lawSeeds,
    authorityHints: data.authorityHints,
    articleExpectations: data.articleExpectations.map(item => ({ test: regex(item.test), law: item.lawName, article: item.articleNo }))
  };
  return cached;
}
