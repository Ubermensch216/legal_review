// server/skills/skillLoader.js - 법령 분석 스킬 패키지 적재·검증 (LLM 호출 없음)
//
// 스킬은 skills/<id>/ 디렉터리 하나다. SKILL.md(머리말 + 단계별 지침 조각)와 JSON 데이터 파일로 이루어진다.
// 형식과 작성 규칙은 skills/skills.md에 있다. 여기서는
//   - 머리말·절을 읽고 JSON을 스키마로 검증한다(새 의존성 없이 YAML 부분집합만 읽는다),
//   - 정규식을 미리 컴파일한다(잘못된 정규식은 적재 시점에 오류로 알린다),
//   - 스킬 내용 해시를 계산한다(재검토 재사용·진단에 쓴다),
//   - 검수되지 않은 스킬이 'active'로 적혀 있으면 'shadow'로 낮춘다.
// 스킬은 법적 근거가 아니다. 조문 번호는 검색 씨앗과 점검 목록일 뿐이며, 의견서 근거는 지금처럼
// 공식 본문을 확보하고 근거 검증을 통과한 것만 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateSchema } from '../reasoning/schemas.js';

export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');
export const SKILL_STAGES = Object.freeze(['collect', 's1', 's1-coverage', 's3', 's4-checks', 's7']);
export const SKILL_STATUS = Object.freeze(['draft', 'shadow', 'active']);
export const SKILL_MODES = Object.freeze(['auto', 'apply', 'off']);
const S1_FRAGMENT_LIMIT = 600;

/** 근거 등록부(evidenceRegistry)가 조문 원문에 붙이는 해시와 같은 방식. 개정 감지에 쓴다. */
export const articleHash = text => createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
const digestOf = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16);

export class SkillError extends Error {
  constructor(skillId, message) { super(`[스킬 ${skillId}] ${message}`); this.name = 'SkillError'; this.skillId = skillId; }
}

// ── SKILL.md 읽기 ─────────────────────────────────────────────

const scalar = raw => {
  const value = raw.trim();
  if (value === 'null' || value === '') return null;
  if (value === 'true' || value === 'false') return value === 'true';
  return value.replace(/^["']|["']$/g, '');
};

/** `key: value`, `key: [a, b]`만 읽는 YAML 부분집합. 그 밖의 문법은 오류로 알린다. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text || ''));
  if (!match) return { meta: null, body: String(text || ''), errors: ['머리말(--- … ---)이 없습니다'] };
  const meta = {};
  const errors = [];
  for (const [n, line] of match[1].split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) { errors.push(`머리말 ${n + 1}행을 읽을 수 없습니다: ${line.slice(0, 40)}`); continue; }
    const [, key, raw] = kv;
    meta[key] = /^\[.*\]$/.test(raw.trim())
      ? raw.trim().slice(1, -1).split(',').map(scalar).filter(v => v !== null)
      : scalar(raw);
  }
  return { meta, body: String(text).slice(match[0].length), errors };
}

/** `## 제목` 단위로 본문 절을 나눈다. 같은 제목이 두 번 나오면 오류다. */
export function parseSections(body) {
  const sections = {};
  const errors = [];
  let current = null;
  for (const line of String(body || '').split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      if (Object.hasOwn(sections, current)) errors.push(`절 '${current}'이(가) 두 번 나옵니다`);
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return { sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()])), errors };
}

const bulletLines = text => String(text || '').split(/\r?\n/).map(l => l.replace(/^\s*-\s+/, '').trim()).filter(Boolean);

// ── 데이터 스키마 ─────────────────────────────────────────────

const str = maxLength => ({ type: 'string', ...(maxLength ? { maxLength } : {}) });
const list = (items, maxItems) => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const articleRef = obj({ lawName: str(60), articleNo: str(16), unit: str(24) }, ['lawName', 'articleNo']);

