import { chunkLegalDocument } from './legalDocChunker.js';
import { findSalienceAnchors, salienceScore } from './clauseSalience.js';

const NOTICE = '\n※ 문서 일부만 발췌했습니다. 생략한 부분과 예외 조건은 원문 확인이 필요합니다.';
const GAP = '\n[생략]\n';
const PARTIAL_MARK = '\n[부분 발췌]';
const MIN_WINDOW = 120;
const MAX_WINDOWS = 4;

/** 앵커 가중치. 위험 룰셋 > 질의 일치 > 구조 표지 순이며, 머리·꼬리는 구조 표지보다 앞선다. */
const WEIGHT = { risk: 30, query: 18, tail: 11, head: 10 };

const occurrences = (haystack, needle, limit = 3) => {
  const found = [];
  if (!needle) return found;
  for (let at = haystack.indexOf(needle); at >= 0 && found.length < limit; at = haystack.indexOf(needle, at + needle.length)) found.push(at);
  return found;
};

/**
 * 조항 안에서 발췌 기준점을 모은다.
 * 위험 키워드와 질의어가 하나도 없더라도 구조 표지와 머리·꼬리 기준점이 남으므로
 * 발췌가 조항 앞부분으로만 쏠리지 않는다.
 */
function collectAnchors(text, riskTerms, queryTerms) {
  const lower = text.toLowerCase();
  const anchors = [];
  for (const term of riskTerms) for (const position of occurrences(lower, term.toLowerCase())) anchors.push({ position, weight: WEIGHT.risk, kind: 'RISK' });
  for (const term of queryTerms) for (const position of occurrences(lower, term.toLowerCase())) anchors.push({ position, weight: WEIGHT.query, kind: 'QUERY' });
  for (const hit of findSalienceAnchors(text)) anchors.push({ position: hit.position, weight: hit.weight, kind: `SALIENCE_${hit.category}` });
  anchors.push({ position: 0, weight: WEIGHT.head, kind: 'COVERAGE_HEAD' });
  anchors.push({ position: Math.max(0, text.length - 1), weight: WEIGHT.tail, kind: 'COVERAGE_TAIL' });
  return anchors;
}

/** 가중치 순으로 고르되 서로 너무 가까운 기준점은 한 창으로 합쳐 중복 발췌를 막는다. */
function pickAnchors(anchors, max, separation) {
  const chosen = [];
  for (const anchor of [...anchors].sort((a, b) => b.weight - a.weight || a.position - b.position)) {
    if (chosen.length >= max) break;
    if (chosen.some(c => Math.abs(c.position - anchor.position) < separation)) continue;
    chosen.push(anchor);
  }
  return chosen.sort((a, b) => a.position - b.position);
}

const mergeSpans = spans => spans.reduce((merged, span) => {
  const last = merged[merged.length - 1];
  if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
  else merged.push({ ...span });
  return merged;
}, []);

const spanCost = spans => spans.reduce((n, s) => n + (s.end - s.start), 0) + (spans.length - 1) * GAP.length + PARTIAL_MARK.length;

/** 창이 합쳐져 남은 예산은 각 창을 넓히는 데 되돌린다. */
function growSpans(spans, length, budget) {
  for (let round = 0; round < 3; round++) {
    const surplus = budget - spanCost(spans);
    const covered = spans.reduce((n, s) => n + (s.end - s.start), 0);
    if (surplus <= spans.length || covered >= length) break;
    const share = Math.floor(surplus / spans.length);
    for (const span of spans) {
      span.end = Math.min(length, span.end + Math.ceil(share / 2));
      span.start = Math.max(0, span.start - Math.floor(share / 2));
    }
    spans = mergeSpans(spans.sort((a, b) => a.start - b.start));
  }
  // 넓히다가 예산을 넘겼으면 마지막 창부터 줄인다.
  for (let i = spans.length - 1; i >= 0 && spanCost(spans) > budget; i--) {
    spans[i].end = Math.max(spans[i].start, spans[i].end - (spanCost(spans) - budget));
  }
  return spans.filter(s => s.end > s.start);
}

