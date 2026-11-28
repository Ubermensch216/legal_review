import './setup.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV } from '../server/env.js';
import { parseDocument } from '../server/parsers/index.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { createStageCache } from '../server/reasoning/stageCache.js';
import { runReasoningPipeline, PipelineError } from '../server/reasoning/pipeline.js';
import { computeIssueConclusion } from '../server/reasoning/verify/conclusion.js';
import { articleHash, compilePattern, loadSkill, loadSkills, parseFrontmatter, parseSections, skillMode, skillSetDigest, SkillError } from '../server/skills/skillLoader.js';
import { selectSkills, skillAuthoritySeeds, skillPromptFragment } from '../server/skills/skillRouter.js';
import { checkApplies, coverSkillIssues, elementForFinding, findCheckHits, numericViolation, outcomeOf, resolveArticle, sentenceMatches, sentences,
  skillAssessmentsFor, skillGaps } from '../server/skills/skillChecks.js';
import { checkSkillStaleness, skillElementTrees } from '../server/skills/skillElements.js';

const noNetwork = globalThis.fetch;
afterEach(() => { globalThis.fetch = noNetwork; });

const catalog = loadSkills();
const skill = id => catalog.skills.find(s => s.id === id);
const labor = skill('labor-work-rules');
const OFFICIAL = { source: 'OFFICIAL_API' };
const sample = name => path.resolve('test/docs/review-samples', name);

test('스킬 패키지 전체가 형식 오류 없이 적재되고, 검수 기록 없는 새 스킬은 active가 될 수 없다', () => {
  assert.deepEqual(catalog.errors, []);
  assert.ok(catalog.skills.length >= 7);
  for (const s of catalog.skills) {
    assert.ok(s.digest.length === 16, s.id);
    if (s.effectiveStatus === 'active') assert.ok(s.expertReviewed || s.origin === 'migrated', `${s.id}는 검수 또는 이관 근거 없이 active다`);
  }
  assert.equal(labor.effectiveStatus, 'shadow');
  assert.equal(skill('contract-services').origin, 'migrated');
});

test('머리말·절 파서는 YAML 부분집합만 받고 잘못된 형식을 알린다', () => {
  const { meta, body, errors } = parseFrontmatter('---\nid: a\nlist: [x, y]\nnone: null\n---\n## S1 지침\n내용\n## 금지 쟁점\n- 하나');
  assert.deepEqual(errors, []);
  assert.deepEqual(meta, { id: 'a', list: ['x', 'y'], none: null });
  assert.deepEqual(parseSections(body).sections, { 'S1 지침': '내용', '금지 쟁점': '- 하나' });
  assert.equal(parseFrontmatter('본문만').meta, null);
  assert.ok(parseFrontmatter('---\n이상한 줄\n---\n').errors.length);
  assert.throws(() => compilePattern('(열림', 'x', 'y'), SkillError);
});

test('검수 기록 없이 active로 적은 스킬은 shadow로 낮추고, 정규식·참조 오류는 적재 시점에 막는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  const make = (meta, files = {}) => {
    const d = path.join(dir, meta.id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n## S1 지침\n지침\n`);
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(d, name), JSON.stringify(value));
    return d;
  };
  const base = { kind: 'domain', version: '1', presets: ['labor_hr'], stages: ['s1'], lawSnapshot: '2026-11-28', expertReviewed: 'null' };
  assert.equal(loadSkill(make({ ...base, id: 'a', name: 'A', status: 'active' })).effectiveStatus, 'shadow');
  assert.equal(loadSkill(make({ ...base, id: 'b', name: 'B', status: 'active', expertReviewed: '홍길동 2026-11-28' })).effectiveStatus, 'active');
  const check = { id: 'C1', issueId: 'T1', label: 'x', article: { lawName: '법', articleNo: '제1조' }, match: { all: ['('] },
    ceiling: 'REVIEW_POINT', negativeExamples: [] };
  const issue = { id: 'T1', question: '쟁점인가?', type: 'PRIMARY', priority: 'HIGH', articles: [], triggers: { checks: ['C1'] } };
  assert.throws(() => loadSkill(make({ ...base, id: 'c', name: 'C', status: 'shadow' }, { 'checks.json': { checks: [check] }, 'issues.json': { issues: [issue] } })), /정규식/);
  assert.throws(() => loadSkill(make({ ...base, id: 'd', name: 'D', status: 'shadow' },
    { 'checks.json': { checks: [{ ...check, match: { all: ['가'] }, ceiling: 'VIOLATION_RISK' }] }, 'issues.json': { issues: [issue] } })), /닫힌 질문도 숫자 판정도/);
  assert.throws(() => loadSkill(make({ ...base, id: 'e', name: 'E', status: 'shadow' },
    { 'checks.json': { checks: [{ ...check, match: { all: ['가'] }, issueId: 'NONE' }] }, 'issues.json': { issues: [issue] } })), /issues.json에 없습니다/);
});

