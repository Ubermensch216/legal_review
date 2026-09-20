// server/law/lawArticleRef.js - 조문 인용(조·항·호·목) 정규식 파서 및 구조화 유틸리티

// 법령명 패턴: 2~20글자의 법/법률/령/규칙/조례/정관 또는 "동법"
// 조문 패턴: 제\d+조 (의\d+), 제\d+항, 제\d+호, [가-힣]목
const ARTICLE_REF_REGEX = /(?:((?:(?!제\d)[가-힣0-9]+[ \t]+){0,7}[가-힣0-9]*(?:법률|법|시행령|시행규칙|조례|정관)|동법|본법)\s+)?제\s*(\d+)(?:의\s*(\d+))?\s*조(?:\s*의\s*(\d+))?(?:\s*제\s*(\d+)\s*항)?(?:\s*제\s*(\d+)\s*호)?(?:\s*([가-힣])\s*목)?/g;

/**
 * 텍스트 내에서 언급된 모든 조문 인용 추출
 * @param {string} text 
 * @param {string} defaultLawName 
 * @returns {Array<object>}
 */
export function extractArticleReferences(text, defaultLawName = '') {
  if (!text || typeof text !== 'string') return [];

  const refs = [];
  const seen = new Set();
  let match;

  const regex = new RegExp(ARTICLE_REF_REGEX.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    const rawLawName = (match[1] || '').trim().split(/(?:및|또한|따라|그리고)\s+/).at(-1);
    let lawName = rawLawName;
    if (!lawName || lawName === '동법' || lawName === '본법') {
      lawName = defaultLawName;
    }

    const mainNo = match[2];
    const branchNo = match[3] || match[4] || '';
    const paragraphNo = match[5] || '';
    const itemNo = match[6] || '';
    const subItemNo = match[7] || '';

    const articleNoStr = branchNo ? `${mainNo}의${branchNo}` : mainNo;
    
    // 전체 식별 텍스트
    let fullRef = `${lawName ? lawName + ' ' : ''}제${mainNo}조${branchNo ? '의' + branchNo : ''}`;
    if (paragraphNo) fullRef += ` 제${paragraphNo}항`;
    if (itemNo) fullRef += ` 제${itemNo}호`;
    if (subItemNo) fullRef += ` ${subItemNo}목`;

    const key = `${lawName}|${articleNoStr}|${paragraphNo}|${itemNo}|${subItemNo}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({
        rawMatch: match[0].trim(),
        lawName,
        articleNo: mainNo,
        branchNo,
        fullArticleNo: articleNoStr,
        paragraphNo,
        itemNo,
        subItemNo,
        fullRef
      });
    }
  }

  return refs;
}

/**
 * 조문 번호(문자열/숫자)를 정규화된 형태(예: "15" 또는 "15의2")로 변환
 * @param {string|number} articleStr 
 * @returns {string}
 */
export function normalizeArticleNo(articleStr) {
  if (!articleStr) return '';
  const str = String(articleStr).trim();
  const match = str.match(/(\d+)\s*(?:조\s*)?(?:의\s*(\d+))?/);
  if (!match) return str;
  return match[2] ? `${match[1]}의${match[2]}` : match[1];
}

/**
 * 텍스트 내의 조문 인용구들을 클릭 가능한 마크다운 링크로 자동 변환
 * @param {string} text 
 * @param {string} lawName 
 * @returns {string}
 */
export function linkifyArticleReferences(text, lawName = '') {
  if (!text || typeof text !== 'string') return '';
  
  return text.replace(ARTICLE_REF_REGEX, (match, law, mainNo, beforeBranch, afterBranch, pNo, itemNo, subItemNo) => {
    const targetLaw = (law || lawName || '').trim();
    const branchNo = beforeBranch || afterBranch;
    const artNo = branchNo ? `${mainNo}의${branchNo}` : mainNo;
    return `[${match.trim()}](#law-ref?law=${encodeURIComponent(targetLaw)}&article=${artNo})`;
  });
}

export default {
  extractArticleReferences,
  normalizeArticleNo,
  linkifyArticleReferences
};