function planSpans(text, budget, riskTerms, queryTerms) {
  const maxWindows = Math.max(1, Math.min(MAX_WINDOWS, Math.floor(budget / MIN_WINDOW)));
  const separation = Math.max(180, Math.floor((budget / maxWindows) * 0.8));
  const picked = pickAnchors(collectAnchors(text, riskTerms, queryTerms), maxWindows, separation);
  const available = Math.max(MIN_WINDOW, budget - ((picked.length - 1) * GAP.length + PARTIAL_MARK.length));
  const size = Math.max(40, Math.floor(available / picked.length));
  const spans = picked.map(anchor => {
    const start = Math.min(Math.max(0, anchor.position - Math.floor(size / 4)), Math.max(0, text.length - size));
    return { start, end: Math.min(text.length, start + size) };
  }).sort((a, b) => a.start - b.start);
  return growSpans(mergeSpans(spans), text.length, budget);
}

/** Select relevant clauses with a strict character budget, including labels and omission notice. */
export function optimizeDocumentContext({ documentText = '', query = '', maxChars = 4500 }) {
  maxChars = Math.max(0, Math.floor(Number(maxChars) || 0));
  const chunks = chunkLegalDocument(documentText || '');
  if (documentText.length <= maxChars) return { optimizedText: documentText, totalChunks: chunks.length, selectedChunks: chunks, omittedCount: 0, truncatedCount: 0 };
  const terms = [...new Set(String(query).toLowerCase().split(/[^\w가-힣]+/).filter(x => x.length >= 2))];
  const candidates = chunks.map((chunk, index) => ({ chunk, index, score:
    (chunk.riskLevel === 'HIGH' ? 50 : chunk.riskLevel === 'MEDIUM' ? 25 : 0) +
    terms.reduce((n, t) => n + (chunk.content.toLowerCase().includes(t) ? 15 : 0) + (chunk.title.toLowerCase().includes(t) ? 30 : 0), 0) +
    // 위험 룰셋과 질의어가 모두 비껴간 조항이 단순 배경 설명과 같은 순위로 밀리지 않게 한다.
    Math.min(salienceScore(chunk.content), 20)
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  let remaining = Math.max(0, maxChars - NOTICE.length);
  // Reserve room for several clauses instead of allowing the first large clause to consume everything.
  const perClause = candidates.length > 1 ? Math.max(160, Math.floor(remaining / Math.min(candidates.length, 3))) : remaining;
  const selected = [];
  for (const { chunk, index } of candidates) {
    const header = `### ${chunk.articleNo} (${chunk.title})\n`;
    const budget = Math.min(remaining, perClause) - header.length - 2;
    if (budget < 40) continue;
    let text = chunk.content;
    let excerptSpans = [{ start: 0, end: text.length }];
    const partial = text.length > budget;
    if (partial) {
      excerptSpans = planSpans(text, budget, chunk.riskTags.flatMap(tag => tag.matchedKeywords || []), terms);
      text = excerptSpans.map(span => text.slice(span.start, span.end)).join(GAP) + PARTIAL_MARK;
    }
    const rendered = header + text;
    selected.push({ index, rendered, chunk: { ...chunk, excerpt: text, excerptStart: excerptSpans[0].start, excerptSpans, isPartial: partial } });
    remaining -= rendered.length + 2;
  }
  selected.sort((a, b) => a.index - b.index);
  const optimizedText = (selected.map(s => s.rendered).join('\n\n') + NOTICE).slice(0, maxChars);
  return { optimizedText, totalChunks: chunks.length, selectedChunks: selected.map(s => s.chunk),
    omittedCount: chunks.length - selected.length, truncatedCount: selected.filter(s => s.chunk.isPartial).length };
}
export default { optimizeDocumentContext };
