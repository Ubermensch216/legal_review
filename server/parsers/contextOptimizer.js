import { chunkLegalDocument } from './legalDocChunker.js';

/** Select relevant clauses with a strict character budget, including labels and omission notice. */
export function optimizeDocumentContext({ documentText = '', query = '', maxChars = 4500 }) {
  maxChars = Math.max(0, Math.floor(Number(maxChars) || 0));
  const chunks = chunkLegalDocument(documentText || '');
  if (documentText.length <= maxChars) return { optimizedText: documentText, totalChunks: chunks.length, selectedChunks: chunks, omittedCount: 0, truncatedCount: 0 };
  const terms = [...new Set(String(query).toLowerCase().split(/[^\w가-힣]+/).filter(x => x.length >= 2))];
  const candidates = chunks.map((chunk, index) => ({ chunk, index, score:
    (chunk.riskLevel === 'HIGH' ? 50 : chunk.riskLevel === 'MEDIUM' ? 25 : 0) +
    terms.reduce((n, t) => n + (chunk.content.toLowerCase().includes(t) ? 15 : 0) + (chunk.title.toLowerCase().includes(t) ? 30 : 0), 0)
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const notice = '\n※ 문서 일부만 발췌했습니다. 생략한 부분과 예외 조건은 원문 확인이 필요합니다.';
  let remaining = Math.max(0, maxChars - notice.length);
  // Reserve room for several clauses instead of allowing the first large clause to consume everything.
  const perClause = candidates.length > 1 ? Math.max(160, Math.floor(remaining / Math.min(candidates.length, 3))) : remaining;
  const selected = [];
  for (const { chunk, index } of candidates) {
    const header = `### ${chunk.articleNo} (${chunk.title})\n`;
    const budget = Math.min(remaining, perClause) - header.length - 2;
    if (budget < 40) continue;
    let text = chunk.content;
    let start = 0;
    let excerptSpans = [{ start: 0, end: text.length }];
    const partial = text.length > budget;
    if (partial) {
      const riskTerms = chunk.riskTags.flatMap(tag => tag.matchedKeywords || []);
      const hits = [...new Set((riskTerms.length ? riskTerms : terms).map(t => text.toLowerCase().indexOf(t.toLowerCase())).filter(n => n >= 0))].sort((a, b) => a - b);
      const anchors = (hits.length ? hits : [0]).filter((hit, i, all) => i === 0 || hit - all[i - 1] > 180).slice(0, 3);
      const windowSize = Math.floor((budget - 14 - (anchors.length - 1) * 8) / anchors.length);
      excerptSpans = anchors.map(hit => {
        const offset = Math.min(Math.max(0, hit - Math.floor(windowSize / 4)), Math.max(0, text.length - windowSize));
        return { start: offset, end: Math.min(text.length, offset + windowSize) };
      });
      start = excerptSpans[0].start;
      text = excerptSpans.map(span => text.slice(span.start, span.end)).join('\n[생략]\n') + '\n[부분 발췌]';
    }
    const rendered = header + text;
    selected.push({ index, rendered, chunk: { ...chunk, excerpt: text, excerptStart: start, excerptSpans, isPartial: partial } });
    remaining -= rendered.length + 2;
  }
  selected.sort((a, b) => a.index - b.index);
  const optimizedText = (selected.map(s => s.rendered).join('\n\n') + notice).slice(0, maxChars);
  return { optimizedText, totalChunks: chunks.length, selectedChunks: selected.map(s => s.chunk),
    omittedCount: chunks.length - selected.length, truncatedCount: selected.filter(s => s.chunk.isPartial).length };
}
export default { optimizeDocumentContext };
