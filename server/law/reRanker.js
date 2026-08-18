// server/law/reRanker.js - 판례·법령해석례 시맨틱 Re-ranking 및 관련도 스코어링 엔진

/**
 * 수집된 판례 목록을 질의어 쟁점 및 인용 조문과의 적합도를 기준으로 재정렬
 * @param {object} params
 * @param {Array<object>} params.precedents - 원본 판례 목록
 * @param {string} params.query - 사용자 질의어
 * @param {string} params.targetLaw - 대상 법령명
 * @param {Array<string>} params.articleNos - 관련 조문 번호 목록
 * @param {Array<string>} params.expandedTerms - 확장 키워드 목록
 * @returns {Array<object>} 재정렬 및 점수가 부여된 판례 목록 (Top 3 우선)
 */
export function reRankPrecedents({ precedents = [], query = '', targetLaw = '', articleNos = [], expandedTerms = [] }) {
  if (!Array.isArray(precedents) || precedents.length === 0) return [];

  const queryTerms = extractKeyTerms(`${query} ${expandedTerms.join(' ')}`);
  const targetArticles = new Set(articleNos.map(a => normalizeArticleString(a)));

  const scoredList = precedents.map(prec => {
    let score = 30; // 기본 베이스 점수
    const matchReasons = [];
    const matchedTokens = [];

    const caseName = prec.caseName || '';
    const holding = prec.holding || '';
    const summary = prec.summary || '';
    const fullText = `${caseName} ${holding} ${summary}`.toLowerCase();

    // 1. 조문 및 법령 일치도 검증 (최대 45점)
    let articleMatched = false;
    for (const art of targetArticles) {
      if (art && (fullText.includes(art) || holding.includes(art))) {
        score += 35;
        articleMatched = true;
        matchReasons.push(`적용 조문(${art}) 직접 판시`);
        matchedTokens.push(art);
        break;
      }
    }
    if (!articleMatched && targetLaw && fullText.includes(targetLaw.toLowerCase())) {
      score += 25;
      matchReasons.push(`관련 법령(${targetLaw}) 판결 법리`);
    } else if (!articleMatched) {
      score += 20;
    }

    // 2. 핵심 쟁점 키워드 포섭도 (최대 40점)
    let keywordHits = 0;
    for (const term of queryTerms) {
      if (term.length >= 2 && fullText.includes(term)) {
        keywordHits++;
        matchedTokens.push(term);
      }
    }

    if (keywordHits >= 3) {
      score += 35;
      matchReasons.push('핵심 사실관계 및 쟁점 키워드 일치');
    } else if (keywordHits >= 1) {
      score += 25;
      matchReasons.push('주요 법적 쟁점 키워드 일치');
    } else {
      score += 15;
    }

    // 3. 법원 권위 및 중요성 (최대 15점)
    const court = prec.courtName || '';
    if (court.includes('대법원') || court.includes('헌법재판소')) {
      score += 15;
      if (caseName.includes('전원합의체') || holding.includes('전원합의체')) {
        score += 5;
        matchReasons.push('대법원 전원합의체 판결');
      } else {
        matchReasons.push('대법원 확립 판례');
      }
    } else {
      score += 10;
    }

    // 100점 상한 제한
    const finalScore = Math.min(Math.max(score, 40), 99);

    return {
      ...prec,
      relevanceScore: finalScore,
      matchReason: matchReasons.length > 0 ? matchReasons.join(' · ') : '사안 관련 법리 참조 판례',
      matchedTokens: Array.from(new Set(matchedTokens)).slice(0, 5)
    };
  });

  // 점수 내림차순 정렬
  return scoredList.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * 수집된 유권해석례 재정렬
 */
export function reRankInterpretations({ interpretations = [], query = '', targetLaw = '', expandedTerms = [] }) {
  if (!Array.isArray(interpretations) || interpretations.length === 0) return [];

  const queryTerms = extractKeyTerms(`${query} ${expandedTerms.join(' ')}`);

  const scoredList = interpretations.map(item => {
    let score = 40;
    const title = item.title || '';
    const answer = item.answer || item.reason || '';
    const fullText = `${title} ${answer}`.toLowerCase();
    const matchReasons = [];

    if (targetLaw && fullText.includes(targetLaw.toLowerCase())) {
      score += 25;
      matchReasons.push(`소관 법령(${targetLaw}) 유권해석`);
    }

    let keywordHits = 0;
    for (const term of queryTerms) {
      if (term.length >= 2 && fullText.includes(term)) {
        keywordHits++;
      }
    }

    if (keywordHits >= 2) {
      score += 25;
      matchReasons.push('사안 쟁점 해석 회답 일치');
    }

    const finalScore = Math.min(Math.max(score, 45), 98);

    return {
      ...item,
      relevanceScore: finalScore,
      matchReason: matchReasons.length > 0 ? matchReasons.join(' · ') : '소관 부처 공식 해석례'
    };
  });

  return scoredList.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function extractKeyTerms(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !['관한', '따라', '경우', '대한', '등의', '위한'].includes(t));
}

function normalizeArticleString(art) {
  if (!art) return '';
  const m = art.match(/제?\s*(\d+(?:의\d+)?)\s*조/);
  return m ? `제${m[1]}조` : art;
}

export default {
  reRankPrecedents,
  reRankInterpretations
};
