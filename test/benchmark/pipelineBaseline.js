// test/benchmark/pipelineBaseline.js - 검토 파이프라인 효율·안정성 기준선
//
// 단계형 파이프라인(docs/reasoning-pipeline-plan-2026-09-23.md)과 비교할 기준값을 잰다.
// 법리 정확도 평가가 아니다. 같은 입력에서 시간·토큰·폴백·파싱 실패·인용 존재율이 어떻게
// 변하는지를 보는 용도이며, 결과는 실행한 모델·Ollama·법령 API 상태에 묶인다.
//
// 실행 (실제 법령 API와 로컬 LLM을 호출한다. 사례당 수 분이 걸린다):
//   node test/benchmark/pipelineBaseline.js                    # 전체 사례 1회
//   BASELINE_CASES=01,05 BASELINE_REPEAT=3 node test/benchmark/pipelineBaseline.js
//   BASELINE_OUT=docs/audit/pipeline-baseline-custom.json node test/benchmark/pipelineBaseline.js
//   BASELINE_PIPELINE=staged node test/benchmark/pipelineBaseline.js   # 단계형 파이프라인으로 같은 사례 측정
//   BASELINE_SAVE_DIR=<폴더> ...   # 사례별 검토 결과 전체를 저장(분석용; 사건 자료가 들어가므로 저장소 밖에 두십시오)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '../../server/env.js';
import { parseDocument } from '../../server/parsers/index.js';
import { buildWorkbenchContext } from '../../server/law/lawWorkbench.js';
import { generateLegalReview } from '../../server/law/lawWorkbenchReview.js';
import { scoreCitations } from './scoring.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const samples = path.join(root, 'test/docs/review-samples');

// 기대 조문은 샘플 README의 "기대 탐지 결과"를 옮긴 것이다. 전문가 정답이 아니라 회귀 비교용이다.
const CASES = [
  { id: '01', files: ['01_취업규칙_전부개정안.hwpx'], preset: 'labor_hr', targetLaw: '근로기준법',
    query: '취업규칙 전부개정안의 근로기준법 위반 여부와 불이익 변경 절차를 검토해 주십시오.',
    expected: ['제20조', '제23조', '제27조', '제50조', '제53조', '제56조', '제94조'] },
  { id: '02', files: ['02_정보시스템_구축_용역계약서.docx'], preset: 'contract_risk', targetLaw: '',
    query: '용역계약서의 갑 우위 독소조항과 위장도급 위험을 검토해 주십시오.', expected: [] },
  { id: '03', files: ['03_영업정지_사전통지_의견제출서.pdf'], preset: 'admin_dispute', targetLaw: '식품위생법', targetDate: '20231115',
    query: '영업정지 사전통지의 절차적 적법성과 과징금 전환 가능성을 검토해 주십시오.',
    expected: ['제75조', '제81조', '제82조'] },
  { id: '04', files: ['04_개인정보_처리현황표.xlsx', '04_개인정보_수탁사목록.csv'], preset: 'privacy_security', targetLaw: '개인정보 보호법',
    query: '개인정보 처리현황과 수탁사 관리의 개인정보 보호법 위반 여부를 검토해 주십시오.',
    expected: ['제15조', '제17조', '제22조', '제23조', '제24조의2', '제25조', '제26조', '제28조의2'] },
  { id: '05', files: ['05_사전컨설팅감사_신청서.txt'], preset: 'pre_consulting_audit', targetLaw: '', targetDate: '20210302',
    query: '사전 컨설팅감사 신청서의 갑설·을설 중 타당한 견해와 처리 의견(수용/반려)을 검토해 주십시오.', expected: [] }
];

const wanted = (process.env.BASELINE_CASES || '').split(',').map(s => s.trim()).filter(Boolean);
const repeat = Math.max(1, parseInt(process.env.BASELINE_REPEAT || '1', 10));
const provider = process.env.BENCH_PROVIDER || ENV.LLM_PROVIDER || 'ollama';
const pipeline = process.env.BASELINE_PIPELINE === 'staged' ? 'staged' : 'monolithic';
const stamp = new Date().toISOString().slice(0, 10);
const out = path.resolve(root, process.env.BASELINE_OUT || `docs/audit/pipeline-${pipeline === 'staged' ? 'staged' : 'baseline'}-${stamp}.json`);

async function loadDocument(files) {
  const parts = [];
  for (const name of files) {
    const parsed = await parseDocument(fs.readFileSync(path.join(samples, name)), name);
    parts.push(`[첨부문서: ${name}]\n${parsed.text}`);
  }
  return parts.join('\n\n');
}

