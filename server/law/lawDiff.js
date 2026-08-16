// server/law/lawDiff.js - 법령 개정 전후 조문 Diff 비교 엔진

/**
 * 단순 단어/토큰 분리
 */
function tokenize(text) {
  if (!text) return [];
  // 공백 및 구두점 기준 분리하되 구분자 보존
  return text.split(/(\s+|[.,;:\n()])/).filter(t => t.length > 0);
}

/**
 * 두 텍스트 간의 단어 단위 LCS(Longest Common Subsequence) Diff 계산
 * @param {string} oldText 
 * @param {string} newText 
 * @returns {Array<{type: 'unchanged'|'added'|'removed', value: string}>}
 */
export function computeDiff(oldText = '', newText = '') {
  if (!oldText && !newText) return [];
  if (!oldText) return [{ type: 'added', value: newText }];
  if (!newText) return [{ type: 'removed', value: oldText }];

  const tokensOld = tokenize(oldText);
  const tokensNew = tokenize(newText);

  const m = tokensOld.length;
  const n = tokensNew.length;

  // DP Matrix for LCS
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (tokensOld[i - 1] === tokensNew[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtracking
  let i = m;
  let j = n;
  const rawDiff = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensOld[i - 1] === tokensNew[j - 1]) {
      rawDiff.unshift({ type: 'unchanged', value: tokensOld[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.unshift({ type: 'added', value: tokensNew[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawDiff.unshift({ type: 'removed', value: tokensOld[i - 1] });
      i--;
    }
  }

  // 인접한 동일 타입 병합
  const merged = [];
  for (const chunk of rawDiff) {
    if (merged.length > 0 && merged[merged.length - 1].type === chunk.type) {
      merged[merged.length - 1].value += chunk.value;
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged;
}

/**
 * HTML 포맷으로 Diff 렌더링
 * @param {Array<{type: string, value: string}>} diffs 
 * @returns {string}
 */
export function renderDiffHtml(diffs) {
  return diffs.map(d => {
    const escaped = d.value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    if (d.type === 'added') {
      return `<ins class="diff-added">${escaped}</ins>`;
    } else if (d.type === 'removed') {
      return `<del class="diff-removed">${escaped}</del>`;
    }
    return `<span>${escaped}</span>`;
  }).join('');
}

export default {
  computeDiff,
  renderDiffHtml
};
