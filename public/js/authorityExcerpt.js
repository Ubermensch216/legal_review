// public/js/authorityExcerpt.js - 판례·유권해석 본문 정제와 의뢰 내용 관련 부분 발췌
// 서버 파서도 stripLegalTags를 함께 쓴다. 브라우저 API에 의존하지 않는다.

// 법령 본문의 <개정 2020. 1. 1.> 같은 꺾쇠 표기를 지우지 않도록 알려진 HTML 태그만 대상으로 한다.
const BREAK_TAG = /(?:<|&lt;)\s*(?:br|\/p|\/div|\/li|\/tr)\b[^<>]*?\/?\s*(?:>|&gt;)/gi;
const INLINE_TAG = /(?:<|&lt;)\s*\/?\s*(?:p|div|span|font|b|i|u|em|strong|sup|sub|li|ul|ol|table|tbody|thead|tr|td|th|a|center)\b[^<>]*?(?:>|&gt;)/gi;

export const stripLegalTags = value => String(value ?? '')
  .replace(BREAK_TAG, '\n')
  .replace(INLINE_TAG, '');

/** 화면 표시용: 태그를 없애고 공백과 빈 줄을 정돈한다. */
export const cleanLegalMarkup = value => stripLegalTags(value)
  .replace(/&nbsp;| /g, ' ')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/ ?\n ?/g, '\n')
  .replace(/\n{2,}/g, '\n')
  .trim();

/** [1] [2] 번호 단위로 나눈다. 번호가 없으면 줄 단위 문단으로 돌려준다. */
export function splitLegalParagraphs(value) {
  const text = cleanLegalMarkup(value);
  if (!text) return [];
  const numbered = text.split(/(?=\[\d{1,2}\])/).map(s => s.trim()).filter(s => /^\[\d{1,2}\]/.test(s));
  if (numbered.length >= 2) {
    return numbered.map(part => ({
      no: Number(part.match(/^\[(\d{1,2})\]/)[1]),
      text: part.replace(/^\[\d{1,2}\]\s*/, '').replace(/\s*\n\s*/g, ' ').trim()
    }));
  }
  // 원문의 고정폭 줄바꿈이 문장 중간을 끊는 경우가 있어, 문장이 끝나지 않은 줄은 다음 줄과 잇는다.
  const paragraphs = [];
  for (const line of text.replace(/^\[\d{1,2}\]\s*/, '').split('\n').map(s => s.trim()).filter(Boolean)) {
    const previous = paragraphs[paragraphs.length - 1];
    if (previous && !/[.:;。)]$/.test(previous) && !/^(?:[○●■□◇◆▶※•·-]|\d+[.)]|[가-힣][.)])/.test(line)) {
      paragraphs[paragraphs.length - 1] = `${previous} ${line}`;
    } else paragraphs.push(line);
  }
  return paragraphs.map(part => ({ no: null, text: part }));
}

// "2024. 10. 22." 같은 날짜에서 끊기지 않도록 '다.'로 끝나는 곳만 문장 경계로 본다.
const splitSentences = text => String(text).split(/(?<=다\.|다\)\.)\s+/).map(s => s.trim()).filter(Boolean);

const STOP_TERMS = new Set(['검토', '분석', '사안', '내용', '여부', '부적정', '적정', '해주세요', '바랍니다', '경우', '관련', '문서',
  '첨부', '대한', '관한', '위한', '따른', '통해', '있는지', '없는지', '어떤', '무엇', '부분', '사항', '기준', '수정', '필요',
  '주요', '해당', '대하여', '관하여', '있었는가', '하였는가', '되었는가', '것인가', '인가', '본안', '법령', '규정', '조항',
  '적용', '방식', '운영', '근로자', '시', '및', '등']);
const JOSA = /(?:으로서|으로써|에게서|에서의|에서|으로|에게|까지|부터|와의|과의|하였는가|되었는가|하는가|인가|은|는|이|가|을|를|의|에|와|과|도|로)$/;

function questionTerms(text) {
  return String(text || '').split(/[^0-9A-Za-z가-힣]+/)
    .map(word => (word.length >= 3 ? word.replace(JOSA, '') : word))
    .filter(word => word.length >= 2 && /[가-힣]/.test(word) && !STOP_TERMS.has(word));
}

/**
 * 의뢰 내용에서 발췌 기준을 모은다.
 * 첨부문서 검토는 질의문이 비어 있을 수 있어 분석이 뽑은 쟁점과 검색어를 함께 쓴다.
 */
export function buildRelevanceContext(data) {
  const reasoning = data?.review?.reasoning;
  const issues = reasoning?.issues || [];
  const strong = new Set(issues.flatMap(issue => issue.searchTerms || []).map(t => String(t).trim()).filter(t => t.length >= 2 && !STOP_TERMS.has(t)));
  const weak = new Set([data?.meta?.query, ...issues.map(issue => issue.question)].flatMap(questionTerms).filter(t => !strong.has(t)));

  // 분석 단계가 쟁점과 관련 있다고 판단한 판례의 가장 가까운 명제 번호
  const evidence = new Map((reasoning?.evidence || []).map(item => [item.id, item]));
  const focusByCase = new Map();
  for (const issue of issues) {
    for (const candidate of issue.research?.candidates || []) {
      const match = /^(P\d+)\.y(\d+)$/.exec(candidate.focusId || '');
      const caseNo = match && evidence.get(match[1])?.caseNo;
      if (!caseNo || candidate.relevanceRole === 'NOT_RELEVANT') continue;
      if (!focusByCase.has(caseNo)) focusByCase.set(caseNo, new Set());
      focusByCase.get(caseNo).add(Number(match[2]));
    }
  }
  return { strong: [...strong], weak: [...weak], focusByCase };
}

