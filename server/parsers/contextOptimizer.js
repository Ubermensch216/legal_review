// server/parsers/contextOptimizer.js - 대용량 장문 문서 토큰 압축 및 쟁점 추출 엔진
import { chunkLegalDocument } from './legalDocChunker.js';

/**
 * 대용량 장문 문서에서 핵심 법적 쟁점 조항을 우선 선별하여 압축
 * @param {object} params
 * @param {string} params.documentText - 첨부문서 전문
 * @param {string} params.query - 사용자 검토 질의
 * @param {number} params.maxChars - LLM 입력 최대 허용 문자수 (기본 4,500자)
 * @returns {{ optimizedText: string, totalChunks: number, selectedChunks: Array<object>, omittedCount: number }}
 */
export function optimizeDocumentContext({ documentText = '', query = '', maxChars = 4500 }) {
  if (!documentText || documentText.trim().length === 0) {
    return {
      optimizedText: '',
      totalChunks: 0,
      selectedChunks: [],
      omittedCount: 0
    };
  }

  // 문서 길이가 기준 이하인 경우 원문 유지
  if (documentText.length <= maxChars) {
    const chunks = chunkLegalDocument(documentText);
    return {
      optimizedText: documentText,
      totalChunks: chunks.length,
      selectedChunks: chunks,
      omittedCount: 0
    };
  }

  // 1. 조항 단위 계층 분할
  const chunks = chunkLegalDocument(documentText);
  if (chunks.length === 0) {
    return {
      optimizedText: documentText.slice(0, maxChars) + '\n... (이하 토큰 초과로 생략)',
      totalChunks: 1,
      selectedChunks: [],
      omittedCount: 0
    };
  }

  // 2. 질의어 핵심 키워드 분리
  const queryKeywords = query
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter(k => k.length >= 2);

  // 3. 조항별 쟁점 중요도 점수 산출
  chunks.forEach(chunk => {
    let score = 0;
    const contentLower = (chunk.content || '').toLowerCase();
    const titleLower = (chunk.title || '').toLowerCase();

    // 3-1. 위험 조항 가중치
    if (chunk.riskLevel === 'HIGH') score += 50;
    else if (chunk.riskLevel === 'MEDIUM') score += 25;

    // 3-2. 질의어 키워드 매칭
    queryKeywords.forEach(kw => {
      if (titleLower.includes(kw)) score += 30;
      if (contentLower.includes(kw)) score += 15;
    });

    // 3-3. 문서 서두/배경
    if (chunk.articleNo === '전문') score += 20;

    chunk._relevanceScore = score;
  });

  // 4. 점수 기준 내림차순 정렬 후 예산 내 선별
  const sortedChunks = [...chunks].sort((a, b) => b._relevanceScore - a._relevanceScore);
  const selectedIndices = new Set();
  let currentLength = 0;

  for (const chunk of sortedChunks) {
    const chunkLen = chunk.content.length + 10;
    if (currentLength + chunkLen <= maxChars || selectedIndices.size < 3) {
      selectedIndices.add(chunks.indexOf(chunk));
      currentLength += chunkLen;
    }
  }

  // 5. 문서 원본 순서대로 재조립
  const selectedChunks = chunks.filter((_, idx) => selectedIndices.has(idx));
  const omittedCount = chunks.length - selectedChunks.length;

  const optimizedTextParts = selectedChunks.map(chunk => {
    const riskBadge = chunk.isRiskClause ? ` [⚠️ ${chunk.riskTags.map(t => t.label).join(', ')}]` : '';
    return `### ${chunk.articleNo} (${chunk.title})${riskBadge}\n${chunk.content}`;
  });

  if (omittedCount > 0) {
    optimizedTextParts.push(`\n※ [문서 압축 알림] 전체 ${chunks.length}개 조항 중 핵심 쟁점 및 위험 조항 ${selectedChunks.length}건을 우선 선별하였으며, 일반 조항 ${omittedCount}건은 분석 효율을 위해 요약 생략되었습니다.`);
  }

  return {
    optimizedText: optimizedTextParts.join('\n\n'),
    totalChunks: chunks.length,
    selectedChunks,
    omittedCount
  };
}

export default {
  optimizeDocumentContext
};