async function runCase(item, run) {
  const started = Date.now();
  const row = { id: item.id, run, preset: item.preset };
  let documentText;
  try { documentText = await loadDocument(item.files); }
  catch (err) { return { ...row, stage: 'PARSE', error: err.message, wallMs: Date.now() - started }; }

  const ctx = await buildWorkbenchContext({ query: item.query, preset: item.preset, documentText,
    targetLaw: item.targetLaw, targetDate: item.targetDate || '' });
  const collectedMs = Date.now() - started;
  const review = await generateLegalReview({ query: item.query, preset: item.preset, documentText,
    workbenchContext: ctx, llmConfig: { provider, pipeline } });
  const verification = review.factualityVerification || {};
  if (process.env.BASELINE_SAVE_DIR) {
    fs.mkdirSync(process.env.BASELINE_SAVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.BASELINE_SAVE_DIR, `${pipeline}-${item.id}-${run}.json`), JSON.stringify({ meta: ctx.meta, review }, null, 1));
  }
  return { ...row, stage: 'DONE', wallMs: Date.now() - started, collectMs: collectedMs,
    primaryLaw: ctx.meta?.primaryLawName || null,
    reviewEngine: review.reviewEngine, reviewStatus: review.reviewStatus, isFallback: Boolean(review.isFallback),
    fallbackReason: review.fallbackReason || null,
    counts: { issues: (review.coreIssues || []).length, legalBasis: (review.legalBasis || []).length,
      risks: (review.risks || []).length, redlines: (review.redlineDiffs || []).length,
      opinionChars: (review.legalOpinion || '').length, draftChars: (review.draftOpinion || '').length },
    citationExistence: verification.citationConfidence ?? null,
    citations: item.expected.length ? scoreCitations(review, item.expected, item.targetLaw) : null,
    inputBudget: review.inputBudget ? { estimatedInputTokens: review.inputBudget.estimatedInputTokens,
      inputLimit: review.inputBudget.inputLimit, reduced: review.inputBudget.reduced } : null,
    omittedEvidence: review.inputCoverage?.omittedEvidence ?? null,
    reasoning: review.reasoning ? { issues: review.reasoning.issues.map(i => ({ id: i.id, question: i.question, conclusion: i.conclusion?.legal, stageStatus: i.stageStatus })),
      gaps: review.reasoning.gaps.map(g => ({ type: g.type, route: g.route })), gate: review.reasoning.gate,
      rejectedIds: review.reasoning.diagnostics?.s1?.rejectedIds?.length ?? 0,
      warrants: review.reasoning.warrants.map(w => w.overall) } : null,
    ledger: review.llmLedger || null };
}

const summarize = rows => {
  const done = rows.filter(r => r.stage === 'DONE');
  const pick = fn => done.map(fn).filter(Number.isFinite);
  const median = values => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return { runs: rows.length, completed: done.length, parseFailures: rows.filter(r => r.stage === 'PARSE').length,
    fallbacks: done.filter(r => r.isFallback).length,
    medianWallMs: median(pick(r => r.wallMs)), medianLlmWallMs: median(pick(r => r.ledger?.totals?.wallMs)),
    medianOutputTokens: median(pick(r => r.ledger?.totals?.outputTokens)),
    medianInputTokens: median(pick(r => r.ledger?.totals?.inputTokens)),
    llmCalls: done.reduce((n, r) => n + (r.ledger?.totals?.calls || 0), 0) };
};

const selected = CASES.filter(c => !wanted.length || wanted.includes(c.id));
console.log(`기준선 측정(${pipeline}): ${selected.map(c => c.id).join(', ')} × ${repeat}회 · provider=${provider} · model=${provider === 'ollama' ? ENV.OLLAMA_MODEL : '(요청 설정)'}`);
console.log(`LAW_OC ${ENV.LAW_OC ? '설정됨' : '미설정 — 공식 근거 없이 측정되므로 기준선으로 쓰지 마십시오'}`);

const rows = [];
for (let run = 1; run <= repeat; run++) {
  for (const item of selected) {
    process.stdout.write(`[${item.id} #${run}] `);
    let row;
    try { row = await runCase(item, run); }
    catch (err) { row = { id: item.id, run, stage: 'ERROR', error: err.message }; }
    rows.push(row);
    console.log(row.stage === 'DONE'
      ? `${Math.round(row.wallMs / 1000)}s · ${row.reviewEngine}/${row.reviewStatus} · 출력 ${row.ledger?.totals?.outputTokens ?? '?'}토큰 · 호출 ${row.ledger?.totals?.calls ?? 0}`
      : `${row.stage}: ${row.error}`);
    // 사례마다 저장해 중간에 끊겨도 앞선 측정이 남게 한다.
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), pipeline, provider,
      model: provider === 'ollama' ? ENV.OLLAMA_MODEL : null, lawOc: Boolean(ENV.LAW_OC),
      modelBudgets: process.env.LLM_MODEL_BUDGETS || null, sectionBudgets: process.env.LLM_SECTION_BUDGETS || null,
      note: '효율·안정성 기준선. 법리 정확도 평가가 아니다.', summary: summarize(rows), rows }, null, 2));
  }
}
console.log(`\n요약: ${JSON.stringify(summarize(rows))}\n저장: ${path.relative(root, out)}`);
