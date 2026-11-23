import { extractArticleReferences, normalizeArticleNo, isCitationReference } from './lawArticleRef.js';
import { extractTerms } from '../reasoning/stages/statuteLinking.js';
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
  const targetArticles = new Set(articleNos.map(normalizeArticleNo));

  const scoredList = precedents.map(prec => {
    // 무조건 주어지는 베이스 점수를 제거했다. 과거에는 기본 30점에 더해
    // 조문/키워드/법원 각 분기의 else 가산점이 항상 붙어, 사안과 전혀 무관한
    // 판례도 최소 75점이 보장됐다. 이제 0점에서 실제 일치분만 가산한다.
    let score = 0;
    const matchReasons = [];
    const matchedTokens = [];

    const caseName = prec.caseName || '';
    const holding = prec.holding || '';
    const summary = prec.summary || '';
    const fullText = `${caseName} ${holding} ${summary}`.toLowerCase();

    // 문서 자신의 조문번호로 판례 관련도가 매겨지지 않도록 진짜 인용만 센다.
    const mentionedArticles = new Set(extractArticleReferences(fullText).filter(isCitationReference).map(r => r.fullArticleNo));
    // 1. 조문 및 법령 일치도 검증 (최대 45점)
    let articleMatched = false;
    for (const art of targetArticles) {
      if (art && mentionedArticles.has(art)) {
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
    }

    // 2. 핵심 쟁점 키워드 포섭도 (최대 40점)
    // 질의어는 조사를 뗀 어간으로 비교한다("가산수당을"은 판결문의 "가산수당"과 닿아야 한다).
    // 일치 개수에 따라 점수를 나눠야 쟁점에 가까운 판례가 위로 올라온다(전부 같은 점수가 되지 않게).
    const hitTerms = queryTerms.filter(term => touchesTerm(fullText, term));
    matchedTokens.push(...hitTerms);
    const keywordHits = hitTerms.length;
    if (keywordHits >= 1) {
      score += Math.min(35, 14 + keywordHits * 7);
      matchReasons.push(keywordHits >= 3 ? '핵심 사실관계 및 쟁점 키워드 일치' : '주요 법적 쟁점 키워드 일치');
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
    }

    // 상한만 적용한다. 하한(Math.max(score, 40))은 무관한 판례에도
    // 점수를 보장해 주므로 제거했다.
    const finalScore = Math.min(score, 100);

    return {
      ...prec,
      relevanceScore: finalScore,
      matchReason: matchReasons.length > 0
        ? matchReasons.join(' · ')
        : '질의어·조문과 일치하는 요소가 확인되지 않음',
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
    let score = 0; // 베이스 40점 제거 (무관한 해석례도 45점이 보장되던 원인)
    const title = item.title || '';
    const answer = item.answer || item.reason || '';
    const fullText = `${title} ${answer}`.toLowerCase();
    const matchReasons = [];

    if (targetLaw && fullText.includes(targetLaw.toLowerCase())) {
      score += 25;
      matchReasons.push(`소관 법령(${targetLaw}) 유권해석`);
    }

    const keywordHits = queryTerms.filter(term => touchesTerm(fullText, term)).length;
    if (keywordHits >= 1) {
      score += Math.min(35, 5 + keywordHits * 8);
      matchReasons.push(keywordHits >= 2 ? '사안 쟁점 해석 회답 일치' : '쟁점 키워드 일부 일치');
    }

    const finalScore = Math.min(score, 100);

    return {
      ...item,
      relevanceScore: finalScore,
      matchReason: matchReasons.length > 0
        ? matchReasons.join(' · ')
        : '질의어·법령과 일치하는 요소가 확인되지 않음'
    };
  });

  return scoredList.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function extractKeyTerms(text) {
  return extractTerms(String(text || '').toLowerCase()).filter(t => t.length >= 2);
}

/** 어간 일치: 4자 이상이면 끝 한 글자를 뗀 형태("연장근로수당"→"연장근로수")도 인정한다. */
function touchesTerm(text, term) {
  return text.includes(term) || (term.length >= 4 && text.includes(term.slice(0, term.length - 1)));
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
