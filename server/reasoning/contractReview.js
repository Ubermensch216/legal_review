// 계약서 문언의 존재와 법적 효력 판단을 분리한다. 이 규칙은 검색 후보를
// 빠뜨리지 않기 위한 것이며 조항의 위법·무효를 판정하지 않는다.

const RULES = [
  { kind: 'SCOPE_CHANGE', label: '무보상 과업 변경', test: t => /과업.{0,25}(추가|변경)/.test(t) && /증액 없이|이의를 제기할 수 없|추가.{0,15}비용.{0,10}부담/.test(t),
    question: '일방적인 과업 변경과 비용 전가 조항의 위험은 무엇인가?', searchTerms: ['과업 변경 대가', '약관 불공정 조항'], facts: ['표준계약서로 반복 사용되는지', '해당 조항을 개별교섭했는지'] },
  { kind: 'DELAY_DAMAGES', label: '지체상금', test: t => /지체상금/.test(t),
    risk: t => /상한.{0,12}두지|위약벌|1천분의 3/.test(t) ? 'HIGH' : 'MEDIUM',
    question: '지체상금 약정의 성격과 범위는 무엇인가?', searchTerms: ['지체상금 손해배상액 예정', '민법 제398조'], facts: ['지체의 원인과 실제 이행 경과'] },
  { kind: 'CONTRACTUAL_PENALTY', label: '별도 위약벌', test: t => /위약벌/.test(t),
    risk: t => /3배|상한.{0,12}두지|별도/.test(t) ? 'HIGH' : 'MEDIUM',
    question: '별도 위약벌 약정의 성격과 과도성 위험은 무엇인가?', searchTerms: ['진정한 위약벌 민법 제103조', '위약벌 손해배상액 예정 구별'], facts: ['위약벌 조항의 개별교섭 여부', '위반에 따른 상대방의 이익과 손해'] },
  { kind: 'TERMINATION', label: '임의해지 및 정산', test: t => /해지|해제/.test(t) && /기성|투입.{0,10}비용|대가.{0,10}지급하지/.test(t),
    question: '귀책 여부와 무관한 해지 및 기성 미지급 조항의 위험은 무엇인가?', searchTerms: ['도급인 임의해제 민법 제673조', '약관 해지권 제9조'], facts: ['계약의 도급·위임·혼합 성격', '표준약관 및 개별교섭 여부'] },
  { kind: 'LIABILITY', label: '면책 및 무한책임', test: t => /책임을 지지|면책/.test(t) && /전액|한도|귀책사유/.test(t),
    question: '일방 면책과 상대방의 무한책임 조항의 위험은 무엇인가?', searchTerms: ['약관 면책조항 제7조', '손해배상 위험 전가'], facts: ['표준약관 및 개별교섭 여부', '실제 사고와 귀책관계'] },
  { kind: 'INTELLECTUAL_PROPERTY', label: '기존 지식재산 귀속',
    test: t => /지식재산권|저작권|산출물/.test(t) && /(기존|범용).{0,90}(갑.{0,12}귀속|원시적으로 귀속|양도|재사용하지|재사용.{0,8}금지)/.test(t),
    question: '기존 자산까지 포함한 지식재산 귀속과 재사용 금지의 위험은 무엇인가?', searchTerms: ['저작권 양도 기존 프로그램', '저작인격권 제14조'], facts: ['기존 자산과 신규 산출물의 목록', '제3자·오픈소스 라이선스'] },
  { kind: 'PERSONNEL_DIRECTION', label: '직접 인력 지휘', test: t => /직접.{0,20}(근태|지휘|관리|업무|교체)|근무시간.{0,10}관리|휴가.{0,10}승인/.test(t),
    question: '발주자의 직접 인력 지휘 조항은 어떤 파견·도급 위험을 만드는가?', searchTerms: ['근로자파견 지휘 명령', '도급 파견 구별'], facts: ['현장에서 실제 업무방법·근무시간·휴가를 누가 지시하는지'] },
  { kind: 'VENUE_AGREEMENT', label: '전속관할 합의', test: t => /전속.{0,5}관할|전속관할/.test(t),
    risk: () => 'MEDIUM', question: '전속관할 합의의 효력과 범위는 무엇인가?',
    searchTerms: ['민사소송법 제29조 합의관할'], facts: ['합의가 서면인지', '관할 대상 법률관계가 특정되었는지'] },
  { kind: 'DISPUTE_WAIVER', label: '분쟁절차 포기', test: t => /(이의신청|분쟁조정).{0,50}(포기|진행하지 아니|하지 않는다)/.test(t),
    risk: t => /진행하지 아니|포기/.test(t) ? 'HIGH' : 'MEDIUM',
    question: '법정 또는 행정상 분쟁해결절차의 사전 포기 효력은 무엇인가?', searchTerms: ['공공계약 분쟁조정 이의신청'], facts: ['발주기관의 법적 유형과 적용 계약규정'] },
  { kind: 'PAYMENT_TERMS', label: '대금 지급 조건', test: t => /지급 일정|잔금|기성금|선금|검수 완료 후.{0,12}일/.test(t),
    risk: t => /90일|인정하는 경우에만/.test(t) ? 'HIGH' : 'MEDIUM',
    question: '대금 지급 시기와 검사 조건의 위험은 무엇인가?', searchTerms: ['공공계약 대금 지급 기한', '검수 대금 지급'], facts: ['발주기관의 법적 유형을 확인해 주십시오.'] }
];

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
const ISSUE_TERMS = {
  SCOPE_CHANGE: /과업|업무 범위/, DELAY_DAMAGES: /지체상금/, CONTRACTUAL_PENALTY: /위약벌|위약금/,
  TERMINATION: /해지|해제/, LIABILITY: /면책|손해배상|무한책임/, INTELLECTUAL_PROPERTY: /지식재산|산출물|저작권|기존 자산/,
  PERSONNEL_DIRECTION: /근태|지휘|파견|인력 관리/, VENUE_AGREEMENT: /전속관할|합의관할/,
  DISPUTE_WAIVER: /분쟁|이의신청|조정 절차/,
  PAYMENT_TERMS: /대금|지급|잔금|선금|기성/
};

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

