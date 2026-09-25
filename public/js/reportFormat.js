// 화면과 다운로드가 같은 보고서 구조를 사용한다. 외부 답변/모델 출력은 항상 문자로 취급한다.
const ICON_TOKENS = /\b(?:merge_type|flag|gavel|rate_review|checklist)\b/gi;
export const stripReportMarkup = value => String(value ?? '')
  .replace(ICON_TOKENS, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)]+)\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/(^|\s)#{1,6}\s+/g, '$1')
  .replace(/\\([*_`|])/g, '$1')
  .trim();

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(stripReportMarkup);
const tableRule = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
const tableLine = line => /^\s*\|.*\|\s*$/.test(line);

export function parseReportBlocks(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let items = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: stripReportMarkup(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (items.length) blocks.push({ type: 'list', items });
    items = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    if (tableLine(line) && tableRule(lines[i + 1] || '')) {
      flushParagraph(); flushList();
      const headers = cells(line);
      i++;
      const rows = [];
      while (tableLine(lines[i + 1] || '') && !tableRule(lines[i + 1])) rows.push(cells(lines[++i]));
      blocks.push({ type: 'table', headers, rows });
      continue;
    }
    if (tableRule(line)) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bracket = /^\[([^\]]{2,80})\](?:\s+(.+))?$/.exec(line);
    const numbered = /^(\d+(?:\.\d+)*[.)])\s+(.+)$/.exec(line);
    if (heading || bracket || (numbered && /^(?:검토|핵심|전체|쟁점|조항|권고|추가|근거|부록|법률|리스크|계약)/.test(numbered[2]))) {
      flushParagraph(); flushList();
      blocks.push({ type: 'heading', level: heading ? Math.min(3, heading[1].length) : bracket ? 3 : 2,
        text: stripReportMarkup(heading?.[2] || (bracket ? `${bracket[1]}${bracket[2] ? ` · ${bracket[2]}` : ''}` : line)) });
      continue;
    }
    const bullet = /^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (bullet) { flushParagraph(); items.push(stripReportMarkup(bullet[1])); continue; }
    if (line.startsWith('> ')) {
      flushParagraph(); flushList();
      blocks.push({ type: 'quote', text: stripReportMarkup(line.slice(2)) });
      continue;
    }
    if (tableLine(line)) {
      flushParagraph(); flushList();
      blocks.push({ type: 'paragraph', text: cells(line).join(' · ') });
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph(); flushList();
  return blocks.filter(block => block.text !== '');
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function renderReportBlocksHtml(blocks) {
  return (blocks || []).map(block => {
    if (block.type === 'heading') {
      const tag = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
      return `<${tag} class="report-rich-heading report-rich-heading-${block.level}">${escapeHtml(block.text)}</${tag}>`;
    }
    if (block.type === 'list') return `<ul class="report-rich-list">${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    if (block.type === 'quote') return `<blockquote class="report-rich-quote">${escapeHtml(block.text)}</blockquote>`;
    if (block.type === 'table') return `<div class="table-responsive report-rich-table-wrap"><table class="legal-table report-rich-table"><thead><tr>${block.headers.map(cell => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${block.headers.map((_, i) => `<td>${escapeHtml(row[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    return `<p class="report-rich-paragraph">${escapeHtml(block.text)}</p>`;
  }).join('');
}
