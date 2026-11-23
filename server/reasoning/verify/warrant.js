// server/reasoning/verify/warrant.js - 주장 × 근거 단위의 전수 함의 검증
// 유사도는 진단에만 쓴다. 근거가 주장을 뒷받침한다는 판정은 원문 함의 확인으로 결정한다.
import { runStage, StageError } from '../stageRunner.js';
import { REASONING_SYSTEM } from '../prompts.js';
import { cosine, embedTexts } from '../embeddings.js';

export const ALIGNMENT_THRESHOLD = 0.55;
const EVIDENCE_CHARS = 900;
const MIN_FRAGMENT_CHARS = 180;
// 한 (주장, 근거) 쌍에서 함의를 확인하는 조각 수의 상한. 긴 판례·해석례는 조각이 수십 개라 호출이 폭증한다.
// 조각이 이보다 많으면 주장과 의미가 가까운 조각부터 확인한다(짧은 조문은 영향 없음).
export const MAX_FRAGMENTS_PER_PAIR = 4;
// 모델이 충족·불충족을 판단한 요건. 미확정 요건은 아무것도 주장하지 않으므로 대조할 내용이 없다.
const DETERMINATE = new Set(['SATISFIED', 'NOT_SATISFIED', 'PARTIALLY_SATISFIED']);

export function collectClaims(issueResults, { contractMode = false } = {}) {
  const claims = [];
  for (const result of issueResults) {
    for (const a of result.assessments || []) {
      const element = result.elements.find(e => e.id === a.elementId);
      claims.push({ claimId: `${result.issueId}:${a.elementId}`, issueId: result.issueId, elementId: a.elementId,
        // 문서 판단의 '문서가 어긋난다'는 부분은 원문 인용으로 이미 확인했다. 여기서는 규정이 근거에 있는지를 대조한다.
        text: contractMode || a.verdict ? String(element?.text || a.analysis || '') : [element?.text, a.analysis].filter(Boolean).join(' — '),
        evidenceIds: a.authorityEvidenceIds || a.evidenceIds || [], status: a.status });
    }
  }
  return claims;
}

const entailmentSchema = { type: 'object', additionalProperties: false, required: ['label'],
  properties: { label: { type: 'string', enum: ['SUPPORTS', 'PARTIAL', 'NOT_SUPPORTED'] } } };

const ENTAILMENT_TASK = ({ claim, evidenceId, evidenceText }) => `[과제: 근거-주장 대응 확인]
[주장] ${claim}
[근거 ${evidenceId}] ${evidenceText}
근거 원문만으로 주장을 판정한다. 근거에 없는 내용을 보태지 않는다.
SUPPORTS: 직접 뒷받침 / PARTIAL: 일부만 또는 적용 범위 불명 / NOT_SUPPORTED: 뒷받침하지 않거나 반대.
출력 JSON 형식: {"label":"SUPPORTS"}`;

/** 원문 전체를 빠짐없이 작은 조각으로 나눈다. 오프셋은 원문 기준이다. */
export function evidenceFragments(text, maxChars = EVIDENCE_CHARS) {
  const value = String(text || '');
  if (!value) return [];
  const chunks = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + maxChars);
    if (end < value.length) {
      const slice = value.slice(start, end);
      const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('。'), slice.lastIndexOf('\n'));
      if (boundary > maxChars / 2) end = start + boundary + 1;
    }
    chunks.push({ start, end, text: value.slice(start, end) });
    start = end;
  }
  return chunks;
}

