// 계약서 문언의 존재와 법적 효력 판단을 분리한다. 이 규칙은 검색 후보를
// 빠뜨리지 않기 위한 것이며 조항의 위법·무효를 판정하지 않는다.

// 계약 규칙 데이터는 skills/contract-services/contract.json에 있다(기존 코드 규칙을 동작 그대로 옮긴 이관 스킬).
// 정규식은 공백 변환 없이 그대로 컴파일한다. 규칙을 바꾸면 스킬 version을 올린다.
import { contractSkillData } from '../skills/contractSkill.js';

const contract = () => contractSkillData();

export const DISPATCH_FACTORS = Object.freeze([
  '발주자의 업무수행에 대한 구속력 있는 지시', '발주자 조직에의 실질적 편입',
  '수급업체의 인력 선발·교육 독자성', '근무시간·휴가·근태 관리 주체',
  '발주자 근로자 업무와의 구별', '업무의 독립적 전문성·기술성', '수급업체의 독립적 조직·설비'
]);

const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
const documentEntries = registry => registry.list(e => e.kind === 'DOCUMENT' && !e.partial);
export function stripFalseDocumentAbsence(value, registry) {
  const pattern = /D\d+(?:\.\d+)?[^.!?\n]{0,80}(?:내용이 없|확인할 수 없|제시되지 않|자료에 포함되지 않|구체적 내용이 없)[^.!?\n]*/g;
  let removed = false;
  const text = String(value || '').replace(pattern, match => {
    const id = match.match(/^D\d+(?:\.\d+)?/)?.[0];
    if (!registry.get(id)) return match;
    removed = true;
    return '';
  }).replace(/[^\S\r\n]{2,}/g, ' ').trim();
  return { text, removed };
}
function tableCells(entry) {
  if (!entry.sourceSpan) return [];
  const rows = [];
  for (const match of entry.text.matchAll(/^\|.*\|$/gm)) {
    const rawCells = match[0].split('|').slice(1, -1);
    if (rawCells.every(cell => /^\s*:?-+:?\s*$/.test(cell))) continue;
    const row = rows.length;
    let offset = match.index + 1;
    rows.push(rawCells.map((raw, column) => {
      const value = raw.trim();
      const start = entry.sourceSpan.start + offset + raw.indexOf(value);
      offset += raw.length + 1;
      return { row, column, value, start, end: start + value.length };
    }));
  }
  return rows.flat();
}
const IP_DIMENSIONS = [
  'BACKGROUND_IP', 'FOREGROUND_IP', 'THIRD_PARTY_IP', 'OPEN_SOURCE',
  'COPYRIGHT_ECONOMIC_RIGHTS', 'MORAL_RIGHTS', 'PATENT_OR_OTHER_IP', 'REUSE_RIGHT'
];
function ipDimensionAudit(text) {
  const source = normalize(text);
  return IP_DIMENSIONS.map(kind => ({ kind, status: kind === 'BACKGROUND_IP' ? 'TRANSFER_RISK_IN_CLAUSE'
    : kind === 'FOREGROUND_IP' && /모든 산출물/.test(source) ? 'NOT_SEPARATED_FROM_BACKGROUND_IP'
      : kind === 'REUSE_RIGHT' && /재사용하지|재사용.{0,8}금지/.test(source) ? 'REUSE_RESTRICTION_IN_CLAUSE'
        : 'NEEDS_FACTS_OR_SEPARATE_REVIEW' }));
}

