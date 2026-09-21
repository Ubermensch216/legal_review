// server/export/consultingAuditReport.js - 사전 컨설팅감사 의견서 서식 생성기
//
// 지자체 감사기구의 사전 컨설팅감사 의견서는 범용 법률검토의견서와 구성이 다르다.
// 대립 견해(갑설/을설)를 나란히 제시하고, 수용/반려 처리 결과로 끝맺는다.
// 신청서 원문과 검토 결과를 이 서식에 맞춰 조립한다.

const BLANK = '(해당 없음)';

function bullets(items, marker = '○') {
  const list = (items || []).filter(v => typeof v === 'string' && v.trim());
  return list.length ? list.map(v => `${marker} ${v.trim()}`).join('\n') : '';
}

/**
 * 신청서 본문에서 머리말 항목(접수번호·신청기관·건명)을 최대한 복원한다.
 * 찾지 못한 항목은 비워 두고 작성자가 채우도록 남긴다.
 */
export function extractApplicationHeader(documentText = '') {
  const text = String(documentText || '');
  const pick = pattern => (pattern.exec(text)?.[1] || '').replace(/\s+/g, ' ').trim();
  return {
    receiptNo: pick(/접수번호\s*\|?\s*([0-9]{4}-[0-9]+)/),
    applicant: pick(/신청기관\s*\(?부서명\)?\s*\|\s*([^|\n]{2,60}?)\s*\|/),
    subject: pick(/건\s*명\s*\|\s*([^|\n]{2,120}?)\s*\|/)
  };
}

/**
 * 사전 컨설팅감사 의견서 본문(Markdown) 생성
 * @param {object} reviewData - { review, meta, officialEvidence } 형태의 검토 결과
 * @param {string} documentText - 신청서 원문 (머리말 복원용)
 * @returns {string}
 */
export function buildConsultingAuditOpinion(reviewData = {}, documentText = '') {
  const review = reviewData.review || reviewData;
  const evidence = reviewData.officialEvidence || {};
  const header = extractApplicationHeader(documentText);
  const conclusion = review.auditConclusion || {};
  const sections = [];

  sections.push('【 사전 컨설팅감사 의견서 】');
  sections.push([
    `| 접수번호 | ${header.receiptNo || ''} | 신청기관(부서명) | ${header.applicant || ''} |`,
    '| --- | --- | --- | --- |',
    `| 건 명 | ${header.subject || ''} |  |  |`
  ].join('\n'));

  sections.push(`## 1. 사업 개요\n\n${review.facts?.trim() || BLANK}`);

  // 2. 관련 법령 — 실제로 인용한 근거만 싣는다. (수집만 하고 인용하지 않은 자료는 제외)
  const basisLines = (review.legalBasis || [])
    .map(b => {
      const mark = b.verificationStatus && b.verificationStatus !== 'VERIFIED' ? ' ※미검증' : '';
      return `○ 「${b.lawName || ''}」 ${b.articleNo || ''}${b.title ? ` (${b.title})` : ''}${mark}`;
    });
  const ordinanceNames = [...new Set((evidence.ordinanceArticles || []).map(a => a.lawName).filter(Boolean))]
    .map(n => `○ 「${n}」`);
  const adminRuleNames = [...new Set((evidence.adminRuleDetails || []).map(d => d.name).filter(Boolean))]
    .map(n => `○ 「${n}」`);
  sections.push(`## 2. 관련 법령\n\n${[...basisLines, ...ordinanceNames, ...adminRuleNames].join('\n') || BLANK}`);

  // 3. 신청 사유 및 대립되는 의견
  const views = review.opposingViews || [];
  const viewBlocks = views.map(v => {
    const cited = (v.citedBasis || []).filter(Boolean).join(', ');
    return [
      `### ${v.label || '견해'}${v.holder ? ` — ${v.holder}` : ''}`,
      `- 주장: ${v.position || BLANK}`,
      cited ? `- 근거: ${cited}` : '',
      `- 검토: ${v.assessment || BLANK}`,
      `- 판단: **${v.verdict || '미판단'}**`
    ].filter(Boolean).join('\n');
  });
  sections.push([
    '## 3. 사전 컨설팅감사 신청 사유',
    '',
    '### 가. 신청 배경',
    '',
    bullets(review.coreIssues) || BLANK,
    '',
    '### 나. 주요 쟁점 및 대립되는 의견',
    '',
    viewBlocks.length ? viewBlocks.join('\n\n') : BLANK
  ].join('\n'));

  // 4. 검토의견
  const resultLabel = conclusion.result || '미판단';
  const checkBody = [
    `## 4. 검토의견 : "${resultLabel}"`,
    '',
    review.legalOpinion?.trim() || BLANK,
    '',
    '### □ 종합의견',
    '',
    conclusion.reason ? `○ ${conclusion.reason}` : BLANK,
    conclusion.basis ? `○ 근거: ${conclusion.basis}` : '',
    conclusion.guidance ? `○ 후속 조치: ${conclusion.guidance}` : '',
    '',
    `○ **사전 컨설팅감사 결과 : "${resultLabel}"**`
  ].filter(Boolean).join('\n');
  sections.push(checkBody);

  const checks = bullets(review.furtherChecks);
  if (checks) sections.push(`## 5. 추가 확인 필요 사항\n\n${checks}`);

  sections.push([
    '| 본 검토 의견서는 귀 기관(부서)의 서면자료를 바탕으로 업무의 적법성 및 타당성에 대해 조언·자문·권고 등을 하는 것으로서, 위 사안에 국한하여 제공된 것이며 위 업무처리 이외의 용도로 활용할 수 없음을 알려드립니다. |',
    '| --- |'
  ].join('\n'));

  return sections.filter(Boolean).join('\n\n');
}

export default { buildConsultingAuditOpinion, extractApplicationHeader };