test('모든 스킬 점검은 자기 양성 예문에 걸리고 음성 예문에는 걸리지 않는다', () => {
  for (const s of catalog.skills) {
    for (const check of s.checks) {
      for (const example of check.positiveExamples || []) {
        const units = check.scope === 'ROW' ? [{ text: example }] : sentences(example);
        assert.ok(units.some(u => checkApplies(check, u.text)), `${s.id}/${check.id} 양성 예문 미적중: ${example}`);
      }
      for (const example of check.negativeExamples) {
        const units = check.scope === 'ROW' ? [{ text: example }] : sentences(example);
        assert.ok(!units.some(u => checkApplies(check, u.text)), `${s.id}/${check.id} 음성 예문 적중: ${example}`);
      }
    }
  }
});

test('숫자 판정은 기준을 넘을 때만 위반 후보가 되고, 상한이 검토 필요면 YES여도 위반 소지로 올리지 않는다', () => {
  const lb01 = labor.checks.find(c => c.id === 'LB-01');
  assert.equal(numericViolation(lb01, '1주 최대 근로시간은 68시간으로 한다.').value, 68);
  assert.equal(numericViolation(lb01, '1주 최대 근로시간은 52시간으로 한다.'), null);
  assert.equal(numericViolation(lb01, '1주 최대 근로시간은 ６８시간으로 한다.').value, 68, '전각 숫자');
  const lb03 = labor.checks.find(c => c.id === 'LB-03');
  assert.equal(numericViolation(lb03, '해고는 7일 전에 예고한다.').value, 7);
  assert.equal(numericViolation(lb03, '해고는 30일 전에 예고한다.'), null);
  assert.equal(outcomeOf('YES', 'VIOLATION_RISK'), 'VIOLATION_RISK');
  assert.equal(outcomeOf('YES', 'REVIEW_POINT'), 'REVIEW_POINT');
  assert.equal(outcomeOf('NO', 'VIOLATION_RISK'), 'CLEARED');
  assert.equal(outcomeOf('UNCLEAR', 'VIOLATION_RISK'), 'REVIEW_POINT');
});

const registryFor = async (file, articles = []) => {
  const parsed = await parseDocument(fs.readFileSync(sample(file)), file);
  return buildEvidenceRegistry({ meta: { asOfDate: '20261128', primaryLawName: '근로기준법' },
    officialEvidence: { lawDetail: { ...OFFICIAL, lawName: '근로기준법' }, articles } }, { documentText: parsed.text });
};

test('사례 01은 알려진 위반 문장을 코드로 찾고, 같은 구조의 준수본(06)에서는 아무 점검도 걸리지 않는다', async () => {
  const hits01 = findCheckHits([labor], await registryFor('01_취업규칙_전부개정안.hwpx'));
  const ids = new Set(hits01.map(h => h.checkId));
  for (const id of ['LB-01', 'LB-02', 'LB-04', 'LB-06', 'LB-07', 'LB-08', 'LB-09', 'LB-11']) assert.ok(ids.has(id), `${id} 미적중`);
  const lb01 = hits01.find(h => h.checkId === 'LB-01' && h.numeric);
  assert.equal(lb01.numeric.value, 68);
  // 인용은 원문의 부분 문자열이어야 한다(원문 대조 규칙).
  const reg = await registryFor('01_취업규칙_전부개정안.hwpx');
  for (const hit of hits01) assert.ok(reg.get(hit.documentId).text.includes(hit.quote), hit.quote);
  assert.deepEqual(findCheckHits([labor], await registryFor('06_취업규칙_준수본.txt')).map(h => `${h.checkId}:${h.quote}`), []);
});