export const SKILL_SCHEMAS = Object.freeze({
  authorities: obj({
    snapshotAt: str(10),
    laws: list(obj({ lawName: str(60), articles: list(str(16)), role: { type: 'string', enum: ['CORE', 'SUPPORT'] },
      when: obj({ keywords: list(str(30)), checks: list(str(16)) }),
      snapshotPolicy: { type: 'string', enum: ['HASH', 'NONE'] },
      snapshot: { type: 'object' }, note: str(200) }, ['lawName', 'articles', 'role']))
  }, ['laws']),
  issues: obj({ issues: list(obj({
    id: str(16), question: str(200), type: { type: 'string', enum: ['THRESHOLD', 'PRIMARY', 'DEPENDENT', 'PROCEDURAL', 'REMEDY', 'INTERPRETATION'] },
    priority: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] }, articles: list(articleRef),
    searchTerms: list(str(30), 4), keywords: list(list(str(20))),
    triggers: obj({ checks: list(str(16)), keywords: list(list(str(20))) })
  }, ['id', 'question', 'type', 'priority', 'articles', 'triggers'])) }, ['issues']),
  checks: obj({ checks: list(obj({
    id: str(16), issueId: str(16), label: str(40), article: articleRef,
    scope: { type: 'string', enum: ['SENTENCE', 'ROW'] },
    match: obj({ all: list(str(200)), any: list(str(200)), none: list(str(200)) }),
    numeric: list(obj({ pattern: str(200), violatesIf: str(12), unit: str(12), note: str(80) }, ['pattern', 'violatesIf'])),
    numericDecides: { type: 'boolean' },
    closedQuestion: str(160),
    ceiling: { type: 'string', enum: ['VIOLATION_RISK', 'REVIEW_POINT'] },
    route: { type: 'string', enum: ['USER', 'EXTERNAL_INQUIRY'] },
    factQuestions: list(str(160)), legalQuestion: str(200),
    positiveExamples: list(str(300)), negativeExamples: list(str(300)), note: str(200)
  }, ['id', 'issueId', 'label', 'article', 'match', 'ceiling', 'negativeExamples'])) }, ['checks']),
  elements: obj({ articles: list(obj({
    lawName: str(60), articleNo: str(16), textHash: str(16), burden: str(120),
    elements: list(obj({ text: str(160), mandatory: { type: 'boolean' }, isException: { type: 'boolean' },
      operator: { type: 'string', enum: ['ALL_OF', 'ANY_OF', 'EXCEPTION', 'ALTERNATIVE'] }, logicGroup: str(24),
      unit: str(24), checks: list(str(16)) }, ['text', 'mandatory', 'isException', 'operator', 'unit']))
  }, ['lawName', 'articleNo', 'textHash', 'elements'])) }, ['articles']),
  gold: obj({ positiveCases: list(str(8)), controlCases: list(str(8)), note: str(300) }, ['positiveCases', 'controlCases']),
  contract: { type: 'object' }
});

const META_REQUIRED = ['id', 'name', 'kind', 'version', 'presets', 'stages', 'lawSnapshot', 'status'];

/** 정규식 문자열을 컴파일한다. 공백은 '\s*'로 너그럽게 맞춘다(문서마다 띄어쓰기가 다르다). */
export function compilePattern(source, skillId, where) {
  try { return new RegExp(String(source).replace(/ \?/g, '\\s*').replace(/ /g, '\\s*'), 'u'); }
  catch (err) { throw new SkillError(skillId, `${where}의 정규식 '${source}'이(가) 올바르지 않습니다: ${err.message}`); }
}

const COMPARATOR = /^(>=|<=|>|<|==)\s*(\d+(?:\.\d+)?)$/;
export function compileComparator(expr, skillId, where) {
  const m = COMPARATOR.exec(String(expr).trim());
  if (!m) throw new SkillError(skillId, `${where}의 비교식 '${expr}'은(는) '> 12' 형식이어야 합니다`);
  const limit = Number(m[2]);
  const test = { '>': v => v > limit, '>=': v => v >= limit, '<': v => v < limit, '<=': v => v <= limit, '==': v => v === limit }[m[1]];
  return { op: m[1], limit, test };
}

