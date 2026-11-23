// server/reasoning/stages/statuteLinking.js - 쟁점 ↔ 조문 후보 연결 (LLM 호출 없음)
//
// S1이 쟁점을 세우면서 연결한 조문 ID가 비어 있으면 S3 요건 분해·S4 포섭·S6 검증이 모두 건너뛰어져
// 결과가 판단 없는 문장 조립이 된다(저장된 검토 3건에서 쟁점 5개가 모두 조문 0개).
// 소형 모델에게 ID 고르기를 맡기지 않고, 쟁점의 질문·검색어·관련 사실이 조문의 제목과 본문에
// 닿는 정도와 문서가 그 조문을 직접 인용했는지로 후보를 먼저 연결한다.
// 후보일 뿐이다. 맞는지는 이후 요건 분해·포섭·근거 검증이 판단한다.

const JOSA = /(?:으로써|으로서|에서의|에게서|으로|에서|에게|까지|부터|와의|과의|하였는가|되었는가|하는가|인가|은|는|이|가|을|를|의|에|와|과|도|로)$/;
// 법률 문장에서 쟁점을 가리지 못하는 말. 이런 단어가 겹쳤다고 조문이 관련 있다고 보지 않는다.
const STOP = new Set(['여부', '경우', '관련', '사항', '내용', '기준', '규정', '법령', '조항', '해당', '대한', '관한', '위한', '따른', '통해',
  '있는지', '없는지', '무엇', '어떤', '어떻게', '검토', '판단', '적용', '문서', '첨부', '사안', '요건', '효력', '위반', '적법', '부적정', '적정',
  '하였는가', '되었는가', '있는가', '없는가', '하는가', '근로자', '사용자', '회사', '기관', '직원', '업무']);

/** 한국어 어절에서 조사를 떼고 2자 이상 의미 단어만 남긴다. */
export function extractTerms(...texts) {
  const terms = [];
  for (const text of texts) {
    for (const word of String(text || '').split(/[^0-9A-Za-z가-힣]+/)) {
      if (!word) continue;
      const stem = word.length >= 3 ? word.replace(JOSA, '') : word;
      if (stem.length >= 2 && /[가-힣A-Za-z]/.test(stem) && !STOP.has(stem) && !terms.includes(stem)) terms.push(stem);
    }
  }
  return terms;
}

// 거의 모든 조문에 나와 쟁점을 가리지 못하는 앞 두 글자. 어간 일치에서 뺀다.
const GENERIC_STEM = new Set(['근로', '계약', '법률', '회사', '사업', '임금', '제도', '사항', '기간', '행위', '조치', '관리']);

/**
 * 단어가 글 속에 있는가. 4자 이상이면 끝 한 글자를 뗀 어간(연장근로수당 → 연장근로수)을,
 * 정확히 4자이면 앞 두 글자 어간(가산수당 → 가산, '가산하여'와 닿는다)도 인정한다.
 */
const touches = (text, term) => {
  if (text.includes(term)) return true;
  if (term.length >= 4 && text.includes(term.slice(0, term.length - 1))) return true;
  const stem = term.slice(0, 2);
  return term.length === 4 && !GENERIC_STEM.has(stem) && text.includes(stem);
};

const isArticle = entry => entry && !entry.parentId && (entry.kind === 'ARTICLE' || entry.kind === 'ORDINANCE_ARTICLE')
  && entry.official && entry.inForce;

/**
 * @param {object} args
 * @param {object[]} args.issues S1 쟁점
 * @param {object[]} args.facts S1 사실
 * @param {object} args.registry 근거 등록부
 * @param {Set<string>} [args.citedKeys] 문서가 직접 인용한 조문 키('법령명|조번호')
 * @param {(entry: object) => string} [args.keyOf] 등록부 항목 → 인용 키
 * @param {number} [args.minArticles] 쟁점당 최소 연결 조문 수(모델이 연결한 것 포함)
 * @param {number} [args.minScore] 후보로 인정할 최소 점수
 * @returns {Map<string, { added: Array<{ id: string, score: number, why: string }>, modelLinked: number }>}
 */
export function linkStatutes({ issues, facts = [], registry, citedKeys = new Set(), keyOf = () => '', minArticles = 2, minScore = 2 }) {
  const articles = registry.list(isArticle);
  const factText = new Map(facts.map(f => [f.id, f.text || '']));
  const result = new Map();
  for (const issue of issues) {
    const own = new Set(issue.evidenceIds.map(id => registry.get(id)).filter(Boolean).map(e => e.parentId || e.id)
      .filter(id => /^[AO]\d+$/.test(id)));
    const need = Math.max(0, minArticles - own.size);
    if (!need) { result.set(issue.id, { added: [], modelLinked: own.size }); continue; }

    const strong = extractTerms(issue.question, ...(issue.searchTerms || []));
    const weak = extractTerms(...(issue.factIds || []).map(id => factText.get(id)))
      .filter(t => !strong.includes(t)).slice(0, 12);
    const scored = articles.filter(a => !own.has(a.id)).map(article => {
      const title = article.title || '';
      const body = article.text || '';
      const titleHits = strong.filter(t => touches(title, t));
      const bodyHits = strong.filter(t => !titleHits.includes(t) && touches(body, t));
      const factHits = weak.filter(t => touches(title, t) || touches(body, t));
      const cited = citedKeys.has(keyOf(article));
      const score = titleHits.length * 3 + Math.min(bodyHits.length, 6) + Math.min(factHits.length, 3) * 0.5 + (cited ? 4 : 0);
      const why = [titleHits.length ? `제목 일치 ${titleHits.slice(0, 3).join('·')}` : '',
        bodyHits.length ? `본문 일치 ${bodyHits.slice(0, 3).join('·')}` : '', cited ? '문서가 직접 인용' : ''].filter(Boolean).join(', ');
      // 단어 하나만 닿은 조문은 우연일 가능성이 크다. 서로 다른 단어 둘 이상이 닿거나 문서가 직접 인용한 조문만 후보로 한다.
      return { id: article.id, score: Number(score.toFixed(2)), why, cited, distinct: titleHits.length + bodyHits.length };
    }).filter(c => c.cited ? c.score >= 1 : (c.score >= minScore && c.distinct >= 2))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en', { numeric: true }));
    result.set(issue.id, { added: scored.slice(0, need), modelLinked: own.size });
  }
  return result;
}

/** 연결 결과를 쟁점에 반영한다. 모델이 이미 고른 조문은 그대로 두고 모자란 만큼만 채운다. */
export function applyStatuteLinks(issues, links) {
  const summary = { linkedIssues: 0, addedArticles: 0, unlinkedIssues: [] };
  for (const issue of issues) {
    const link = links.get(issue.id);
    if (!link) continue;
    if (link.added.length) {
      issue.evidenceIds = [...new Set([...issue.evidenceIds, ...link.added.map(a => a.id)])];
      issue.codeLinkedEvidence = link.added;
      summary.linkedIssues++;
      summary.addedArticles += link.added.length;
    }
    if (!link.modelLinked && !link.added.length) {
      issue.linkNote = '질문·검색어와 닿는 수집 조문을 찾지 못했습니다.';
      summary.unlinkedIssues.push(issue.id);
    }
  }
  return summary;
}
