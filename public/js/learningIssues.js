// 검토 이력에 저장된 진행 기록과 결과에서 후속 확인 사항을 모은다.
// 질의 후보와 실행 중 제한 사항은 성격이 다르므로 별도로 표시한다.
const CONTRACT_KIND_LABEL = {
  SCOPE_CHANGE: '과업 변경·비용 전가', DELAY_DAMAGES: '지체상금',
  CONTRACTUAL_PENALTY: '별도 위약벌', TERMINATION: '해지·기성대가 정산',
  LIABILITY: '면책·손해배상', INTELLECTUAL_PROPERTY: '기존 지식재산 귀속',
  PERSONNEL_DIRECTION: '인력 직접 지휘', VENUE_AGREEMENT: '전속관할 합의', DISPUTE_WAIVER: '분쟁절차 포기',
  PAYMENT_TERMS: '대금 지급 조건'
};
export function collectLearningIssues(data = {}) {
  const review = data.review || {};
  const issues = [];
  const seen = new Set();
  const add = (group, detail, kind = 'warning', meta = {}) => {
    const text = String(detail || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    issues.push({ group, detail: text, displayDetail: explainDiagnostic(text, data), kind, ...meta });
  };

  for (const gap of review.reasoning?.gaps || []) {
    if (gap.route === 'EXTERNAL_INQUIRY' && ['OPEN', 'STILL_OPEN', 'DEFERRED'].includes(gap.state)) {
      add('법리 판단', gap.question, 'inquiry', {
        source: 'reasoning-gap', gapId: gap.id, issueId: gap.issueId,
        elementId: gap.elementId, type: gap.type
      });
    }
  }

  const labels = new Map();
  for (const event of data.progressTrace?.events || []) {
    if (event.kind === 'step' && event.key) {
      if (event.label || event.group) labels.set(event.key, { label: event.label, group: event.group });
      if (event.state === 'FAILED') {
        const context = labels.get(event.key) || {};
        add(context.group || '분석', `${context.label || event.key}: ${event.detail || '단계 실패'}`,
          'warning', { source: 'progress-step', key: event.key });
      }
    } else if (event.kind === 'warn') {
      const context = labels.get(event.key) || {};
      add(context.group || '분석', event.detail, 'warning', { source: 'progress-warning', key: event.key });
    }
  }

  // 스트림을 쓰지 않은 검토와 과거 이력도 수집·분석 제한 사항을 표시한다.
  for (const warning of data.meta?.dataIntegrity?.collectionDiagnostics || []) add('수집', warning);
  for (const warning of data.meta?.dataIntegrity?.warnings || []) add('수집', warning);
  for (const warning of review.warnings || []) add('분석', warning);
  for (const reason of review.reasoning?.gateReasons || []) add('분석', reason);
  for (const warning of data.reliability?.warnings || []) add('검증', warning);
  return issues;
}

/** 내부 ID를 사람이 읽을 수 있는 짧은 근거·쟁점 설명으로 바꾼다. 원본 ID는 데이터에 남긴다. */
export function createReferenceFormatter(data = {}, { includePreview = false } = {}) {
  const reasoning = data.review?.reasoning || data.reasoning || data;
  const evidence = new Map((reasoning.evidence || []).map(item => [item.id, item]));
  const issues = new Map((reasoning.issues || []).map(item => [item.id, item]));
  return text => String(text ?? '').replace(/\[((?:A|O|P|Q|R|D|I)\d+(?:\.[\dA-Za-z_]+)*x?)\]|\b((?:A|O|P|Q|R|D|I)\d+(?:\.[\dA-Za-z_]+)*x?)\b/g,
    (_match, bracketed, plain) => {
      const id = bracketed || plain;
      if (id.startsWith('I')) {
        const issue = issues.get(id);
        if (!issue) return '확인되지 않은 쟁점';
        const kinds = (issue.contractKinds || []).map(kind => CONTRACT_KIND_LABEL[kind]).filter(Boolean);
        if (kinds.length) return kinds.join('·');
        const question = String(issue.question || '해당 쟁점');
        return `${question.slice(0, 48)}${question.length > 48 ? '…' : ''}`;
      }
      const item = evidence.get(id);
      if (!item) return '출처를 확인하지 못한 자료';
      const heading = `${item.label || '근거 자료'}${item.title && !String(item.label || '').includes(item.title) ? ` (${item.title})` : ''}`;
      return includePreview && item.preview ? `${heading} — 조문 첫머리: ${item.preview}` : heading;
    });
}

export function expandReferences(text, data) {
  return createReferenceFormatter(data)(text);
}

/** 모델 단계명과 반복된 ID가 들어간 진단을 사용자에게 필요한 조치 중심으로 줄인다. */
export function explainDiagnostic(text, data) {
  const value = String(text ?? '');
  const unverifiedArticle = value.match(/^(I\d+): 요건 분해 미검증 조문 ((?:A|O)\d+(?:\.[\dA-Za-z_]+)*x?)$/);
  if (unverifiedArticle) return `${expandReferences(unverifiedArticle[1], data)}: ${expandReferences(unverifiedArticle[2], data)}의 적용 조건을 더 확인해야 합니다.`;
  const skeletonIssue = value.match(/^(I\d+): 골격으로 대체한 미검증 요건이 포함됨$/);
  if (skeletonIssue) return `${expandReferences(skeletonIssue[1], data)}: 적용 법령의 판단 기준을 더 확인해야 합니다.`;
  const unverifiedClaim = value.match(/^(I\d+): 근거-주장 검증 미완료 (\d+)건$/);
  if (unverifiedClaim) return `${expandReferences(unverifiedClaim[1], data)}: 법적 판단과 인용 근거의 연결을 확인해야 합니다 (${unverifiedClaim[2]}건).`;
  const failedArticle = value.match(/조문 요건 분해 실패\(((?:A|O)\d+(?:\.[\dA-Za-z_]+)*x?)(?::[^)]*)?\).*골격 요건으로 대체/);
  if (failedArticle) return `${expandReferences(failedArticle[1], data)}: 이 법 조항의 적용 조건을 충분히 확인하지 못했습니다.`;
  if (value.startsWith('요건 분해 미검증 조문:'))
    return `세부 요건 확인이 필요한 조문: ${expandReferences(value.slice('요건 분해 미검증 조문:'.length).trim(), data)}`;
  return expandReferences(value.replace(/\bs3\b/g, '법 조항 분석 단계')
    .replace(/미확인 법적 근거 ID를 제거했습니다/g, '확인되지 않은 법령 인용을 제외했습니다')
    .replace(/확인되지 않은 근거 표기를 제거했습니다/g, '확인되지 않은 법령 인용을 제외했습니다'), data);
}

/** 외부 질의 대상은 법리 공백이다. 수집·파싱·토큰 경고는 내부 보완 작업으로 남긴다. */
export function learningQuestionForIssue(issue = {}, data = {}) {
  return issue.kind === 'inquiry' ? expandReferences(String(issue.detail || '').trim(), data) : '';
}

export function collectLearningQuestions(data = {}) {
  return collectLearningIssues(data).filter(issue => issue.kind === 'inquiry').map((issue, index) => ({
    no: index + 1,
    text: learningQuestionForIssue(issue, data),
    issue
  }));
}