function compileChecks(checks, skillId) {
  return checks.map(check => ({
    ...check,
    scope: check.scope || 'SENTENCE',
    route: check.route || 'USER',
    compiled: {
      all: (check.match.all || []).map((s, i) => compilePattern(s, skillId, `${check.id}.match.all[${i}]`)),
      any: (check.match.any || []).map((s, i) => compilePattern(s, skillId, `${check.id}.match.any[${i}]`)),
      none: (check.match.none || []).map((s, i) => compilePattern(s, skillId, `${check.id}.match.none[${i}]`)),
      numeric: (check.numeric || []).map((n, i) => ({ ...n, re: compilePattern(n.pattern, skillId, `${check.id}.numeric[${i}]`),
        cmp: compileComparator(n.violatesIf, skillId, `${check.id}.numeric[${i}]`) }))
    }
  }));
}

const readJson = (dir, name, skillId) => {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new SkillError(skillId, `${name}을(를) JSON으로 읽을 수 없습니다: ${err.message}`); }
};

/**
 * 스킬 하나를 적재한다. 형식 오류는 SkillError로 던진다(조용히 일부만 쓰지 않는다).
 * @returns {object} 스킬 객체. effectiveStatus는 검수 규칙을 적용한 실제 상태다.
 */
export function loadSkill(dir) {
  const fallbackId = path.basename(dir);
  const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const { meta, body, errors: metaErrors } = parseFrontmatter(raw);
  if (!meta) throw new SkillError(fallbackId, metaErrors.join(' / '));
  const id = meta.id || fallbackId;
  const errors = [...metaErrors];
  for (const key of META_REQUIRED) if (meta[key] === undefined || meta[key] === null) errors.push(`머리말 '${key}' 누락`);
  if (meta.id && meta.id !== fallbackId) errors.push(`머리말 id '${meta.id}'가 디렉터리 이름 '${fallbackId}'과 다릅니다`);
  if (meta.kind && !['domain', 'method'].includes(meta.kind)) errors.push(`kind는 domain 또는 method여야 합니다`);
  if (meta.status && !SKILL_STATUS.includes(meta.status)) errors.push(`status는 ${SKILL_STATUS.join('/')} 중 하나여야 합니다`);
  for (const stage of meta.stages || []) if (!SKILL_STAGES.includes(stage)) errors.push(`알 수 없는 단계 '${stage}'`);
  for (const key of ['presets', 'stages', 'documentTypes', 'keywords']) {
    if (meta[key] !== undefined && meta[key] !== null && !Array.isArray(meta[key])) errors.push(`머리말 '${key}'는 [a, b] 목록이어야 합니다`);
  }
  const { sections, errors: sectionErrors } = parseSections(body);
  errors.push(...sectionErrors);
  if (sections['S1 지침'] && sections['S1 지침'].length > S1_FRAGMENT_LIMIT)
    errors.push(`'S1 지침'이 ${S1_FRAGMENT_LIMIT}자를 넘습니다(${sections['S1 지침'].length}자)`);
  if (errors.length) throw new SkillError(id, errors.join(' / '));

  const data = {};
  for (const name of ['authorities', 'issues', 'checks', 'elements', 'gold', 'contract']) {
    const value = readJson(dir, `${name}.json`, id);
    if (value === null) continue;
    const problems = validateSchema(SKILL_SCHEMAS[name], value);
    if (problems.length) throw new SkillError(id, `${name}.json 형식 오류: ${problems.slice(0, 4).join(' / ')}`);
    data[name] = value;
  }
  const checks = compileChecks(data.checks?.checks || [], id);
  const issues = data.issues?.issues || [];
  const issueIds = new Set(issues.map(i => i.id));
  for (const check of checks) {
    if (!issueIds.has(check.issueId)) throw new SkillError(id, `점검 ${check.id}의 쟁점 ${check.issueId}가 issues.json에 없습니다`);
    if (check.ceiling === 'VIOLATION_RISK' && !check.closedQuestion && !check.numeric?.length)
      throw new SkillError(id, `점검 ${check.id}는 위반 소지까지 올릴 수 있는데 닫힌 질문도 숫자 판정도 없습니다`);
  }
  const checkIds = new Set(checks.map(c => c.id));
  for (const issue of issues) for (const ref of issue.triggers.checks || []) {
    if (!checkIds.has(ref)) throw new SkillError(id, `쟁점 ${issue.id}의 발동 점검 ${ref}가 checks.json에 없습니다`);
  }

  // 검수 규칙: 새로 쓴 내용은 전문가 검수 기록이 있어야 active다. 기존 코드 규칙을 동작 그대로 옮긴 스킬(origin: migrated)은
  // 이미 회귀 시험이 그 동작을 지키므로 예외로 둔다.
  const declared = meta.status;
  const reviewed = Boolean(meta.expertReviewed);
  const migrated = meta.origin === 'migrated';
  const effectiveStatus = declared === 'active' && !reviewed && !migrated ? 'shadow' : declared;
  const statusNote = effectiveStatus !== declared ? '전문가 검수 기록이 없어 shadow로 낮춤' : '';

  const content = { meta, sections, data };
  return {
    id, name: meta.name, kind: meta.kind, version: String(meta.version), origin: meta.origin || 'authored',
    presets: meta.presets || [], documentTypes: meta.documentTypes || [], keywords: meta.keywords || [],
    stages: meta.stages || [], lawSnapshot: meta.lawSnapshot, expertReviewed: meta.expertReviewed ?? null,
    declaredStatus: declared, effectiveStatus, statusNote, dir,
    sections, s1Guidance: sections['S1 지침'] || '', forbiddenIssues: bulletLines(sections['금지 쟁점']),
    s4Guidance: sections['S4 점검 지침'] || '', factGuidance: bulletLines(sections['사실 질문 안내']),
    authorities: data.authorities?.laws || [], issues, checks, elements: data.elements?.articles || [],
    gold: data.gold || null, contract: data.contract || null,
    digest: digestOf(content)
  };
}