async function verifyFragment({ claim, evidenceId, fragment, registry, provider, config, session, calls, warnings }) {
  try {
    calls.count++;
    const { value } = await runStage({ stage: 's6', provider, system: REASONING_SYSTEM,
      prefix: `[검토 기준일] ${registry.asOf}`,
      task: ENTAILMENT_TASK({ claim, evidenceId, evidenceText: fragment.text }),
      schema: entailmentSchema, config: { ...config, think: false }, session });
    return { label: value.label, start: fragment.start, end: fragment.end };
  } catch (err) {
    if (err instanceof StageError && (err.budgetExceeded || err.cause?.truncated) && fragment.text.length > MIN_FRAGMENT_CHARS) {
      const half = Math.floor(fragment.text.length / 2);
      const left = { start: fragment.start, end: fragment.start + half, text: fragment.text.slice(0, half) };
      const right = { start: left.end, end: fragment.end, text: fragment.text.slice(half) };
      return [await verifyFragment({ claim, evidenceId, fragment: left, registry, provider, config, session, calls, warnings }),
        await verifyFragment({ claim, evidenceId, fragment: right, registry, provider, config, session, calls, warnings })].flat();
    }
    warnings.push(`근거-주장 함의 확인 실패(${evidenceId}, 원문 ${fragment.start}-${fragment.end}): ${err.message}`);
    return { label: null, start: fragment.start, end: fragment.end };
  }
}

/** 조각이 상한보다 많으면 주장과 의미가 가까운 조각을 골라 원문 순서로 돌려준다. 임베딩이 없으면 전부 확인한다. */
export async function pickFragments(fragments, claimText, embed, max) {
  if (fragments.length <= max) return fragments;
  const { vectors } = await embed([claimText, ...fragments.map(f => f.text)]);
  const [claimVector, ...fragmentVectors] = vectors;
  const scored = fragments.map((fragment, index) => ({ fragment, index, score: cosine(claimVector, fragmentVectors[index]) }));
  if (scored.some(x => x.score === null)) return fragments;
  return scored.sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.index - b.index).map(x => x.fragment);
}

function combineLabels(segments) {
  if (!segments.length || segments.some(s => !s.label)) return null;
  const labels = new Set(segments.map(s => s.label));
  if (labels.size === 1) return segments[0].label;
  return labels.has('SUPPORTS') || labels.has('PARTIAL') ? 'PARTIAL' : 'NOT_SUPPORTED';
}

