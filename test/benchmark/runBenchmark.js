// test/benchmark/runBenchmark.js - 20종 실무 법률 검토 벤치마크 평가 엔진
//
// 이 하네스는 '측정'을 목적으로 한다. 따라서 다음 원칙을 지킨다.
//
//  1. 정답 대조: 데이터셋의 expectedArticles/targetLaw와 실제 결과를 대조한다.
//     (과거에는 정답 필드를 한 번도 읽지 않고, 결과의 자기보고 점수를 그대로 집계했다.)
//  2. 기본값 금지: 값이 없으면 합격점을 채워 넣지 않고 '측정 불가'로 집계한다.
//     (과거: `citationConfidence || 95`, `relevanceScore || 85`)
//  3. 폴백 실격: 목업 데이터나 룰베이스 폴백으로 산출된 결과는 PASS로 세지 않는다.
//     (과거: LAW_OC도 LLM도 없이 20건이 0.01초에 '전수 성공'으로 집계됐다.)
//  4. 조건 명시: 어떤 데이터 출처와 어떤 엔진으로 측정했는지 보고서에 항상 찍는다.
//
// 실행:
//   node test/benchmark/runBenchmark.js                 # 환경설정 기반 (ENV.LLM_PROVIDER)
//   BENCH_PROVIDER=ollama node test/benchmark/runBenchmark.js
//   BENCH_PROVIDER=rule_based node test/benchmark/runBenchmark.js   # 폴백 엔진 성능 측정용
//   BENCH_ALLOW_FALLBACK=1 ...                          # 폴백 결과도 집계에 포함(진단용)

import { BENCHMARK_20_DATASET } from './benchmarkDataset.js';
import { buildWorkbenchContext } from '../../server/law/lawWorkbench.js';
import { generateLegalReview } from '../../server/law/lawWorkbenchReview.js';
import { ENV } from '../../server/env.js';

const PROVIDER = process.env.BENCH_PROVIDER || ENV.LLM_PROVIDER || 'ollama';
const ALLOW_FALLBACK = process.env.BENCH_ALLOW_FALLBACK === '1';

/**
 * '제15조', '15', '제15조의2' 등을 '15' / '15의2' 형태로 정규화한다.
 */
function normalizeArticle(raw) {
  if (!raw && raw !== 0) return '';
  const m = String(raw).match(/(\d+)\s*(?:조)?\s*(?:의\s*(\d+))?/);
  if (!m) return '';
  return m[2] ? `${m[1]}의${m[2]}` : m[1];
}

/**
 * 조문 인용 정확도: 검토가 인용한 조문이 정답 조문 집합과 얼마나 겹치는가.
 * @returns {{ measurable: boolean, precision: number|null, recall: number|null, cited: string[], hit: string[], missed: string[] }}
 */
function scoreCitations(review, expectedArticles) {
  const expected = new Set(expectedArticles.map(normalizeArticle).filter(Boolean));
  const cited = (review.legalBasis || [])
    .map(b => normalizeArticle(b.articleNo))
    .filter(Boolean);

  if (cited.length === 0 || expected.size === 0) {
    return { measurable: false, precision: null, recall: null, cited, hit: [], missed: [...expected] };
  }

  const hit = [...new Set(cited.filter(c => expected.has(c)))];
  const missed = [...expected].filter(e => !cited.includes(e));

  return {
    measurable: true,
    precision: Math.round((cited.filter(c => expected.has(c)).length / cited.length) * 100),
    recall: Math.round((hit.length / expected.size) * 100),
    cited,
    hit,
    missed
  };
}

/**
 * 기준 법령이 데이터셋이 지정한 법령과 실제로 일치하는지 확인한다.
 * 과거에는 로그에 데이터셋의 targetLaw를 그대로 찍어, 시스템이 엉뚱한 법령을
 * 분석해도 화면에는 올바른 법령명이 출력됐다.
 */
function scoreLawMatch(ctx, expectedLaw) {
  const actual = ctx.meta?.primaryLawName || '';
  const norm = (x) => (x || '').replace(/\s+/g, '');
  const matched = Boolean(actual) &&
    (norm(actual).includes(norm(expectedLaw)) || norm(expectedLaw).includes(norm(actual)));
  return { matched, actual: actual || '(없음)' };
}