/**
 * 스킬 디렉터리 전체를 적재한다. 한 스킬의 오류가 다른 스킬을 막지 않게 오류를 따로 모은다.
 * @returns {{ skills: object[], errors: string[] }}
 */
export function loadSkills({ dir = SKILLS_DIR } = {}) {
  const skills = [];
  const errors = [];
  if (!fs.existsSync(dir)) return { skills, errors };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) continue;
    try { skills.push(loadSkill(path.join(dir, entry.name))); }
    catch (err) { errors.push(err.message); }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { skills, errors };
}

let catalog = null;
/** 서버 수명 동안 한 번 적재한 카탈로그. 시험은 resetSkillCatalog로 다시 읽는다. */
export function getSkillCatalog() {
  if (!catalog) {
    catalog = loadSkills();
    for (const error of catalog.errors) console.warn(`[Skills] 적재 실패: ${error}`);
  }
  return catalog;
}
export function resetSkillCatalog(value = null) { catalog = value; }
export const findSkill = id => getSkillCatalog().skills.find(s => s.id === id) || null;

/** 이 검토에 적용할 스킬 방식. 요청값 → REVIEW_SKILLS → auto 순이다. 알 수 없는 값은 auto다. */
export function skillMode(llmConfig = {}) {
  const value = String(llmConfig.skillMode || process.env.REVIEW_SKILLS || 'auto').trim().toLowerCase();
  return SKILL_MODES.includes(value) ? value : 'auto';
}

/** 적용한 스킬 집합의 지문. 재검토 재사용 판정과 결과 기록에 쓴다. 스킬을 쓰지 않았으면 'none'. */
export function skillSetDigest(skills = []) {
  if (!skills.length) return 'none';
  return digestOf(skills.map(s => `${s.id}@${s.version}:${s.digest}`).sort().join('|'));
}
