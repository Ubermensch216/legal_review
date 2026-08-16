// server/law/tools/articleDiff.js
import { computeDiff, renderDiffHtml } from '../lawDiff.js';

export async function execute(params = {}) {
  const { oldText = '', newText = '' } = params;
  if (!oldText && !newText) {
    throw new Error('비교할 텍스트(oldText 또는 newText)가 필요합니다.');
  }

  const diffChunks = computeDiff(oldText, newText);
  const diffHtml = renderDiffHtml(diffChunks);

  const stats = {
    addedWords: diffChunks.filter(c => c.type === 'added').length,
    removedWords: diffChunks.filter(c => c.type === 'removed').length,
    unchangedWords: diffChunks.filter(c => c.type === 'unchanged').length
  };

  return {
    stats,
    diffChunks,
    diffHtml
  };
}

export default { execute };
