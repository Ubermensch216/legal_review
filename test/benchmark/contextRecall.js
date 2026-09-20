import { optimizeDocumentContext } from '../../server/parsers/contextOptimizer.js';

const filler = '일반 업무 배경과 처리 절차를 설명한다. '.repeat(900);
const cases = [
  { id: 'late-clause', query: '면책', document: `제1조(배경) ${filler}\n제2조(면책) 책임을 일체 부담하지 않는다. LATE_CLAUSE`, markers: ['LATE_CLAUSE'] },
  { id: 'inside-large-clause', query: '일반 검토', document: `제1조(일반) ${filler}동의 없이 제공한다. INTERNAL_RISK`, markers: ['INTERNAL_RISK'] },
  { id: 'separated-risks', query: '검토', document: `제1조(조건) 동의 없이 FIRST_RISK ${filler}영구 보관 SECOND_RISK`, markers: ['FIRST_RISK', 'SECOND_RISK'] },
  { id: 'neighbor-exception', query: '면책', document: `제1조(책임) ${filler}책임을 일체 부담하지 않는다. 다만 고의인 경우 EXCEPTION_APPLIES.`, markers: ['EXCEPTION_APPLIES'] },
  { id: 'multiple-large-clauses', query: '검토', document: `제1조(일반) ${filler}동의 없이 RISK_A\n제2조(자료) ${filler}영구 보관 RISK_B\n제3조(해지) 최고 없이 해지 RISK_C`, markers: ['RISK_A', 'RISK_B', 'RISK_C'] },
  // A negative control: a semantic issue with no matching query/risk keyword may be missed.
  { id: 'unmatched-tail-control', query: '검토', document: `제1조(일반) ${filler}별도 부속 문서의 조건이 우선한다. UNMATCHED_TAIL`, markers: ['UNMATCHED_TAIL'] }
];
const rows = cases.flatMap(item => [1500, 4500].map(maxChars => {
  const result = optimizeDocumentContext({ documentText: item.document, query: item.query, maxChars });
  return { case: item.id, budgetChars: maxChars, inputChars: item.document.length, outputChars: result.optimizedText.length,
    targets: item.markers.length, recovered: item.markers.filter(m => result.optimizedText.includes(m)).length,
    prefixRecovered: item.markers.filter(m => item.document.slice(0, maxChars).includes(m)).length,
    omittedChunks: result.omittedCount, truncatedChunks: result.truncatedCount };
}));
console.log(JSON.stringify({ scope: 'SYNTHETIC_EXCERPT_MARKER_RECALL_NOT_LEGAL_ACCURACY', baseline: 'same-budget document prefix', rows }, null, 2));
