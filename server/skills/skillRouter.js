// server/skills/skillRouter.js - 검토에 쓸 스킬 고르기와 단계별 조각 공급 (LLM 호출 없음)
//
// 스킬은 코드가 고른다. 로컬 소형 모델에게 스킬 색인을 보여 주고 고르게 하면 입력이 늘고 선택이 매번 바뀐다.
// 고르는 기준: 검토 유형(preset)이 맞고, 문서 성격(documentProfile)이나 키워드가 닿는가.
//
// 방식(skillMode)
//   auto  — 상태가 active인 스킬만 적용한다. shadow 스킬은 코드 점검만 돌려 진단에 남기고 결과에 반영하지 않는다.
//   apply — active와 shadow 스킬을 모두 적용한다(검수 전 스킬은 결과에 그 사실을 표시한다).
//   off   — 스킬을 쓰지 않는다. 기존 코드에서 옮겨 온 데이터(origin: migrated)는 이 설정과 무관하게 원래 경로에서 쓰인다.
import { getSkillCatalog, skillMode as resolveMode, skillSetDigest } from './skillLoader.js';
import { profileDocument } from '../reasoning/documentProfile.js';

const normalize = text => String(text || '').replace(/\s+/g, '');

/** 스킬이 이 검토에 해당하는지와 그 이유. */
export function matchSkill(skill, { preset, profileType, text }) {
  if (!skill.presets.includes(preset) && !skill.presets.includes('*')) return null;
  const reasons = [`검토 유형 ${preset}`];
  if (skill.documentTypes.length && skill.documentTypes.includes(profileType)) reasons.push(`문서 성격 ${profileType}`);
  const compact = normalize(text);
  const hits = skill.keywords.filter(k => compact.includes(normalize(k)));
  if (hits.length) reasons.push(`키워드 ${hits.slice(0, 4).join('·')}`);
  return { reasons, keywordHits: hits.length };
}

/**
 * @param {object} args
 * @param {string} args.preset 검토 유형
 * @param {string} [args.query]
 * @param {string} [args.documentText]
 * @param {object} [args.llmConfig] skillMode를 읽는다
 * @param {object} [args.catalog] 시험용 카탈로그 주입
 * @returns {{ mode: string, applied: object[], shadow: object[], reasons: Record<string,string[]>, digest: string, catalogErrors: string[] }}
 */
export function selectSkills({ preset, query = '', documentText = '', llmConfig = {}, catalog = getSkillCatalog() }) {
  const mode = resolveMode(llmConfig);
  const empty = { mode, applied: [], shadow: [], reasons: {}, digest: 'none', catalogErrors: catalog.errors || [] };
  if (mode === 'off') return empty;
  const profile = profileDocument({ query, documentText });
  const text = `${query}\n${String(documentText).slice(0, 20000)}`;
  const applied = [];
  const shadow = [];
  const reasons = {};
  for (const skill of catalog.skills) {
    if (skill.origin === 'migrated' || skill.effectiveStatus === 'draft') continue;
    const match = matchSkill(skill, { preset, profileType: profile.type, text });
    if (!match) continue;
    reasons[skill.id] = match.reasons;
    if (skill.effectiveStatus === 'active' || mode === 'apply') applied.push(skill);
    else shadow.push(skill);
  }
  return { mode, applied, shadow, reasons, digest: skillSetDigest(applied), catalogErrors: catalog.errors || [], profileType: profile.type };
}

/** 단계에 붙는 스킬만. */
export const skillsFor = (skills, stage) => skills.filter(s => s.stages.includes(stage));

/**
 * 수집 단계 조문 씨앗. lawTermKb의 suggestedLaws와 같은 모양으로 돌려준다.
 * when 조건이 있는 법령은 키워드나 점검 적중이 있을 때만 씨앗이 된다.
 */
export function skillAuthoritySeeds(skills, { text = '', checkHits = [] } = {}) {
  const compact = normalize(text);
  const hitIds = new Set(checkHits.map(h => h.checkId));
  const seeds = [];
  for (const skill of skillsFor(skills, 'collect')) {
    for (const law of skill.authorities) {
      const when = law.when;
      if (when && !(when.keywords || []).some(k => compact.includes(normalize(k))) && !(when.checks || []).some(c => hitIds.has(c))) continue;
      const existing = seeds.find(s => s.name === law.lawName);
      if (existing) existing.mainArticles = [...new Set([...existing.mainArticles, ...law.articles])];
      else seeds.push({ name: law.lawName, mainArticles: [...law.articles], skillId: skill.id, role: law.role });
    }
  }
  return seeds;
}

/**
 * S1 공통 접두부에 실을 쟁점 설정 방향. 적용 스킬이 없으면 null(기존 PRESET_FOCUS를 쓴다).
 * 방법 스킬(kind: method)의 금지 쟁점은 도메인 스킬 지침 뒤에 붙는다.
 */
export function skillPromptFragment(skills, stage = 's1') {
  const relevant = skillsFor(skills, stage);
  if (!relevant.length) return null;
  const domain = relevant.filter(s => s.kind === 'domain');
  const guidance = domain.map(s => s.s1Guidance).filter(Boolean).join('\n');
  const forbidden = [...new Set(relevant.flatMap(s => s.forbiddenIssues))];
  if (!guidance && !forbidden.length) return null;
  return [guidance, forbidden.length ? `세우지 않을 쟁점: ${forbidden.join(' / ')}` : ''].filter(Boolean).join('\n');
}

/** 결과·진행 화면에 남길 스킬 요약. */
export function describeSelection(selection) {
  const row = (skill, applied) => ({ id: skill.id, name: skill.name, version: skill.version, kind: skill.kind,
    status: skill.effectiveStatus, expertReviewed: skill.expertReviewed, applied,
    reasons: selection.reasons[skill.id] || [] });
  return { mode: selection.mode, digest: selection.digest,
    skills: [...selection.applied.map(s => row(s, true)), ...selection.shadow.map(s => row(s, false))],
    catalogErrors: selection.catalogErrors };
}

/** 사용자에게 보이는 한 줄. 검수 전 스킬을 적용했으면 반드시 밝힌다. */
export function selectionLabel(selection) {
  if (!selection.applied.length) return '';
  return selection.applied.map(s => `${s.name} v${s.version}${s.expertReviewed ? '' : ' (전문가 검수 전)'}`).join(', ');
}
