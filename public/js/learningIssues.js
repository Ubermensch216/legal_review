// 검토 이력에 저장된 진행 기록과 결과에서 후속 확인 사항을 모은다.
// 질의 후보와 실행 중 제한 사항은 성격이 다르므로 별도로 표시한다.
export function collectLearningIssues(data = {}) {
  const review = data.review || {};
  const issues = [];
  const seen = new Set();
  const add = (group, detail, kind = 'warning', meta = {}) => {
    const text = String(detail || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    issues.push({ group, detail: text, kind, ...meta });
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

/** 내부 근거 ID를 외부 전문가가 읽을 수 있는 법령·판례 표제로 바꾼다. */
export function expandReferences(text, data) {
  const evidence = new Map((data.review?.reasoning?.evidence || []).map(item => [item.id, item]));
  return text.replace(/\b(?:A|O|P|Q|R)\d+(?:\.[\dA-Za-z_]+)*x?\b/g, id => {
    const item = evidence.get(id);
    return item?.label || '공식 식별정보를 확인하지 못한 자료';
  });
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
