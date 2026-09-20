import { normalizeArticleNo } from '../../server/law/lawArticleRef.js';
import { normalizedLawName } from '../../server/law/evidence.js';

export function scoreCitations(review, expectedArticles, targetLaw) {
  const key = (law, article) => `${normalizedLawName(law)}:${normalizeArticleNo(article)}`;
  const expected = new Set(expectedArticles.map(a => typeof a === 'object' ? key(a.lawName, a.articleNo) : key(targetLaw, a)));
  const basis = Array.isArray(review.legalBasis) ? review.legalBasis : [];
  const cited = [...new Set(basis.map(b => key(b.lawName, b.articleNo)))];
  if (!cited.length || !expected.size) return { measurable: false, precision: null, recall: null, cited, hit: [], missed: [...expected] };
  const verified = new Set(basis.filter(b => b.verificationStatus === 'VERIFIED').map(b => key(b.lawName, b.articleNo)));
  const hit = cited.filter(c => expected.has(c) && verified.has(c));
  return { measurable: true, precision: Math.round(hit.length / cited.length * 100), recall: Math.round(hit.length / expected.size * 100),
    cited, hit, missed: [...expected].filter(e => !hit.includes(e)) };
}