test('스킬 선택: auto는 검수 전 스킬을 진단만 하고, apply는 적용하며, off는 쓰지 않는다', () => {
  const args = { preset: 'labor_hr', query: '취업규칙 검토', documentText: '제1조(목적) 이 취업규칙은 근로시간을 정한다.', catalog };
  const auto = selectSkills({ ...args, llmConfig: { skillMode: 'auto' } });
  assert.deepEqual(auto.applied.map(s => s.id), []);
  assert.ok(auto.shadow.some(s => s.id === 'labor-work-rules'));
  assert.equal(auto.digest, 'none');
  const apply = selectSkills({ ...args, llmConfig: { skillMode: 'apply' } });
  assert.ok(apply.applied.some(s => s.id === 'labor-work-rules'));
  assert.notEqual(apply.digest, 'none');
  assert.equal(apply.digest, skillSetDigest(apply.applied));
  assert.deepEqual(selectSkills({ ...args, llmConfig: { skillMode: 'off' } }).shadow, []);
  assert.equal(selectSkills({ ...args, preset: 'compliance', llmConfig: { skillMode: 'apply' } }).applied.some(s => s.id === 'labor-work-rules'), false);
  assert.equal(skillMode({ skillMode: '이상한 값' }), 'auto');
  // 이관 스킬(origin: migrated)은 선택 대상이 아니다. 원래 코드 경로에서 데이터로만 쓰인다.
  assert.equal(selectSkills({ ...args, preset: 'contract_risk', llmConfig: { skillMode: 'apply' } }).applied.some(s => s.id === 'contract-services'), false);
});

test('조문 씨앗은 when 조건이 맞을 때만 붙고, S1 지침은 도메인 지침 뒤에 금지 쟁점을 붙인다', () => {
  const seeds = skillAuthoritySeeds([labor], { text: '취업규칙' });
  assert.ok(seeds.find(s => s.name === '근로기준법').mainArticles.includes('제94조'));
  assert.equal(seeds.some(s => s.name === '민법'), false);
  assert.ok(skillAuthoritySeeds([labor], { checkHits: [{ checkId: 'LB-08' }] }).some(s => s.name === '민법'));
  const fragment = skillPromptFragment([labor, skill('method-issue-framing')], 's1');
  assert.ok(fragment.startsWith(labor.s1Guidance));
  assert.match(fragment, /세우지 않을 쟁점: .*문서나 개별 조항의 내용이 확인되는지/);
  assert.equal(skillPromptFragment([], 's1'), null);
});

const article94Text = '취업규칙을 변경하는 경우 과반수의 의견을 들어야 한다. 다만, 불리하게 변경하는 경우에는 그 동의를 받아야 한다.';
const context94 = (text = article94Text) => ({
  meta: { primaryLawName: '근로기준법', asOfDate: '20261128', preset: 'labor_hr', dataIntegrity: { hasOfficialArticles: true, warnings: [] } },
  officialEvidence: { lawDetail: { ...OFFICIAL, lawName: '근로기준법' }, articles: [
    { ...OFFICIAL, lawName: '근로기준법', fullArticleNo: '94', title: '규칙의 작성, 변경 절차', enforceDate: '20200101', content: '',
      paragraphs: [{ paragraphNo: '①', content: text }] }], precedents: [], interpretations: [] }
});