function clipAround(sentence, terms, max) {
  if (sentence.length <= max) return sentence;
  const hits = terms.map(term => sentence.indexOf(term)).filter(i => i >= 0);
  const anchor = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, anchor - Math.floor(max * 0.3));
  if (start > 0) {
    const comma = sentence.indexOf(', ', start);
    start = comma >= 0 && comma < anchor ? comma + 2 : (sentence.indexOf(' ', start) + 1 || start);
  }
  let end = Math.min(sentence.length, start + max);
  if (end < sentence.length) {
    const cut = sentence.lastIndexOf(' ', end);
    if (cut > start + max * 0.6) end = cut;
  }
  return `${start > 0 ? '… ' : ''}${sentence.slice(start, end).trim()}${end < sentence.length ? ' …' : ''}`;
}

/**
 * 본문에서 의뢰 내용과 맞닿는 문장만 고른다.
 * 일치하는 부분이 없으면 임의의 문장을 보여주지 않고 matched=false로 돌려준다.
 * @param {{label: string, text: string}[]} sections 우선순위 순서의 본문 구역
 */
export function buildAuthorityExcerpt(sections, context, { caseNo = '', extraTerms = [], maxPassages = 2, maxChars = 230 } = {}) {
  const strong = [...new Set([...(context?.strong || []), ...extraTerms.filter(t => /[가-힣]/.test(t) && !/^제\d/.test(t) && !STOP_TERMS.has(t))])];
  const weak = context?.weak || [];
  const focus = context?.focusByCase?.get(caseNo);
  const candidates = [];

  sections.forEach((section, sectionIndex) => {
    splitLegalParagraphs(section.text).forEach((paragraph, paragraphIndex) => {
      const sentences = splitSentences(paragraph.text);
      let best = null;
      sentences.forEach((sentence, sentenceIndex) => {
        const strongHits = strong.filter(term => sentence.includes(term));
        const weakHits = weak.filter(term => sentence.includes(term));
        const score = strongHits.length * 3 + weakHits.length;
        if (!best || score > best.score) best = { sentence, sentenceIndex, score, terms: [...strongHits, ...weakHits] };
      });
      if (!best) return;
      const focused = sectionIndex === 0 && paragraph.no !== null && focus?.has(paragraph.no);
      // 쟁점 핵심어가 있으면 '근로자'처럼 흔한 단어 몇 개만 겹친 문장은 관련 있다고 보지 않는다.
      const strongHit = best.terms.some(term => strong.includes(term));
      const enoughWeak = best.terms.length >= (strong.length ? 3 : 2);
      if (!focused && !strongHit && !enoughWeak) return;
      // 원칙만 잘라 보여주면 뜻이 달라질 수 있어 바로 뒤의 단서("다만")는 함께 싣는다.
      const proviso = /^다만[,，\s]/.test(sentences[best.sentenceIndex + 1] || '') ? sentences[best.sentenceIndex + 1] : '';
      candidates.push({
        label: section.label, no: paragraph.no, terms: best.terms, order: [sectionIndex, paragraphIndex],
        rank: best.score + (focused ? 3 : 0),
        text: clipAround(best.sentence, best.terms, maxChars) + (proviso ? ` ${clipAround(proviso, best.terms, Math.floor(maxChars * 0.6))}` : '')
      });
    });
  });

  const passages = candidates.sort((a, b) => b.rank - a.rank).slice(0, maxPassages)
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
    .map(({ label, no, text, terms }) => ({ label, no, text, terms }));
  return { matched: passages.length > 0, passages };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function highlight(text, terms) {
  const unique = [...new Set(terms)].sort((a, b) => b.length - a.length);
  if (!unique.length) return escapeHtml(text);
  const pattern = new RegExp(`(${unique.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return String(text).split(pattern).map((piece, i) => (i % 2 ? `<mark>${escapeHtml(piece)}</mark>` : escapeHtml(piece))).join('');
}

export function renderAuthorityExcerptHtml(excerpt, fullLabel = '전문') {
  if (!excerpt?.matched) {
    return `<p class="authority-excerpt-empty">의뢰 내용과 직접 일치하는 부분을 찾지 못했습니다. ${escapeHtml(fullLabel)}에서 확인하세요.</p>`;
  }
  return `<div class="authority-excerpt">
    <div class="authority-excerpt-title">의뢰 내용 관련 발췌</div>
    ${excerpt.passages.map(p => `<div class="authority-excerpt-item">
      <span class="authority-excerpt-source">${escapeHtml(p.label)}${p.no ? ` [${p.no}]` : ''}</span>
      <p>${highlight(p.text, p.terms)}</p>
    </div>`).join('')}
  </div>`;
}