/** 모든 공식·현행 근거 쌍을 검증한다. 토큰 초과는 근거 조각을 더 나눈다. */
export async function verifyWarrants({ issueResults, registry, embed = embedTexts, entailment = true, prefix, provider, config, session,
  contractMode = false, maxFragments = MAX_FRAGMENTS_PER_PAIR, policy = null }) {
  // policy.scope='DETERMINATE'(기본분석): 판단을 내린 요건만, 의미가 가장 가까운 근거부터 소수만 대조한다.
  const limited = policy?.scope === 'DETERMINATE';
  const asserted = claim => !limited || DETERMINATE.has(claim.status);
  const claims = collectClaims(issueResults, { contractMode });
  const pairs = claims.flatMap(claim => claim.evidenceIds.map(evidenceId => ({ claim, evidenceId, entry: registry.get(evidenceId) })));
  const warnings = [];
  const calls = { count: 0 };
  const checks = pairs.map(p => {
    const entry = p.entry;
    return { claimId: p.claim.claimId, evidenceId: p.evidenceId,
      existence: entry ? 'PASS' : 'FAIL', official: entry?.official ? 'PASS' : 'FAIL',
      temporal: entry?.inForce ? 'PASS' : 'FAIL',
      alignmentScore: null, alignment: 'UNMEASURED',
      entailment: null, segments: [] };
  });

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const check = checks[i];
    if (p.entry && !String(p.entry.text || '').trim()) warnings.push(`근거 ${p.evidenceId}에 확인할 원문이 없습니다.`);
    if (p.entry && check.official === 'PASS' && check.temporal === 'PASS') {
      const { vectors, warning } = await embed([p.claim.text, p.entry.text]);
      if (warning && !warnings.includes(warning)) warnings.push(warning);
      const score = cosine(vectors[0], vectors[1]);
      check.alignmentScore = score === null ? null : Number(score.toFixed(3));
      check.alignment = score === null ? 'UNMEASURED' : score >= ALIGNMENT_THRESHOLD ? 'ALIGNED' : 'LOW';
    }
    if (limited || !entailment || check.existence !== 'PASS' || check.official !== 'PASS' || check.temporal !== 'PASS') continue;
    const all = evidenceFragments(p.entry.text);
    const fragments = await pickFragments(all, p.claim.text, embed, maxFragments);
    check.skippedFragments = all.length - fragments.length;
    for (const fragment of fragments) {
      const result = await verifyFragment({ claim: p.claim.text, evidenceId: p.evidenceId, fragment, registry, provider,
        config, session, calls, warnings });
      check.segments.push(...(Array.isArray(result) ? result : [result]));
    }
    check.entailment = combineLabels(check.segments);
    // 일부 조각만 확인했다면 "뒷받침하지 않는다"는 판정을 확정할 수 없다(안 본 조각이 뒷받침할 수 있다).
    if (check.skippedFragments && check.entailment === 'NOT_SUPPORTED') check.entailment = 'PARTIAL';
  }

  const isUsable = c => c.existence === 'PASS' && c.official === 'PASS' && c.temporal === 'PASS';
  if (limited) {
    for (const claim of claims.filter(c => entailment && asserted(c))) {
      const own = pairs.map((p, i) => ({ p, check: checks[i] })).filter(x => x.p.claim === claim && isUsable(x.check))
        .sort((a, b) => (b.check.alignmentScore ?? -1) - (a.check.alignmentScore ?? -1));
      for (const { p, check } of own.slice(0, policy.pairsPerClaim)) {
        const all = evidenceFragments(p.entry.text);
        const fragments = (await pickFragments(all, p.claim.text, embed, policy.fragmentsPerPair)).slice(0, policy.fragmentsPerPair);
        check.skippedFragments = all.length - fragments.length;
        for (const fragment of fragments) {
          const result = await verifyFragment({ claim: p.claim.text, evidenceId: p.evidenceId, fragment, registry, provider,
            config, session, calls, warnings });
          check.segments.push(...(Array.isArray(result) ? result : [result]));
        }
        check.entailment = combineLabels(check.segments);
        if (check.skippedFragments && check.entailment === 'NOT_SUPPORTED') check.entailment = 'PARTIAL';
        if (check.entailment === 'SUPPORTS') break;
      }
    }
    for (const check of checks) if (isUsable(check) && !check.segments.length) check.skippedByDepth = true;
  }

  const ledger = claims.map(claim => {
    const own = checks.filter(c => c.claimId === claim.claimId);
    const usable = own.filter(isUsable);
    const supported = usable.some(c => c.entailment === 'SUPPORTS');
    const contradicted = usable.length > 0 && usable.every(c => c.entailment === 'NOT_SUPPORTED');
    // NOT_CHECKED: 기본분석이 일부러 대조하지 않은 주장. '확인했는데 안 맞음'과 구별한다.
    const overall = !asserted(claim) ? 'NOT_CHECKED' : !usable.length ? 'NO_OFFICIAL_SUPPORT' : contradicted ? 'NOT_SUPPORTED'
      : supported ? 'SUPPORTED' : usable.every(c => c.skippedByDepth) ? 'NOT_CHECKED' : 'UNCONFIRMED';
    return { claimId: claim.claimId, issueId: claim.issueId, elementId: claim.elementId, text: claim.text, checks: own, overall };
  });
  return { ledger, warnings, entailmentCalls: calls.count,
    unreviewedPairs: checks.filter(c => isUsable(c) && !c.entailment && !c.skippedByDepth)
      .map(c => ({ claimId: c.claimId, evidenceId: c.evidenceId })),
    coverage: { claims: claims.length, assertedClaims: claims.filter(asserted).length,
      supportedClaims: ledger.filter(w => w.overall === 'SUPPORTED').length,
      pairs: checks.filter(isUsable).length, checkedPairs: checks.filter(c => isUsable(c) && c.segments.length).length } };
}

/** 원문 자체에서 생성한 계약 finding이 정확히 그 D 조항과 이어지는지 확인한다. */
export function verifyDocumentFindings(findings, registry) {
  return findings.map(finding => {
    const checks = (finding.documentSupportIds || []).map(id => {
      const entry = registry.get(id);
      return { documentId: id, result: entry?.kind?.startsWith('DOCUMENT') && entry.text === finding.documentFinding
        ? 'SUPPORTED' : 'NOT_SUPPORTED' };
    });
    return { issueId: finding.issueId, kind: finding.kind, checks,
      overall: checks.length && checks.every(c => c.result === 'SUPPORTED') ? 'SUPPORTED' : 'NOT_SUPPORTED' };
  });
}
