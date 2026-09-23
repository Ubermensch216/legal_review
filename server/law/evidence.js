import { normalizeArticleNo } from './lawArticleRef.js';

export const normalizedLawName = value => String(value || '').replace(/[\s「」『』]/g, '');
export const sameLaw = (a, b) => Boolean(normalizedLawName(a)) && normalizedLawName(a) === normalizedLawName(b);
export const matchesLaw = (record, name) => sameLaw(record?.lawName, name) || sameLaw(record?.lawNameShort, name);
export const isOfficial = record => Boolean(record && record.source === 'OFFICIAL_API' && !record.isMockData);
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');

export function validDate(value) {
  const raw = String(value || '');
  if (!/^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(raw)) return '';
  const date = raw.replaceAll('-', '');
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso) ? date : '';
}

// 조문·법령이 기준 시점에 효력을 가지는지 판단한다. 기준일을 주지 않으면 오늘이다.
export const inForceAt = (record, asOf) =>
  Boolean(record) && !record.isDeleted && (!record.enforceDate || record.enforceDate <= (validDate(asOf) || today()));

// 기준 시점에 시행 중이던 법령 버전을 고른다.
// 공포일이 아니라 시행일로 결정한다. 같은 날 시행된 버전이 여럿이면 나중에 공포된 것을 쓴다.
export function selectVersionAt(versions, asOf) {
  const date = validDate(asOf);
  if (!date) return null;
  return (versions || [])
    .filter(v => isOfficial(v) && validDate(v.enforceDate) && v.enforceDate <= date)
    .sort((a, b) => b.enforceDate.localeCompare(a.enforceDate)
      || String(b.promulDate || '').localeCompare(String(a.promulDate || ''))
      || Number(b.lawSeq) - Number(a.lawSeq))[0] || null;
}

// 과거·미래 시점 검토임을 알리는 문구. LLM 프롬프트와 출력 보고서가 같은 문장을 써야
// 중복 제거가 되고, 어느 경로로 나가든 같은 사실이 같은 표현으로 남는다.
export const historicalReviewNotice = date =>
  `${date} 시점에 시행 중이던 법령을 기준으로 검토했습니다. 현행 법령과 다를 수 있으며, 부칙·경과조치에 따른 개별 사안 적용 여부는 별도 검토가 필요합니다.`;

export function articleText(article) {
  const parts = [article?.content || ''];
  for (const p of article?.paragraphs || []) {
    parts.push(p.content || '');
    for (const item of p.items || []) {
      parts.push(item.content || '');
      for (const sub of item.subItems || []) parts.push(sub.content || '');
    }
  }
  return [...new Set(parts.filter(Boolean))].join('\n');
}

export function exactArticle(articles, number) {
  const key = normalizeArticleNo(number);
  return key ? (articles || []).find(a => normalizeArticleNo(a.fullArticleNo || a.articleNo) === key) : undefined;
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

/**
 * 항·호 번호를 숫자 문자열로 통일한다. 공식 API는 항 번호를 '①'처럼 원문자로 준다.
 * 숫자만 찾으면 원문자 항이 모두 '없음'이 되어, 항까지 적은 인용이 존재 확인에서 전부 떨어진다.
 */
export const unitNumber = value => {
  const text = String(value || '').trim();
  const digits = text.match(/\d+/)?.[0];
  if (digits) return digits;
  const circled = CIRCLED.indexOf(text.charAt(0));
  return circled >= 0 ? String(circled + 1) : '';
};

// Existence of an article does not establish existence of its cited paragraph/item.
export function containsCitation(article, citation) {
  if (!article || article.isDeleted || !articleText(article).trim()) return false;
  const pNo = citation.match(/제?\s*(\d+)\s*항/)?.[1];
  const iNo = citation.match(/제?\s*(\d+)\s*호/)?.[1];
  const sNo = citation.match(/([가-힣])\s*목/)?.[1];
  const paragraphs = pNo ? (article.paragraphs || []).filter(p => unitNumber(p.paragraphNo) === pNo) : article.paragraphs || [];
  if (pNo && !paragraphs.length) return false;
  const items = paragraphs.flatMap(p => p.items || []).filter(i => !iNo || unitNumber(i.itemNo) === iNo);
  if (iNo && !items.length) return false;
  if (sNo && !items.some(i => (i.subItems || []).some(s => String(s.subItemNo).replace(/[.\s목]/g, '') === sNo))) return false;
  return true;
}

export function unavailableList(status, reason) {
  return Object.assign([], { fetchStatus: status, unavailableReason: reason });
}