/** 시험용 스킬: 제94조 제1항 단서에 대한 점검 하나, 쟁점 서식 하나, 요건 트리 하나. 조문 해시는 시험 본문으로 계산한다. */
function testSkill({ hash = articleHash(`${article94Text}`), status = 'shadow' } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-')), 'test-labor');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nid: test-labor\nname: 시험 노동\nkind: domain\nversion: 0.0.1\npresets: [labor_hr]\nstages: [collect, s1, s1-coverage, s3, s4-checks, s7]\nlawSnapshot: 2026-11-28\nexpertReviewed: null\nstatus: ${status}\n---\n## S1 지침\n시험 지침이다.\n## 사실 질문 안내\n- 없음\n`);
  fs.writeFileSync(path.join(dir, 'authorities.json'), JSON.stringify({ laws: [{ lawName: '근로기준법', role: 'CORE', articles: ['제94조'],
    snapshot: { '제94조': { enforceDate: '20200101', textHash: hash } } }] }));
  fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify({ issues: [{ id: 'T-I1', question: '불리한 변경에 근로자 과반수 동의를 받는가?',
    type: 'PROCEDURAL', priority: 'HIGH', articles: [{ lawName: '근로기준법', articleNo: '제94조', unit: '제1항 단서' }], keywords: [['불리', '불이익'], ['동의']],
    triggers: { checks: ['T-01'] } }] }));
  fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify({ checks: [{ id: 'T-01', issueId: 'T-I1', label: '동의 없는 불이익 변경',
    article: { lawName: '근로기준법', articleNo: '제94조', unit: '제1항 단서' }, match: { all: ['불리|불이익'], any: ['동의 ?없이'] },
    closedQuestion: '동의 없이 불리하게 바꿀 수 있게 하는가?', ceiling: 'VIOLATION_RISK', route: 'USER',
    factQuestions: ['근로자 과반수 동의를 실제로 받았는지 확인해 주십시오.'], negativeExamples: ['불리하게 변경하는 경우 동의를 받는다.'] }] }));
  fs.writeFileSync(path.join(dir, 'elements.json'), JSON.stringify({ articles: [{ lawName: '근로기준법', articleNo: '제94조', textHash: hash, elements: [
    { text: '변경할 때 과반수의 의견을 들어야 한다', mandatory: true, isException: false, operator: 'ALL_OF', unit: '제1항' },
    { text: '불리하게 변경할 때 과반수의 동의를 받아야 한다', mandatory: true, isException: false, operator: 'ALL_OF', unit: '제1항 단서', checks: ['T-01'] }] }] }));
  return loadSkill(dir);
}

test('조문 문언이 스킬 기록과 다르면 그 조문의 점검과 요건 트리를 끄고 경고한다', () => {
  const s = testSkill();
  const same = buildEvidenceRegistry(context94());
  assert.equal(checkSkillStaleness({ skills: [s], registry: same }).disabledChecks.size, 0);
  assert.equal(skillElementTrees({ skills: [s], registry: same }).get('A1').elements[1].sourceIds[0], 'A1.1x');
  const changed = buildEvidenceRegistry(context94(`${article94Text} (개정)`));
  const stale = checkSkillStaleness({ skills: [s], registry: changed });
  assert.ok(stale.disabledChecks.has('test-labor:T-01'));
  assert.match(stale.warnings[0], /조문 문언이 달라졌습니다/);
  assert.equal(skillElementTrees({ skills: [s], registry: changed }).size, 0);
  assert.equal(resolveArticle(same, { lawName: '근로기준법', articleNo: '94', unit: '제1항 단서' }).targetId, 'A1.1x');
});

test('쟁점 보충: 같은 문서 조항·조문을 보는 쟁점이 있으면 잇고, 없으면 스킬 쟁점을 덧붙인다', () => {
  const s = testSkill();
  const registry = buildEvidenceRegistry(context94(), { documentText: '제41조(변경) 불리한 변경도 동의 없이 시행한다.' });
  const finding = { skillId: s.id, checkId: 'T-01', issueTemplateId: 'T-I1', documentId: 'D1', evidenceId: 'A1.1x', articleId: 'A1',
    outcome: 'VIOLATION_RISK', quote: '불리한 변경도 동의 없이 시행한다', label: '동의 없는 불이익 변경', factQuestions: [], answer: 'YES', ceiling: 'VIOLATION_RISK' };
  const unrelated = { facts: [], issues: [{ id: 'I1', question: '임금 지급 시기는 적법한가?', evidenceIds: [], documentIds: ['D9'], dependsOn: [], factIds: [], searchTerms: [] }] };
  const added = coverSkillIssues({ caseIssues: unrelated, skills: [s], findings: [{ ...finding }], registry });
  assert.equal(added.added.length, 1);
  assert.equal(unrelated.issues[1].origin, 'SKILL');
  assert.deepEqual(unrelated.issues[1].documentIds, ['D1']);
  const related = { facts: [], issues: [{ id: 'I1', question: '제41조 불이익 변경 절차는 위반인가?', evidenceIds: ['A1'], documentIds: ['D1'], dependsOn: [], factIds: [], searchTerms: [] }] };
  const linkedFinding = { ...finding };
  const linked = coverSkillIssues({ caseIssues: related, skills: [s], findings: [linkedFinding], registry });
  assert.equal(linked.added.length, 0);
  assert.equal(linkedFinding.issueId, 'I1');
  assert.ok(related.issues[0].evidenceIds.includes('A1.1x'));
  // 해소(NO)된 점검은 쟁점을 만들지 않는다.
  const cleared = { facts: [], issues: [] };
  coverSkillIssues({ caseIssues: cleared, skills: [s], findings: [{ ...finding, outcome: 'CLEARED' }], registry });
  assert.equal(cleared.issues.length, 0);
});