/**
 * Redline 수정안 품질: 실제 수정 문구(revisedText)가 작성됐는지 본다.
 * 탐지만 하고 수정안이 비어 있으면 '수정안 생성'으로 세지 않는다.
 */
function scoreRedlines(review) {
  const diffs = review.redlineDiffs || [];
  const drafted = diffs.filter(d => d.revisedText && d.revisedText.trim().length > 0);
  return { total: diffs.length, drafted: drafted.length };
}

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('20종 실무 법률 검토 벤치마크');
  console.log('='.repeat(80));
  console.log(`측정 조건:`);
  console.log(`  - 검토 엔진(provider): ${PROVIDER}`);
  console.log(`  - LAW_OC(법령 API 인증): ${ENV.LAW_OC ? '설정됨' : '미설정 → 목업 데이터로 동작'}`);
  console.log(`  - 폴백 결과 집계: ${ALLOW_FALLBACK ? '포함(진단 모드)' : '실격 처리'}`);
  console.log('');

  if (!ENV.LAW_OC) {
    console.log('!'.repeat(80));
    console.log('경고: LAW_OC가 설정되지 않아 공식 법령 API를 호출할 수 없습니다.');
    console.log('      이 상태의 측정값은 시스템 성능이 아니라 목업 샘플의 성질을 측정한 것입니다.');
    console.log('      유효한 수치를 얻으려면 open.law.go.kr에서 발급받은 OC를 .env에 설정하십시오.');
    console.log('!'.repeat(80));
    console.log('');
  }

  const results = [];
  const startOverallTime = Date.now();

  for (let i = 0; i < BENCHMARK_20_DATASET.length; i++) {
    const item = BENCHMARK_20_DATASET[i];
    const itemStart = Date.now();

    try {
      const ctx = await buildWorkbenchContext({
        query: item.query,
        preset: item.category,
        targetLaw: item.targetLaw
      });

      const review = await generateLegalReview({
        query: item.query,
        preset: item.category,
        documentText: `[검토문서: ${item.title}]\n${item.query}`,
        workbenchContext: ctx,
        llmConfig: { provider: PROVIDER }
      });

      const latencyMs = Date.now() - itemStart;

      const integrity = ctx.meta?.dataIntegrity || {};
      const isFallback = Boolean(integrity.isFallback) || Boolean(review.isFallback);

      const lawMatch = scoreLawMatch(ctx, item.targetLaw);
      const citations = scoreCitations(review, item.expectedArticles || []);
      const redlines = scoreRedlines(review);

      const topPrec = (ctx.officialEvidence?.precedents || [])[0];
      const precScore = topPrec && typeof topPrec.relevanceScore === 'number'
        ? topPrec.relevanceScore
        : null; // 기본값을 채우지 않는다

      // PASS 조건: 폴백이 아니고, 기준 법령이 일치하고, 조문 인용이 정답과 겹칠 것.
      let status;
      let statusReason = '';
      if (isFallback && !ALLOW_FALLBACK) {
        status = 'DISQUALIFIED';
        statusReason = (integrity.warnings || [])[0] || review.fallbackReason || '폴백 결과';
      } else if (!lawMatch.matched) {
        status = 'FAIL';
        statusReason = `기준 법령 불일치 (기대: ${item.targetLaw} / 실제: ${lawMatch.actual})`;
      } else if (!citations.measurable) {
        status = 'FAIL';
        statusReason = '인용 조문이 없어 정확도를 측정할 수 없음';
      } else if (citations.recall === 0) {
        status = 'FAIL';
        statusReason = `정답 조문 미인용 (기대: ${(item.expectedArticles || []).join(', ')})`;
      } else {
        status = 'PASS';
      }

      results.push({
        id: item.id,
        law: item.targetLaw,
        actualLaw: lawMatch.actual,
        lawMatched: lawMatch.matched,
        citations,
        precScore,
        redlines,
        latencyMs,
        isFallback,
        status,
        statusReason
      });

      const mark = { PASS: 'PASS', FAIL: 'FAIL', DISQUALIFIED: '실격' }[status];
      const citeText = citations.measurable
        ? `인용정확도 ${citations.precision}% / 재현율 ${citations.recall}%`
        : '인용 측정불가';
      console.log(
        `[${i + 1}/20] ${item.id} ${mark} — 법령 ${lawMatch.matched ? '일치' : `불일치(${lawMatch.actual})`}, ` +
        `${citeText}, 판례 ${precScore === null ? '측정불가' : precScore + '점'}, ` +
        `수정안 ${redlines.drafted}/${redlines.total}건, ${latencyMs}ms` +
        (statusReason ? `\n         사유: ${statusReason}` : '')
      );
    } catch (err) {
      console.error(`[${i + 1}/20] ${item.id} ERROR: ${err.message}`);
      results.push({
        id: item.id, law: item.targetLaw, actualLaw: '(오류)', lawMatched: false,
        citations: { measurable: false, precision: null, recall: null, hit: [], missed: [] },
        precScore: null, redlines: { total: 0, drafted: 0 }, latencyMs: Date.now() - itemStart,
        isFallback: false, status: 'ERROR', statusReason: err.message
      });
    }
  }

  const totalTimeSec = ((Date.now() - startOverallTime) / 1000).toFixed(2);

  // 집계 — 측정 가능한 항목만 평균한다. 측정 불가는 분모에서 제외하고 건수를 별도 표기한다.
  const count = (s) => results.filter(r => r.status === s).length;
  const measurableCites = results.filter(r => r.citations.measurable);
  const measurablePrec = results.filter(r => r.precScore !== null);

  const avg = (list, pick) => list.length === 0
    ? null
    : (list.reduce((a, r) => a + pick(r), 0) / list.length).toFixed(1);

  const avgPrecision = avg(measurableCites, r => r.citations.precision);
  const avgRecall = avg(measurableCites, r => r.citations.recall);
  const avgPrecScore = avg(measurablePrec, r => r.precScore);
  const lawMatchCount = results.filter(r => r.lawMatched).length;
  const totalDrafted = results.reduce((a, r) => a + r.redlines.drafted, 0);
  const totalDetected = results.reduce((a, r) => a + r.redlines.total, 0);
  const avgLatency = Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / results.length);

  const fmt = (v, unit) => v === null ? '측정 불가 (해당 건 없음)' : `${v}${unit}`;

  console.log('\n' + '='.repeat(80));
  console.log('벤치마크 결과');
  console.log('='.repeat(80));
  console.log(`측정 조건: provider=${PROVIDER}, LAW_OC=${ENV.LAW_OC ? '설정' : '미설정(목업)'}, 총 ${totalTimeSec}초`);
  console.log('-'.repeat(80));
  console.log(`  PASS ${count('PASS')}건 / FAIL ${count('FAIL')}건 / 실격 ${count('DISQUALIFIED')}건 / 오류 ${count('ERROR')}건`);
  console.log(`  기준 법령 일치:        ${lawMatchCount}/20건`);
  console.log(`  조문 인용 정확도:      ${fmt(avgPrecision, '%')}  (측정 가능 ${measurableCites.length}/20건)`);
  console.log(`  정답 조문 재현율:      ${fmt(avgRecall, '%')}  (측정 가능 ${measurableCites.length}/20건)`);
  console.log(`  최상위 판례 적합도:    ${fmt(avgPrecScore, '점')}  (측정 가능 ${measurablePrec.length}/20건)`);
  console.log(`  Redline 수정안 작성:   ${totalDrafted}건 (탐지 ${totalDetected}건 중 실제 수정 문구 작성)`);
  console.log(`  평균 응답 시간:        ${avgLatency}ms`);
  console.log('='.repeat(80));

  if (count('DISQUALIFIED') > 0) {
    console.log('');
    console.log(`실격 ${count('DISQUALIFIED')}건: 목업 데이터 또는 폴백 엔진으로 산출된 결과입니다.`);
    console.log('이 수치는 시스템 성능을 나타내지 않습니다. LAW_OC와 LLM을 구성한 뒤 재측정하십시오.');
  }
  console.log('');

  // 측정이 성립하지 않았으면 비정상 종료 코드로 CI에서도 드러나게 한다.
  const measured = count('PASS') + count('FAIL');
  if (measured === 0) {
    console.error('측정이 성립하지 않았습니다 (유효 측정 0건). 종료 코드 1.');
    process.exitCode = 1;
  }

  return { results, avgPrecision, avgRecall, avgPrecScore, lawMatchCount, avgLatency };
}

runBenchmark().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
