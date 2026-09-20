export class DecisionDataError extends Error {
  constructor(code, message) { super(message); this.name = 'DecisionDataError'; this.code = code; }
}

// Counts describe retrieval availability, never legal accuracy or relevance.
export function summarizeAvailability(items = []) {
  const failures = {};
  let fullTextCount = 0;
  for (const item of items) {
    if (item.source === 'OFFICIAL_API' && item.contentStatus === 'FULL_TEXT' && !item.isMockData) fullTextCount++;
    else {
      const code = item.detailErrorCode || (item.isMockData ? 'DEMO_DATA' : 'BODY_NOT_FETCHED');
      failures[code] = (failures[code] || 0) + 1;
    }
  }
  return { listCount: items.length, fullTextCount, unavailableCount: items.length - fullTextCount,
    status: items.fetchStatus || (!items.length ? 'EMPTY' : fullTextCount === items.length ? 'COMPLETE' : 'PARTIAL'), failures };
}
