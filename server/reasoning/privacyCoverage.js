// 행별 검토 누락을 드러내는 출처 연결 점검. 위험 여부나 법적 효력은 판정하지 않는다.
export function assessPrivacyRowCoverage(registry, issues = [], issueResults = []) {
  const rows = registry.list(entry => entry.kind === 'DOCUMENT' && /^첨부문서 행 \d+\b/.test(entry.label));
  return rows.map(row => {
    const linked = issues.filter(issue => {
      const result = issueResults.find(item => item.issueId === issue.id);
      return (issue.documentIds || []).includes(row.id) || (result?.documentIds || []).includes(row.id);
    });
    const reviewed = linked.some(issue => ['OK', 'OK_WITH_WARNINGS'].includes(
      issueResults.find(item => item.issueId === issue.id)?.stageStatus));
    return { documentId: row.id, label: row.label, sourceSpan: row.sourceSpan,
      issueIds: linked.map(issue => issue.id), status: reviewed ? 'REVIEWED' : linked.length ? 'INCOMPLETE' : 'UNREVIEWED' };
  });
}