test('주입한 스킬 판정은 원문 인용으로 검증된 위반 소지가 되고, 상한이 검토 필요면 확인 필요로 남는다', () => {
  const registry = buildEvidenceRegistry(context94(), { documentText: '제41조(변경) 불리한 변경도 동의 없이 시행한다.' });
  const elements = [{ id: 'A1.E1', text: '의견 청취', sourceIds: ['A1.1'], mandatory: true, isException: false, operator: 'ALL_OF' },
    { id: 'A1.E2', text: '동의', sourceIds: ['A1.1x'], mandatory: true, isException: false, operator: 'ALL_OF' }];
  const issue = { id: 'I1', skillCheckIds: ['s:T-01'] };
  const base = { skillId: 's', checkId: 'T-01', issueId: 'I1', documentId: 'D1', evidenceId: 'A1.1x', articleId: 'A1',
    quote: '불리한 변경도 동의 없이 시행한다', label: '동의 없는 불이익 변경', factQuestions: ['동의 여부'], answer: 'YES', derivedBy: 'SKILL_CLOSED_QUESTION' };
  assert.equal(elementForFinding(elements, base, registry).id, 'A1.E2');
  const violation = skillAssessmentsFor({ issue, elements, findings: [{ ...base, outcome: 'VIOLATION_RISK', ceiling: 'VIOLATION_RISK' }], registry, documentIds: ['D1'] });
  const a = violation.get('A1.E2');
  assert.equal(a.verdict, 'VIOLATES');
  assert.equal(a.quoteVerified, true);
  assert.equal(computeIssueConclusion(elements, [a], []).compliance, 'VIOLATION_RISK');
  const review = skillAssessmentsFor({ issue, elements, findings: [{ ...base, outcome: 'REVIEW_POINT', ceiling: 'REVIEW_POINT' }], registry, documentIds: ['D1'] });
  assert.equal(review.get('A1.E2').verdict, 'UNCLEAR');
  assert.equal(computeIssueConclusion(elements, [review.get('A1.E2')], []).compliance, 'NEEDS_FACTS');
  const gaps = skillGaps([{ ...base, outcome: 'REVIEW_POINT', ceiling: 'REVIEW_POINT' }], [{ issueId: 'I1', assessments: [review.get('A1.E2')] }]);
  assert.deepEqual(gaps.map(g => g.type), ['FACT_UNKNOWN']);
});