const CLAUSE_CHECKS = [
  { kind: 'CONFIDENTIALITY', title: '비밀유지 조항',
    present: /(비밀.?정보|기밀).{0,80}(누설하지|공개하지|목적 외|사용하지)|비밀유지.{0,80}(의무|하여야|한다)/,
    text: '당사자는 계약 수행 중 알게 된 상대방의 비밀정보를 계약 목적 외로 사용하거나 제3자에게 공개하지 않는다. 예외, 보호기간, 반환·파기 및 법령상 공개 의무는 별도로 정한다.' },
  { kind: 'INFORMATION_SECURITY', title: '정보보안 의무', present: /접근통제|보안대책|보안 조치|암호화|정보보호 의무/,
    text: '을은 합의한 보안 기준에 따라 접근권한, 저장·전송 보호 및 취약점 조치를 이행하고 증빙을 제공한다.' },
  { kind: 'INCIDENT_NOTICE', title: '보안사고 통지', present: /(보안사고|정보.?유출).{0,25}(통지|신고|보고)/,
    text: '보안사고를 인지한 당사자는 지체 없이 상대방에게 통지하고 원인조사와 피해 완화에 협력한다.' },
  { kind: 'DATA_RETURN', title: '자료 반환·파기', present: /(자료|데이터|정보).{0,20}(반환|파기|삭제)/,
    text: '계약 종료 시 상대방이 제공한 자료를 합의한 기한과 방식에 따라 반환 또는 파기하고 그 결과를 확인한다.' },
  { kind: 'CHANGE_CONTROL', title: '과업변경 절차', present: /(과업|범위).{0,25}변경.{0,45}(서면.?합의|대가.?조정|일정.?조정)|변경관리 절차/,
    text: '과업 변경은 범위·대가·일정에 대한 서면 합의 후 시행하며 합의 전 추가 의무를 부과하지 않는다.' },
  { kind: 'ACCEPTANCE_CRITERIA', title: '검수 기준', present: /검수 기준|검사 기준|합격 기준|인수 기준/,
    text: '검수 항목, 합격 기준, 검수 기간과 이의·재검수 절차를 별표로 정한다.' },
  { kind: 'DEFECT_REMEDY', title: '하자보수 절차', present: /하자보수.{0,20}(기간|의무|절차|방법)/,
    text: '하자의 범위, 보수 요청과 이행 기한, 예외 및 보증기간을 구분하여 정한다.' },
  { kind: 'LIABILITY_CAP', title: '손해배상 한도', present: /(?:배상|책임).{0,12}한도.{0,20}(금액|총액|계약금|정한다)/,
    text: '책임 한도와 예외를 당사자의 귀책 및 위험 배분에 맞추어 상호 협의한다.' },
  { kind: 'DELAY_CAP', title: '지체상금 한도', present: /지체상금.{0,25}한도.{0,20}(금액|총액|계약금|정한다)/,
    text: '지체상금의 산정 기준과 총 한도, 귀책 없는 지체의 처리 방법을 정한다.' },
  { kind: 'TERMINATION_SETTLEMENT', title: '해지 시 정산', present: /해지.{0,50}(정산|기성.{0,8}지급)/,
    text: '계약 종료 시 검수된 기성 부분과 합리적으로 발생한 비용의 정산 기준 및 절차를 정한다.' },
  { kind: 'BACKGROUND_IP', title: '기존 지식재산 구분', present: /기존.{0,35}(존속|제외|이용허락)|Background IP/i,
    text: '계약 전부터 각 당사자가 보유한 자산은 원 권리자에게 존속하고, 필요한 범위의 이용권만 별도로 부여한다.' },
  { kind: 'FOREGROUND_IP', title: '신규 산출물 권리 범위', present: /(신규|본 사업).{0,30}(산출물|지식재산).{0,30}(귀속|이용권)|산출물.{0,30}(이용권|사용권)/,
    text: '이번 사업에서 새로 만든 산출물의 권리 귀속과 각 당사자의 사용 범위를 구분하여 정한다.' },
  { kind: 'REUSE_RIGHT', title: '기존 기술 재사용권', present: /기존.{0,30}(재사용|이용권)|범용.{0,30}(재사용|이용권)/,
    text: '을의 기존 범용 기술은 다른 사업에서 재사용할 수 있으며, 갑에게 필요한 이용권만 부여한다.' },
  { kind: 'THIRD_PARTY_OSS', title: '제3자·오픈소스 라이선스', present: /오픈소스|OSS|제3자.{0,15}라이선스/,
    text: '제3자 및 오픈소스 구성요소는 각 라이선스 조건을 확인하여 목록과 사용 범위를 합의한다.' },
  { kind: 'SUBCONTRACTING', title: '재위탁·하도급', present: /하도급|재위탁|재수탁/,
    text: '하도급 또는 재위탁의 승인 조건과 수탁자의 책임을 정한다.' },
  { kind: 'PERSONNEL_CONTROL', title: '인력 지휘 주체', present: /근태.{0,15}(지시|관리)|인력.{0,20}(지휘|관리)/,
    text: '을 소속 인력에 대한 구체적 업무 지휘와 근태관리는 을이 수행한다.' },
  { kind: 'DISPUTE_RESOLUTION', title: '분쟁 해결', present: /분쟁.{0,20}(해결|조정)|전속.{0,5}관할/,
    text: '분쟁 발생 시 협의 절차와 적용 가능한 이의·조정 및 관할 절차를 정한다.' },
  { kind: 'DATA_OWNERSHIP', title: '데이터 소유·반환', present: /데이터.{0,20}(소유|귀속|반환)|자료.{0,15}소유권/,
    text: '사업 데이터의 권리와 접근·반환·이전·삭제 범위를 별도로 정한다.' }
];