export function buildContractInventory(registry, query = '') {
  const documents = documentEntries(registry);
  const findings = [];
  for (const entry of documents) {
    const text = normalize(entry.text);
    for (const rule of contract().rules) if (rule.test(text)) findings.push({
      kind: rule.kind, label: rule.label, question: rule.question, searchTerms: rule.searchTerms,
      additionalFactsRequired: rule.facts, documentSupportIds: [entry.id],
      sourceText: entry.text, sourceSpans: entry.sourceSpan
        ? [{ documentId: entry.id, ...entry.sourceSpan, tableCells: tableCells(entry) }] : [],
      facialRisk: rule.risk?.(text) || 'HIGH', legalValidity: 'AUTHORITY_INCOMPLETE',
      ...(rule.kind === 'INTELLECTUAL_PROPERTY' ? { ipDimensions: ipDimensionAudit(entry.text) } : {})
    });
  }
  const allText = documents.map(e => e.text).join('\n');
  const institutionType = /지방자치단체|시청|군청|구청/.test(allText) ? 'LOCAL_GOVERNMENT'
    : /국가기관|중앙행정기관|정부부처/.test(allText) ? 'NATIONAL_GOVERNMENT'
      : /공기업|준정부기관/.test(allText) ? 'PUBLIC_ENTERPRISE_OR_QUASI_GOVERNMENT' : 'UNKNOWN';
  const itContract = /정보시스템|시스템 구축|소프트웨어|용역|SI\b/i.test(`${query}\n${allText}`);
  const missingClauseAudit = contract().clauseChecks.map(check => {
    const present = check.present.test(allText);
    const documentIds = documents.filter(e => present ? check.present.test(e.text)
      : contract().topicMention[check.kind]?.test(e.text)).map(e => e.id);
    const mentioned = documentIds.length > 0;
    const status = present ? 'ADEQUATE' : mentioned ? 'PRESENT_BUT_DEFICIENT'
      : itContract ? 'ABSENT' : 'NOT_APPLICABLE';
    return { kind: check.kind, title: check.title,
      status, documentIds,
      finding: present ? '검토 기준을 충족하는 규정이 확인됨' : mentioned
        ? `${check.title}을 다룬 조항은 있으나 필요한 제한·절차가 충분하지 않음` : '관련 규정이 확인되지 않음',
      recommendation: check.text, suggestedText: check.text };
  });
  missingClauseAudit.push({ kind: 'PERSONAL_DATA_PROCESSING', title: '개인정보 처리·위탁',
    status: /개인정보/.test(allText) ? 'PRESENT_BUT_AMBIGUOUS' : 'NOT_APPLICABLE', documentIds: [],
    suggestedText: '개인정보 처리 여부와 위탁 관계를 확인한 후 필요한 처리·보호 조항을 정한다.' });
  missingClauseAudit.push({ kind: 'SOURCE_CODE_HANDOVER', title: '소스코드 인도', status: itContract ? 'PRESENT_BUT_AMBIGUOUS' : 'NOT_APPLICABLE', documentIds: [],
    suggestedText: '소스코드 인도 필요성, 범위와 시기를 확인한다.' });
  const missingClauseAdditions = missingClauseAudit.filter(item => ['ABSENT', 'PRESENT_BUT_DEFICIENT'].includes(item.status))
    .map((item, index) => ({ id: `M${index + 1}`, kind: item.kind,
      title: `${item.title} ${item.status === 'ABSENT' ? '부재' : '보완 필요'}`,
      classification: item.status, documentSupportIds: item.documentIds,
      reason: item.finding, suggestedText: item.suggestedText }));
  return { findings, missingClauseAdditions, missingClauseAudit,
    regime: { contractNature: { candidates: ['도급', '위임', '혼합계약'], status: 'UNDETERMINED', confidence: 'LOW',
      needsFacts: ['산출물 완성과 업무 수행 중 어느 의무가 중심인지'] },
      termsRegulation: { status: 'NEEDS_FACTS', possible: true,
        needsFacts: ['여러 상대방에게 쓰려고 미리 마련한 정형 계약인지', '각 조항을 개별교섭했는지'] },
      publicProcurement: { institutionType,
        candidateRegimes: institutionType === 'LOCAL_GOVERNMENT' ? ['지방계약 관련 법령']
          : institutionType === 'NATIONAL_GOVERNMENT' ? ['국가계약 관련 법령']
            : institutionType === 'PUBLIC_ENTERPRISE_OR_QUASI_GOVERNMENT' ? ['해당 공공기관 계약규정'] : [],
        needsFacts: institutionType === 'UNKNOWN'
        ? ['발주기관의 법적 유형과 적용 계약규정'] : ['해당 기관에 실제 적용되는 계약규정'] } } };
}

