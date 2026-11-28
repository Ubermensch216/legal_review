// public/js/skillsView.js - 분석 스킬: 결과 상단 안내, 설정 화면의 스킬 목록·개정 후보
//
// 스킬은 검색·점검 목록이며 법적 근거가 아니다. 결과 화면에는 어떤 스킬이 적용됐고(검수 전인지 포함)
// 스킬 점검이 무엇을 찾았는지만 보여 준다. 점검이 찾은 문서 문장은 첨부문서 원문 그대로다.

const el = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};

const OUTCOME_LABEL = { VIOLATION_RISK: '위반 소지', REVIEW_POINT: '검토 필요', CLEARED: '해소', NO_AUTHORITY: '공식 조문 미확보',
  NOT_ASKED: '진단만', FAILED: '판정 실패', NOT_EVALUATED: '미평가' };
export const STATUS_LABEL = { active: '사용 중', shadow: '검수 전(진단만)', draft: '작성 중' };
export const MODE_LABEL = { auto: '검수된 스킬만 적용', apply: '검수 전 스킬도 적용', off: '사용 안 함' };

/** 결과 상단의 스킬 안내. 적용한 스킬이 없고 진단 결과도 없으면 숨긴다. */
export function renderSkillBanner(data) {
  const banner = document.getElementById('analysis-skill-banner');
  if (!banner) return;
  const skills = data?.review?.reasoning?.skills;
  const applied = (skills?.skills || []).filter(s => s.applied);
  const findings = skills?.findings || [];
  const shadow = skills?.shadowFindings || [];
  banner.replaceChildren();
  const visible = Boolean(applied.length || shadow.length);
  banner.classList.toggle('hidden', !visible);
  if (!visible) return;

  const body = el('div', 'depth-banner-body');
  if (applied.length) {
    body.append(el('strong', '', `적용 분석 스킬: ${applied.map(s => `${s.name} v${s.version}${s.expertReviewed ? '' : ' (전문가 검수 전)'}`).join(', ')}`));
    const counts = findings.reduce((m, f) => m.set(f.outcome, (m.get(f.outcome) || 0) + 1), new Map());
    body.append(el('span', '', [...counts].map(([k, n]) => `${OUTCOME_LABEL[k] || k} ${n}`).join(' · ') || '문서에서 점검 대상 문장을 찾지 못했습니다'));
    const list = el('ul', 'skill-finding-list');
    for (const f of findings.filter(f => ['VIOLATION_RISK', 'REVIEW_POINT'].includes(f.outcome)).slice(0, 8)) {
      const item = el('li', `skill-finding skill-${f.outcome.toLowerCase()}`);
      item.append(el('span', 'skill-finding-tag', OUTCOME_LABEL[f.outcome]), el('span', '', `${f.label} — ${f.articleLabel}`),
        el('q', 'skill-finding-quote', f.quote));
      list.append(item);
    }
    if (list.childElementCount) body.append(list);
  } else {
    body.append(el('strong', '', '분석 스킬 진단(결과에 반영하지 않음)'),
      el('span', 'depth-banner-left', `검수 전 스킬이 문서에서 점검 대상 문장 ${shadow.length}건을 찾았습니다. 설정에서 '검수 전 스킬도 적용'을 고르면 결과에 반영합니다.`));
  }
  if (skills.staleArticles?.length) body.append(el('span', 'depth-banner-left', `조문 개정으로 끈 스킬 점검: ${skills.staleArticles.map(a => `${a.lawName} ${a.articleNo}`).join(', ')}`));
  body.append(el('span', 'depth-banner-left', '스킬은 검색·점검 목록이며 법적 근거가 아닙니다. 위반 소지는 첨부문서 원문 문장과 공식 조문으로 다시 확인했습니다.'));
  banner.append(body);
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `${res.status}`);
  return data;
}

/** 설정 화면: 스킬 목록과 외부 전문가 지식 카드에서 나온 개정 후보. */
export async function loadSkillsPanel() {
  const catalogBox = document.getElementById('skills-catalog');
  const candidateBox = document.getElementById('skills-candidates');
  if (!catalogBox) return;
  catalogBox.replaceChildren(el('small', 'input-hint', '스킬 목록을 불러오는 중...'));
  try {
    const data = await getJson('/api/law/skills');
    const table = el('table', 'skills-table');
    const head = el('tr');
    for (const h of ['스킬', '상태', '점검', '쟁점', '요건 트리', '조문 지문']) head.append(el('th', '', h));
    table.append(head);
    for (const s of data.skills) {
      const row = el('tr');
      const name = el('td');
      name.append(el('strong', '', s.name), el('small', 'input-hint', ` v${s.version}${s.origin === 'migrated' ? ' · 기존 규칙 이관' : ''}`));
      const status = el('td', `skill-status skill-status-${s.status}`, `${STATUS_LABEL[s.status] || s.status}${s.statusNote ? ` (${s.statusNote})` : ''}`);
      row.append(name, status, el('td', '', String(s.counts.checks)), el('td', '', String(s.counts.issues)),
        el('td', '', String(s.counts.elementTrees)), el('td', '', `${s.snapshotArticles}/${s.counts.authorities}`));
      table.append(row);
    }
    catalogBox.replaceChildren(table);
    if (data.errors?.length) catalogBox.append(el('small', 'input-hint skill-error', `적재 실패: ${data.errors.join(' / ')}`));
  } catch (err) {
    catalogBox.replaceChildren(el('small', 'input-hint skill-error', `스킬 목록을 불러오지 못했습니다: ${err.message}`));
  }
  if (!candidateBox) return;
  try {
    const data = await getJson('/api/law/skills/candidates');
    candidateBox.replaceChildren();
    if (!data.candidates.length) {
      candidateBox.append(el('small', 'input-hint', `승인된 외부 전문가 지식 카드 ${data.approvedCards}건 중 스킬 개정 후보가 없습니다.`));
      return;
    }
    const list = el('ul', 'skill-candidate-list');
    for (const c of data.candidates.slice(0, 20)) {
      const item = el('li');
      item.append(el('strong', '', `${c.repeated ? '[반복] ' : ''}${c.skillName}: ${c.title}`));
      for (const s of c.suggestions) item.append(el('div', 'input-hint', s.detail));
      list.append(item);
    }
    candidateBox.append(el('small', 'input-hint', '후보는 자동으로 반영되지 않습니다. 검토 후 skills/<id>/ 파일에 옮기고 version을 올리십시오.'), list);
  } catch (err) {
    candidateBox.replaceChildren(el('small', 'input-hint skill-error', `개정 후보를 불러오지 못했습니다: ${err.message}`));
  }
}

document.addEventListener('workbench:rendered', event => renderSkillBanner(event.detail));
