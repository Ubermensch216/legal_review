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
  const selected = [];
  for (const { chunk, index } of candidates) {
    const header = `### ${chunk.articleNo} (${chunk.title})\n`;
    const budget = remaining - header.length - 2;
    if (budget < 40) continue;
    let text = chunk.content;
    let start = 0;
    const partial = text.length > budget;
    if (partial) {
      const hits = terms.map(t => text.toLowerCase().indexOf(t)).filter(n => n >= 0);
      start = Math.max(0, (hits.length ? Math.min(...hits) : 0) - Math.floor(budget / 4));
      start = Math.min(start, Math.max(0, text.length - budget + 14));
      text = text.slice(start, start + budget - 14) + '\n[부분 발췌]';
    }
    const rendered = header + text;
    selected.push({ index, rendered, chunk: { ...chunk, excerpt: text, excerptStart: start, isPartial: partial } });
    remaining -= rendered.length + 2;
  }
  selected.sort((a, b) => a.index - b.index);
  const optimizedText = (selected.map(s => s.rendered).join('\n\n') + notice).slice(0, maxChars);
  return { optimizedText, totalChunks: chunks.length, selectedChunks: selected.map(s => s.chunk),
    omittedCount: chunks.length - selected.length, truncatedCount: selected.filter(s => s.chunk.isPartial).length };
}
export default { optimizeDocumentContext };