// ── 파이프라인 통합: 가짜 Ollama ──
const reply = content => ({ ok: true, body: (async function* () {
  yield new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop', prompt_eval_count: 500, eval_count: 20 })}\n`);
})() });
function fakeOllama({ closedAnswer = 'YES', closedEvidence = '동의 없이 시행할 수 있다' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: ENV.OLLAMA_MODEL }] }) };
    const prompt = JSON.parse(options.body).messages[1].content;
    calls.push(prompt);
    if (prompt.includes('[과제: 문서 문장 읽기]')) return reply(JSON.stringify({ evidence: closedEvidence, answer: closedAnswer }));
    if (prompt.includes('[과제: 사건 사실과 법률 쟁점 정리]')) return reply(JSON.stringify({ facts: [],
      issues: [{ id: 'I1', question: '제41조 규칙 변경 절차는 적법한가?', type: 'PRIMARY', priority: 'HIGH', dependsOn: [], factIds: [], evidenceIds: ['A1.1'], searchTerms: [] }],
      unknownFacts: [] }));
    if (prompt.includes('[과제: 요건별')) {
      const ids = [...prompt.matchAll(/\[(A1\.E\d+)\]/g)].map(m => m[1]);
      return reply(JSON.stringify({ assessments: [...new Set(ids)].map(elementId => ({ elementId, verdict: 'UNCLEAR', quote: '', evidenceIds: ['A1.1'],
        factIds: [], contraryFactIds: [], analysis: '판단 어려움', openQuestion: '' })), precedents: [], counter: { position: '', evidenceIds: [], response: '' }, narrative: '' }));
    }
    if (prompt.includes('[과제: 근거-주장 대응 확인]')) return reply(JSON.stringify({ label: 'SUPPORTS' }));
    if (prompt.includes('[과제: 종합]')) return reply(JSON.stringify({ summary: '요약', risks: [], recommendations: [] }));
    if (prompt.includes('[과제: 수정 조문 작성]')) return reply(JSON.stringify({ revisedText: '수정', reason: '이유', evidenceIds: [] }));
    return reply('{}');
  };
  return calls;
}
const run = (s, overrides = {}) => runReasoningPipeline({ query: '취업규칙 변경 절차 검토', preset: 'labor_hr',
  documentText: '제41조(규칙 변경) 이 규칙의 불리한 변경도 근로자 동의 없이 시행할 수 있다.', workbenchContext: context94(),
  provider: 'ollama', model: ENV.OLLAMA_MODEL, session: createLlmSession(), clients: { searchPrecedents: async () => [], searchInterpretations: async () => [] },
  embed: async texts => ({ vectors: texts.map(() => [1, 0]), warning: null }),
  cache: createStageCache(path.join(ENV.CACHE_DIR, `skills-${Date.now()}-${Math.random()}.db`)),
  analysisDepth: 'BASIC', skillCatalog: { skills: [s], errors: [] }, ...overrides });

test('apply 방식: 스킬이 찾은 문장을 닫힌 질문으로 판정해 위반 소지로 주입하고, 요건 트리·쟁점 연결·의견서 표기를 남긴다', async () => {
  const calls = fakeOllama({ closedAnswer: 'YES' });
  const review = await run(testSkill(), { skillMode: 'apply' });
  const skills = review.reasoning.skills;
  assert.equal(skills.mode, 'apply');
  assert.deepEqual(skills.findings.map(f => f.outcome), ['VIOLATION_RISK']);
  assert.equal(skills.checkCalls, 1);
  assert.deepEqual(skills.elementTrees, [{ articleId: 'A1', skillId: 'test-labor' }]);
  const issue = review.reasoning.issues[0];
  const injected = issue.assessments.find(a => a.skillCheck);
  assert.equal(injected.verdict, 'VIOLATES');
  assert.equal(injected.quoteVerified, true);
  assert.equal(injected.derivedBy, 'SKILL_CLOSED_QUESTION');
  assert.equal(issue.conclusion.compliance, 'VIOLATION_RISK');
  // 주입한 요건은 모델에게 다시 묻지 않는다.
  const s4 = calls.filter(p => p.includes('[과제: 요건별'));
  assert.ok(s4.every(p => !p.includes(`[${injected.elementId}]`)));
  // S1 공통 접두부에 스킬 지침이 실린다.
  assert.ok(calls.find(p => p.includes('[과제: 사건 사실과 법률 쟁점 정리]')).includes('[쟁점 설정 방향] 시험 지침이다.'));
  assert.match(review.draftOpinion, /\[적용 분석 스킬\] 시험 노동 v0\.0\.1 \(전문가 검수 전\)/);
  // 읽기 질문에는 조문 원문을 싣지 않는다(조문과 함께 물으면 소형 모델이 일괄 NO로 답했다).
  const reading = calls.find(p => p.includes('[과제: 문서 문장 읽기]'));
  assert.ok(reading.includes('불리한 변경도 근로자 동의 없이 시행할 수 있다'), reading);
  assert.ok(!reading.includes('과반수의 의견을 들어야 한다'));
  assert.notEqual(review.reasoning.skillSet.digest, 'none');
  assert.ok(review.reasoning.gaps.some(g => g.question.includes('근로자 과반수 동의를 실제로 받았는지')));
});

