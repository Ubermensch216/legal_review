// server/reasoning/verify/warrant.js - S6 근거 검증 (결정적 검사 → 임베딩 정렬 → 필요한 쌍만 LLM 함의)
//
// "인용한 자료가 존재하는가"를 넘어 "그 자료가 이 주장을 실제로 뒷받침하는가"를 본다.
// 비용 순서대로 걸러, 값싼 검사로 판정되지 않은 쌍만 모델에게 묻는다(한 번에 모아서).
//   1) 존재: 등록부에 있는 ID인가              — ID 인용이므로 S4 이후에는 사실상 항상 통과
//   2) 공식성: 공식 API 자료인가(외부 지식·첨부문서는 법적 근거가 아니다)
//   3) 시점: 검토 기준일에 효력이 있는가
//   4) 정렬: 주장 문장과 인용 원문의 의미 유사도(bge-m3)
//   5) 함의: 정렬이 낮은 쌍만 LLM이 SUPPORTS / PARTIAL / NOT_SUPPORTED로 판정
import { runStage } from '../stageRunner.js';
import { REASONING_SYSTEM } from '../prompts.js';
import { cosine, embedTexts } from '../embeddings.js';

export const ALIGNMENT_THRESHOLD = 0.55;
const MAX_ENTAILMENT_PAIRS = 12;

/** 요건 판단마다 주장 하나를 만든다. 주장 문장은 요건과 모델의 분석을 합친 것이다. */
export function collectClaims(issueResults) {
  const claims = [];
  for (const result of issueResults) {
    for (const a of result.assessments || []) {
      if (!a.evidenceIds.length) continue;
      const element = result.elements.find(e => e.id === a.elementId);
      claims.push({ claimId: `${result.issueId}:${a.elementId}`, issueId: result.issueId, elementId: a.elementId,
        text: [element?.text, a.analysis].filter(Boolean).join(' — '), evidenceIds: a.evidenceIds, status: a.status });
    }
  }
  return claims;
}

const entailmentSchema = pairCount => ({ type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', maxItems: pairCount, items: { type: 'object', additionalProperties: false,
    required: ['pair', 'label'], properties: { pair: { type: 'integer' }, label: { type: 'string', enum: ['SUPPORTS', 'PARTIAL', 'NOT_SUPPORTED'] } } } } } });

const ENTAILMENT_TASK = pairs => `[과제: 근거-주장 대응 확인]
아래 각 쌍에서 [근거] 원문이 [주장]을 뒷받침하는지만 판정한다. 근거에 없는 내용을 보태지 않는다.
SUPPORTS: 근거가 주장을 직접 뒷받침 / PARTIAL: 일부만 / NOT_SUPPORTED: 뒷받침하지 않거나 반대.
${pairs.map((p, i) => `(${i + 1}) [주장] ${p.claim}\n    [근거 ${p.evidenceId}] ${p.evidenceText}`).join('\n')}
출력 JSON 형식: {"results":[{"pair":1,"label":"SUPPORTS"}]}`;

/**
 * 주장별 근거 검증 원장을 만든다.
 * @param {object} args
 * @param {boolean} [args.entailment=true] 정렬이 낮은 쌍을 LLM으로 판정할지
 */
export async function verifyWarrants({ issueResults, registry, embed = embedTexts, entailment = true, prefix, provider, config, session }) {
  const claims = collectClaims(issueResults);
  const pairs = claims.flatMap(claim => claim.evidenceIds.map(evidenceId => ({ claim, evidenceId, entry: registry.get(evidenceId) })));
  const warnings = [];

  const { vectors, warning } = pairs.length
    ? await embed([...claims.map(c => c.text), ...pairs.map(p => p.entry?.text || '')])
    : { vectors: [], warning: null };
  if (warning) warnings.push(warning);
  const claimVector = new Map(claims.map((c, i) => [c.claimId, vectors[i]]));

  const checks = pairs.map((p, i) => {
    const entry = p.entry;
    const check = { claimId: p.claim.claimId, evidenceId: p.evidenceId,
      existence: entry ? 'PASS' : 'FAIL',
      official: entry?.official ? 'PASS' : 'FAIL',
      temporal: entry ? (entry.inForce ? 'PASS' : 'FAIL') : 'FAIL',
      alignment: null, entailment: null };
    const score = entry ? cosine(claimVector.get(p.claim.claimId), vectors[claims.length + i]) : null;
    check.alignmentScore = score === null ? null : Number(score.toFixed(3));
    check.alignment = score === null ? 'UNMEASURED' : score >= ALIGNMENT_THRESHOLD ? 'ALIGNED' : 'LOW';
    return check;
  });

  // 존재·공식성·시점을 통과했는데 정렬이 낮거나 잴 수 없었던 쌍만 모델에게 묻는다.
  const doubtful = checks.map((c, i) => ({ c, p: pairs[i] }))
    .filter(({ c }) => c.existence === 'PASS' && c.official === 'PASS' && c.temporal === 'PASS' && c.alignment !== 'ALIGNED');
  if (entailment && doubtful.length) {
    const batch = doubtful.slice(0, MAX_ENTAILMENT_PAIRS);
    if (doubtful.length > batch.length) warnings.push(`함의 확인 대상 ${doubtful.length}쌍 중 ${batch.length}쌍만 확인했습니다.`);
    try {
      const { value } = await runStage({ stage: 's6', provider, system: REASONING_SYSTEM, prefix,
        task: ENTAILMENT_TASK(batch.map(({ p }) => ({ claim: p.claim.text, evidenceId: p.evidenceId, evidenceText: String(p.entry.text).slice(0, 600) }))),
        schema: entailmentSchema(batch.length), config: { ...config, think: false }, session });
      for (const r of value.results) if (batch[r.pair - 1]) batch[r.pair - 1].c.entailment = r.label;
    } catch (err) {
      warnings.push(`근거-주장 함의 확인을 하지 못했습니다: ${err.message}`);
    }
  }

  // 주장 단위 판정: 공식·시점을 통과하고, 정렬됐거나 함의가 확인된 근거가 하나라도 있어야 한다.
  const ledger = claims.map(claim => {
    const own = checks.filter(c => c.claimId === claim.claimId);
    const usable = own.filter(c => c.existence === 'PASS' && c.official === 'PASS' && c.temporal === 'PASS');
    const supported = usable.some(c => c.alignment === 'ALIGNED' || c.entailment === 'SUPPORTS');
    const contradicted = usable.length > 0 && usable.every(c => c.entailment === 'NOT_SUPPORTED');
    const overall = !usable.length ? 'NO_OFFICIAL_SUPPORT' : contradicted ? 'NOT_SUPPORTED'
      : supported ? 'SUPPORTED' : 'UNCONFIRMED';
    return { claimId: claim.claimId, issueId: claim.issueId, elementId: claim.elementId, text: claim.text, checks: own, overall };
  });
  return { ledger, warnings, entailmentCalls: entailment && doubtful.length ? 1 : 0 };
}