export function attachContractInventory(caseIssues, inventory, registry) {
  const facts = [...caseIssues.facts];
  const issues = [...caseIssues.issues];
  for (const issue of issues) {
    const question = stripFalseDocumentAbsence(issue.question, registry);
    if (question.removed) issue.question = question.text || '계약 조항의 문언상 위험은 무엇인가?';
    issue.documentIds = [...new Set([...(issue.documentIds || []), ...(issue.factIds || [])
      .map(id => facts.find(f => f.id === id)?.docRef).filter(id => id?.startsWith('D'))])];
  }
  const byDocument = new Map();
  for (const finding of inventory.findings) for (const id of finding.documentSupportIds) {
    if (byDocument.has(id)) continue;
    const entry = registry.get(id);
    if (!entry) continue;
    const fact = { id: `DF${id.slice(1)}`, text: entry.text, status: 'CONFIRMED', sourceType: 'DOCUMENT',
      docRef: id, quote: entry.text, quoteVerified: true, textHash: entry.textHash, sourceSpan: entry.sourceSpan };
    facts.push(fact);
    byDocument.set(id, fact.id);
  }
  for (const finding of inventory.findings) {
    const docId = finding.documentSupportIds[0];
    const existing = issues.find(i => i.kind === finding.kind || ((contract().issueTerms[finding.kind]?.test(i.question))
      && !i.contractKinds?.length && ((i.factIds || []).some(id => facts.find(f => f.id === id)?.docRef === docId)
        || !(i.factIds || []).length)));
    const factId = byDocument.get(docId);
    if (existing) {
      existing.factIds = [...new Set([...(existing.factIds || []), factId].filter(Boolean))];
      existing.documentIds = [...new Set([...(existing.documentIds || []), docId])];
      existing.contractKinds = [...new Set([...(existing.contractKinds || []), finding.kind])];
      existing.analysisMode = 'HYBRID';
      existing.evidenceIds = [...new Set([...(existing.evidenceIds || []), ...contractSeedEvidenceIds([finding.kind], registry)])];
    } else {
      issues.push({ id: `I${issues.length + 1}`, question: finding.question, kind: finding.kind,
        contractKinds: [finding.kind], analysisMode: 'HYBRID', type: 'PRIMARY', priority: 'HIGH', dependsOn: [],
        factIds: factId ? [factId] : [], documentIds: [docId], evidenceIds: contractSeedEvidenceIds([finding.kind], registry), searchTerms: finding.searchTerms });
    }
  }
  const unreviewedCandidates = issues.filter(issue => !issue.documentIds?.length)
    .map(issue => ({ question: issue.question, reason: '계약 원문 조항과 연결되지 않아 별도 확인 필요' }));
  const linkedIssues = issues.filter(issue => issue.documentIds?.length);
  for (const issue of linkedIssues) issue.analysisMode ||= 'HYBRID';
  const linkedIds = new Set(linkedIssues.map(issue => issue.id));
  for (const issue of linkedIssues) issue.dependsOn = (issue.dependsOn || []).filter(id => linkedIds.has(id));
  return { ...caseIssues, facts, issues: linkedIssues,
    unreviewedCandidates, contractInventory: inventory };
}

export function contractFactDetails(kind, facts = []) {
  return facts.map(text => ({ text, materiality: kind === 'PERSONNEL_DIRECTION' || kind === 'TERMINATION'
    || kind === 'DISPUTE_WAIVER' ? 'OUTCOME_DETERMINATIVE'
    : kind === 'INTELLECTUAL_PROPERTY' ? 'SCOPE_ONLY'
      : kind === 'DELAY_DAMAGES' || kind === 'LIABILITY' ? 'QUANTIFICATION_ONLY' : 'BACKGROUND' }));
}