test('auto 방식: 검수 전 스킬은 결과를 바꾸지 않고 코드 점검 결과만 진단에 남긴다(닫힌 질문 호출 없음)', async () => {
  const calls = fakeOllama();
  const review = await run(testSkill(), { skillMode: 'auto' });
  assert.equal(review.reasoning.skills.findings.length, 0);
  assert.deepEqual(review.reasoning.skills.shadowFindings.map(f => f.outcome), ['NOT_ASKED']);
  assert.equal(calls.some(p => p.includes('[과제: 문서 문장 읽기]')), false);
  assert.equal(review.reasoning.issues[0].assessments.some(a => a.skillCheck), false);
  assert.equal(review.reasoning.skillSet.digest, 'none');
  assert.doesNotMatch(review.draftOpinion, /적용 분석 스킬/);
});

test('YES라도 근거로 옮긴 표현이 문서 문장에 없으면 확정하지 않고 검토 필요로 낮춘다', async () => {
  fakeOllama({ closedAnswer: 'YES', closedEvidence: '노동조합 합의로 변경한다' });
  const review = await run(testSkill(), { skillMode: 'apply' });
  assert.deepEqual(review.reasoning.skills.findings.map(f => [f.answer, f.outcome]), [['UNCLEAR', 'REVIEW_POINT']]);
  const injected = review.reasoning.issues.flatMap(i => i.assessments).find(a => a.skillCheck);
  assert.equal(injected.verdict, 'UNCLEAR');
});

test('닫힌 질문이 NO면 해소로 기록하고 판정을 주입하지 않는다', async () => {
  fakeOllama({ closedAnswer: 'NO' });
  const review = await run(testSkill(), { skillMode: 'apply' });
  assert.deepEqual(review.reasoning.skills.findings.map(f => f.outcome), ['CLEARED']);
  assert.equal(review.reasoning.issues[0].assessments.some(a => a.skillCheck), false);
});

test('스킬 적용 상태가 바뀐 뒤에는 저장된 쟁점 구조를 재사용하는 재검토를 멈춘다', async () => {
  fakeOllama();
  const first = await run(testSkill(), { skillMode: 'apply' });
  await assert.rejects(run(testSkill(), { skillMode: 'off', previous: { reasoning: first.reasoning, rerunIssueIds: [], knowledgeTargets: new Map() } }),
    err => err instanceof PipelineError && /적용 분석 스킬이 바뀌었습니다/.test(err.message));
});

test('승인된 지식 카드는 관련 스킬의 개정 후보가 되고, 승인 전 카드와 무관한 카드는 후보가 아니다', async () => {
  const { skillRevisionCandidates, catalogSummary } = await import('../server/skills/skillCandidates.js');
  const card = (id, state, citations, title = '취업규칙 불이익 변경', keywords = ['취업규칙', '불이익 변경']) => ({ id, state, approvedAt: `2026-11-2${id.length}`,
    card: { title, issue: '쟁점', keywords, checklist: ['동의 방식 확인'], citations } });
  const result = skillRevisionCandidates({ skills: catalog.skills, cards: [
    card('a', 'APPROVED', [{ lawName: '근로기준법', articleNo: '제94조' }, { lawName: '근로기준법', articleNo: '제96조' }]),
    card('bb', 'APPROVED', [{ lawName: '근로기준법', articleNo: '제60조' }]),
    card('ccc', 'DRAFT', [{ lawName: '근로기준법', articleNo: '제94조' }]),
    card('dddd', 'APPROVED', [{ lawName: '건축법', articleNo: '제11조' }], '건축 허가', ['건축허가', '용도변경']) ] });
  assert.equal(result.approvedCards, 3);
  assert.equal(result.unmatchedCards, 1);
  const first = result.candidates.find(c => c.cardId === 'a');
  assert.equal(first.skillId, 'labor-work-rules');
  assert.equal(first.repeated, true);
  assert.match(first.suggestions.find(s => s.type === 'AUTHORITY_SEED').detail, /제96조/);
  assert.match(result.candidates.find(c => c.cardId === 'bb').suggestions.find(s => s.type === 'CHECK').detail, /제60조/);
  const summary = catalogSummary(catalog);
  const laborRow = summary.skills.find(s => s.id === 'labor-work-rules');
  assert.equal(laborRow.status, 'shadow');
  assert.equal(laborRow.snapshotArticles, laborRow.counts.authorities);
  assert.ok(laborRow.checks.some(c => c.id === 'LB-01' && c.numeric));
});
