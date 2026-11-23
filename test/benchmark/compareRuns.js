// test/benchmark/compareRuns.js - 두 번의 기준선 측정(pipelineBaseline.js 결과 JSON)을 사례별로 비교한다
//
// 사용: node test/benchmark/compareRuns.js <이전.json> <이후.json>
// 시간·호출·출력 토큰과 품질 지표(판단 실행 쟁점 비율, 쟁점-조문 연결, 사실 수, 정답셋 점수)의 변화를 표로 낸다.
// 같은 모델·같은 법령 API 상태에서 잰 결과끼리만 비교하십시오.
import fs from 'node:fs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const secs = ms => (Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : '-');
const pct = (n, d) => (d ? `${n}/${d}` : '-');

export function compareRuns(before, after) {
  const byId = run => new Map((run.rows || []).filter(r => r.stage === 'DONE').map(r => [r.id, r]));
  const a = byId(before); const b = byId(after);
  return [...new Set([...a.keys(), ...b.keys()])].sort().map(id => {
    const x = a.get(id); const y = b.get(id);
    const issues = r => r?.reasoning?.issues?.length ?? r?.counts?.issues;
    const judged = r => r?.reasoning?.judgedIssues ?? r?.reasoning?.reviewedIssues;
    return { id,
      time: `${secs(x?.wallMs)} → ${secs(y?.wallMs)}`,
      llmCalls: `${x?.ledger?.totals?.calls ?? '-'} → ${y?.ledger?.totals?.calls ?? '-'}`,
      outputTokens: `${x?.ledger?.totals?.outputTokens ?? '-'} → ${y?.ledger?.totals?.outputTokens ?? '-'}`,
      judged: `${pct(judged(x), issues(x))} → ${pct(judged(y), issues(y))}`,
      linked: `${x?.reasoning?.linkedIssues ?? '-'} → ${y?.reasoning?.linkedIssues ?? '-'}`,
      facts: `${x?.reasoning?.facts ?? '-'} → ${y?.reasoning?.facts ?? '-'}`,
      goldIssues: `${y?.gold ? pct(y.gold.issueCoverage.covered, y.gold.issueCoverage.expected) : '-'}`,
      goldCitationRecall: `${x?.gold?.citation.recall ?? x?.citations?.recall ?? '-'} → ${y?.gold?.citation.recall ?? y?.citations?.recall ?? '-'}`,
      forbidden: y?.gold?.forbidden?.length ?? '-' };
  });
}

if (process.argv[1] && process.argv[1].endsWith('compareRuns.js') && process.argv[3]) {
  console.table(compareRuns(read(process.argv[2]), read(process.argv[3])));
}