const TOPIC_MENTION = {
  CHANGE_CONTROL: /과업.{0,35}변경|범위.{0,35}변경/,
  LIABILITY_CAP: /배상.{0,25}한도|책임.{0,25}한도|무제한.{0,10}배상/,
  DELAY_CAP: /지체상금.{0,35}(한도|상한|제한)/,
  TERMINATION_SETTLEMENT: /해지.{0,65}(기성|정산|대금)|기성.{0,40}해지/,
  BACKGROUND_IP: /기존.{0,40}(지식재산|저작권|기술|자산|모듈)|지식재산.{0,35}기존/
};

export function buildContractInventory(registry, query = '') {
  const documents = documentEntries(registry);
  const findings = [];
  for (const entry of documents) {
    const text = normalize(entry.text);
    for (const rule of RULES) if (rule.test(text)) findings.push({
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
  const missingClauseAudit = CLAUSE_CHECKS.map(check => {
    const present = check.present.test(allText);
    const documentIds = documents.filter(e => present ? check.present.test(e.text)
      : TOPIC_MENTION[check.kind]?.test(e.text)).map(e => e.id);
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
    const existing = issues.find(i => i.kind === finding.kind || ((ISSUE_TERMS[finding.kind]?.test(i.question))
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
  const civil = new Set();
  if (kinds.has('CONTRACTUAL_PENALTY')) civil.add('103');
  if (kinds.has('CONTRACTUAL_PENALTY') || kinds.has('DELAY_DAMAGES')) civil.add('398');
  if (kinds.has('TERMINATION')) { civil.add('673'); civil.add('689'); }
  const seeds = civil.size ? [{ name: '민법', articles: [...civil] }] : [];
  if ([...kinds].some(k => ['SCOPE_CHANGE', 'TERMINATION', 'LIABILITY', 'CONTRACTUAL_PENALTY'].includes(k)))
    seeds.push({ name: '약관의 규제에 관한 법률', articles: ['2', '6', '7', '8', '9'] });
  if (kinds.has('INTELLECTUAL_PROPERTY')) seeds.push({ name: '저작권법', articles: ['14', '45'] });
  if (kinds.has('PERSONNEL_DIRECTION')) seeds.push({ name: '파견근로자 보호 등에 관한 법률', articles: ['2'] });
  if (kinds.has('VENUE_AGREEMENT')) seeds.push({ name: '민사소송법', articles: ['29'] });
  return seeds;
};

export function detectContractLawSeeds(documentText) {
  const text = normalize(documentText);
  return contractLawSeeds(RULES.filter(rule => rule.test(text)).map(rule => ({ kind: rule.kind })));
}

const AUTHORITY_HINTS = {
  SCOPE_CHANGE: [['약관의 규제에 관한 법률', ['6', '8']]],
  DELAY_DAMAGES: [['민법', ['398']]],
  CONTRACTUAL_PENALTY: [['민법', ['103', '398']]],
  TERMINATION: [['민법', ['673', '689']], ['약관의 규제에 관한 법률', ['9']]],
  LIABILITY: [['약관의 규제에 관한 법률', ['7']]],
  INTELLECTUAL_PROPERTY: [['저작권법', ['14', '45']]],
  PERSONNEL_DIRECTION: [['파견근로자 보호 등에 관한 법률', ['2']]],
  VENUE_AGREEMENT: [['민사소송법', ['29']]]
};

export function contractSeedEvidenceIds(kinds, registry) {
  const hints = kinds.flatMap(kind => AUTHORITY_HINTS[kind] || []);
  return registry.list(e => e.kind === 'ARTICLE' && e.official && e.inForce
    && hints.some(([name, articles]) => e.lawName === name && articles.includes(String(e.articleNo)))).map(e => e.id);
}