export function contractAssessments(issues, issueResults, inventory, registry) {
  return issues.flatMap(issue => {
    const result = issueResults.find(r => r.issueId === issue.id);
    return inventory.findings.filter(f => f.documentSupportIds.some(id => issue.documentIds?.includes(id))
      && (!issue.contractKinds?.length || issue.contractKinds.includes(f.kind))).map(f => {
      const authorityEvidenceIds = [...new Set((result?.assessments || []).flatMap(a => a.evidenceIds || []))]
        .filter(id => registry.get(id)?.official && registry.get(id)?.inForce);
      const legalValidity = result?.stageStatus === 'FAILED' ? 'FAILED' : 'AUTHORITY_INCOMPLETE';
      const additionalFactDetails = contractFactDetails(f.kind, f.additionalFactsRequired);
      return {
        issueId: issue.id, kind: f.kind, label: f.label, analysisMode: issue.analysisMode || 'HYBRID',
        documentSupportIds: f.documentSupportIds,
        documentFinding: f.sourceText, sourceSpans: f.sourceSpans, facialRisk: f.facialRisk,
        legalValidity,
        authorityEvidenceIds,
        additionalFactsRequired: f.additionalFactsRequired,
        additionalFactDetails,
        documentConclusion: { status: 'CONFIRMED', finding: f.sourceText },
        facialRiskConclusion: { status: 'CONFIRMED', level: f.facialRisk, reason: `${f.label} 문언이 확인됨` },
        legalValidityConclusion: { status: legalValidity, reason: legalValidity === 'FAILED'
          ? '요건 판단 단계 실패' : '결론 요건의 공식 근거 검증 대기' },
        ...(f.kind === 'PERSONNEL_DIRECTION' ? { dispatchFactors: DISPATCH_FACTORS.map((question, index) => ({
          question, status: index === 3 ? 'DOCUMENT_INDICATES_DIRECTION' : 'ACTUAL_PRACTICE_UNKNOWN' })),
          actualDispatchStatus: '실제 업무수행 형태 추가 확인 필요' } : {}),
        ...(['DELAY_DAMAGES', 'CONTRACTUAL_PENALTY'].includes(f.kind)
          ? { penaltyClassification: f.kind === 'DELAY_DAMAGES' ? 'LIQUIDATED_DAMAGES' : 'UNCLEAR' } : {}),
        ...(f.kind === 'TERMINATION' ? { legalPaths: [
          { condition: '도급 또는 도급적 요소인 경우', lawName: '민법', articleNo: '673' },
          { condition: '위임 또는 위임적 요소인 경우', lawName: '민법', articleNo: '689' }] } : {}),
        facialAssessment: { risk: f.facialRisk, finding: f.sourceText,
          documentSupportIds: f.documentSupportIds },
        legalAssessment: { status: legalValidity, authorityEvidenceIds },
        ...(f.ipDimensions ? { ipDimensions: f.ipDimensions } : {})
      };
    });
  });
}

export function scoreContractRisk(finding, { institutionType = 'UNKNOWN' } = {}) {
  const strongEconomics = ['CONTRACTUAL_PENALTY', 'LIABILITY', 'DELAY_DAMAGES', 'TERMINATION'].includes(finding.kind);
  const strongOperations = finding.kind === 'PERSONNEL_DIRECTION';
  const verified = Boolean(finding.authorityEvidenceIds?.length);
  const institutionUnknown = finding.kind === 'PAYMENT_TERMS' && institutionType === 'UNKNOWN';
  const axes = {
    facialImbalance: finding.facialRisk === 'HIGH' ? 'HIGH' : 'MEDIUM',
    statutoryConflict: verified && !institutionUnknown ? 'MEDIUM' : 'UNRATED',
    economicExposure: strongEconomics ? 'HIGH' : 'MEDIUM',
    operationalRisk: strongOperations ? 'HIGH' : 'MEDIUM',
    confidence: verified ? 'HIGH' : finding.documentSupportIds?.length ? 'MEDIUM' : 'LOW'
  };
  const significant = Object.entries(axes).some(([axis, level]) => axis !== 'confidence' && level === 'HIGH');
  return { ...axes, finalLevel: !verified ? (significant ? 'HIGH_CANDIDATE' : 'UNRATED_NEEDS_AUTHORITY')
    : significant ? 'HIGH' : 'MEDIUM',
  contractualRisk: finding.facialRisk,
  legalInvalidityRisk: institutionUnknown ? 'UNRATED' : axes.statutoryConflict };
}

export const contractLawSeeds = findings => {
  const kinds = new Set(findings.map(f => f.kind));
  const seeds = [];
  for (const seed of contract().lawSeeds) {
    if (!seed.whenKinds.some(kind => kinds.has(kind))) continue;
    const existing = seeds.find(s => s.name === seed.lawName);
    if (existing) existing.articles = [...new Set([...existing.articles, ...seed.articles])];
    else seeds.push({ name: seed.lawName, articles: [...seed.articles] });
  }
  return seeds;
};

export function detectContractLawSeeds(documentText) {
  const text = normalize(documentText);
  return contractLawSeeds(contract().rules.filter(rule => rule.test(text)).map(rule => ({ kind: rule.kind })));
}

export function contractSeedEvidenceIds(kinds, registry) {
  const hints = kinds.flatMap(kind => contract().authorityHints[kind] || []);
  return registry.list(e => e.kind === 'ARTICLE' && e.official && e.inForce
    && hints.some(([name, articles]) => e.lawName === name && articles.includes(String(e.articleNo)))).map(e => e.id);
}
