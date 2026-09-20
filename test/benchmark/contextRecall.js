import { optimizeDocumentContext } from '../../server/parsers/contextOptimizer.js';

const filler = '일반 업무 배경과 처리 절차를 설명한다. '.repeat(900);
const cases = [
  { id: 'late-clause', query: '면책', document: `제1조(배경) ${filler}\n제2조(면책) 책임을 일체 부담하지 않는다. LATE_CLAUSE`, markers: ['LATE_CLAUSE'], signal: 'RISK_KEYWORD' },
  { id: 'inside-large-clause', query: '일반 검토', document: `제1조(일반) ${filler}동의 없이 제공한다. INTERNAL_RISK`, markers: ['INTERNAL_RISK'], signal: 'RISK_KEYWORD' },
  { id: 'separated-risks', query: '검토', document: `제1조(조건) 동의 없이 FIRST_RISK ${filler}영구 보관 SECOND_RISK`, markers: ['FIRST_RISK', 'SECOND_RISK'], signal: 'RISK_KEYWORD' },
  { id: 'neighbor-exception', query: '면책', document: `제1조(책임) ${filler}책임을 일체 부담하지 않는다. 다만 고의인 경우 EXCEPTION_APPLIES.`, markers: ['EXCEPTION_APPLIES'], signal: 'RISK_KEYWORD' },
  { id: 'multiple-large-clauses', query: '검토', document: `제1조(일반) ${filler}동의 없이 RISK_A\n제2조(자료) ${filler}영구 보관 RISK_B\n제3조(해지) 최고 없이 해지 RISK_C`, markers: ['RISK_A', 'RISK_B', 'RISK_C'], signal: 'RISK_KEYWORD' },
  // 위험 룰셋과 질의어가 모두 비껴가고 구조 표지(우선 적용·부속 문서)만 남은 말미 조건.
  { id: 'unmatched-tail', query: '검토', document: `제1조(일반) ${filler}별도 부속 문서의 조건이 우선한다. UNMATCHED_TAIL`, markers: ['UNMATCHED_TAIL'], signal: 'SALIENCE_MARKER' },
  { id: 'proviso-far-from-risk', query: '검토', document: `제1조(책임) 책임을 일체 부담하지 않는다. NEAR_RISK ${filler}다만 중대한 과실은 제외한다. FAR_PROVISO`, markers: ['NEAR_RISK', 'FAR_PROVISO'], signal: 'SALIENCE_MARKER' },
  // 표지조차 없는 말미 문장. 구조적 꼬리 발췌만으로 덮이는지 본다.
  { id: 'no-marker-tail', query: '검토', document: `제1조(현황) ${filler}접수 창구는 본관에 둔다. PLAIN_TAIL`, markers: ['PLAIN_TAIL'], signal: 'STRUCTURAL_COVERAGE_ONLY' },
  // 대조군: 표지도 키워드도 없고 위치도 중간인 문장. 의미 기반 검색 없이는 회수되지 않는다.
  { id: 'no-marker-middle-control', query: '검토', document: `제1조(현황) ${filler}담당자는 매주 회의를 연다. PLAIN_MIDDLE ${filler}`, markers: ['PLAIN_MIDDLE'], signal: 'NONE_CONTROL' }
];

const rows = cases.flatMap(item => [1500, 4500].map(maxChars => {
  const result = optimizeDocumentContext({ documentText: item.document, query: item.query, maxChars });
  const sampled = (result.selectedChunks || []).reduce((sum, chunk) =>
    sum + (chunk.excerptSpans || []).reduce((n, span) => n + (span.end - span.start), 0), 0);
  return { case: item.id, signal: item.signal, budgetChars: maxChars, inputChars: item.document.length, outputChars: result.optimizedText.length,
    targets: item.markers.length, recovered: item.markers.filter(m => result.optimizedText.includes(m)).length,
    prefixRecovered: item.markers.filter(m => item.document.slice(0, maxChars).includes(m)).length,
    excerptWindows: (result.selectedChunks || []).reduce((n, c) => n + (c.excerptSpans?.length || 0), 0),
    sampledChars: sampled, omittedChunks: result.omittedCount, truncatedChunks: result.truncatedCount };
}));

const sum = (list, key) => list.reduce((n, row) => n + row[key], 0);
const bySignal = [...new Set(rows.map(r => r.signal))].map(signal => {
  const group = rows.filter(r => r.signal === signal);
  return { signal, targets: sum(group, 'targets'), recovered: sum(group, 'recovered'), prefixRecovered: sum(group, 'prefixRecovered') };
});

console.log(JSON.stringify({
  scope: 'SYNTHETIC_EXCERPT_MARKER_RECALL_NOT_LEGAL_ACCURACY',
  baseline: 'same-budget document prefix',
  note: '합성 문서에 의도적으로 배치한 표식의 회수 건수다. 실제 사용자 문서의 회수율이나 법률 정확도가 아니다.',
  totals: { targets: sum(rows, 'targets'), recovered: sum(rows, 'recovered'), prefixRecovered: sum(rows, 'prefixRecovered') },
  bySignal, rows
}, null, 2));
