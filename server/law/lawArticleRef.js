// server/law/lawArticleRef.js - 조문 인용(조·항·호·목) 정규식 파서 및 구조화 유틸리티

// 법령명 패턴:
//  - 「」『』로 묶인 법령명 (공문서 표준 표기). 법령명 자체가 "및"이나 공백을 포함해도 원형을 보존한다.
//  - 또는 법/법률/시행령/시행규칙/조례/정관으로 끝나는 최대 8어절, 또는 "동법"/"본법"
// 조문 패턴: 제\d+조 (의\d+), 제\d+항, 제\d+호, [가-힣]목
// 그룹: 1=괄호법령명, 2=평문법령명, 3=조, 4/5=가지번호, 6=항, 7=호, 8=목
const ARTICLE_REF_REGEX = /(?:(?:[「『]\s*([^」』\n]{2,60}?)\s*[」』]|((?:(?!제\s*\d)[가-힣0-9]+[ \t]+){0,7}[가-힣0-9]*(?:법률|법|시행령|시행규칙|조례|정관)|동법|본법))\s*)?제\s*(\d+)(?:의\s*(\d+))?\s*조(?:\s*의\s*(\d+))?(?:\s*제\s*(\d+)\s*항)?(?:\s*제\s*(\d+)\s*호)?(?:\s*([가-힣])\s*목)?/g;

// 앞선 인용이 끝난 뒤 이어지는 나열 접속어. 법령명 "내부"의 '및'과 구별하기 위해
// 캡처된 법령명의 맨 앞에 올 때만 제거한다.
// (예: "개인정보 보호법 제15조 및 근로기준법 제56조" → "근로기준법"
//      "공유재산 및 물품 관리법 시행령 제31조" → 원형 유지)
const LEADING_CONJUNCTION_REGEX = /^(?:및|또는|그리고|또한|이와\s*함께)\s+/;

// 앞서 언급한 법령을 가리키는 대용 표현. 직전에 확정된 법령명으로 해석한다.
const ANAPHORIC_LAW_REGEX = /(?:^|[\s)\]」』])(?:동법|본법|같은\s*법률|같은\s*법|이\s*법률|이\s*법|그\s*법)$/;

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
  // 대용 표현("동법", "같은 법")은 직전에 확정된 법령명으로 해석한다.
  let lastResolvedLawName = '';

  const regex = new RegExp(ARTICLE_REF_REGEX.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    const bracketLawName = (match[1] || '').trim();
    const plainLawName = (match[2] || '').trim().replace(LEADING_CONJUNCTION_REGEX, '').trim();
    // 「」로 묶인 표기는 법령명 경계가 확정적이므로 가공하지 않고 그대로 사용한다.
    const rawLawName = bracketLawName || plainLawName;

    let lawName = rawLawName;
    if (!lawName || ANAPHORIC_LAW_REGEX.test(lawName)) {
      lawName = lastResolvedLawName || defaultLawName;
    } else {
      lastResolvedLawName = lawName;
    }

    const mainNo = match[3];
    const branchNo = match[4] || match[5] || '';
    const paragraphNo = match[6] || '';
    const itemNo = match[7] || '';
    const subItemNo = match[8] || '';

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

// 자치법규명 패턴: "<지자체명> <제명>조례"
// 조문 인용 없이 제명만 언급되는 근거 법규(예: 신청 서식의 근거 조례)를 놓치지 않기 위함이다.
const ORDINANCE_NAME_REGEX = /[「『]?\s*([가-힣]{2,12}(?:특별자치도|특별자치시|광역시|특별시|[가-힣]{1,8}(?:시|군|구|도))\s+[가-힣0-9()·\s]{2,40}?조례)\s*[」』]?/g;

/**
 * 문서에서 언급된 자치법규(조례) 제명을 추출한다.
 * extractArticleReferences는 "제O조" 인용이 있어야 잡아내므로, 제명만 등장하는 경우를 보완한다.
 * @param {string} text
 * @returns {string[]}
 */
export function extractOrdinanceNames(text) {
  if (!text || typeof text !== 'string') return [];
  const names = new Set();
  for (const match of text.matchAll(ORDINANCE_NAME_REGEX)) {
    const name = match[1].replace(/\s+/g, ' ').trim();
    if (name.length >= 6) names.add(name);
  }
  return [...names];
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
  
  return text.replace(ARTICLE_REF_REGEX, (match, bracketLaw, plainLaw, mainNo, beforeBranch, afterBranch, pNo, itemNo, subItemNo) => {
    const resolved = bracketLaw || (plainLaw || '').replace(LEADING_CONJUNCTION_REGEX, '');
    const targetLaw = (resolved || lawName || '').trim();
    const branchNo = beforeBranch || afterBranch;
    const artNo = branchNo ? `${mainNo}의${branchNo}` : mainNo;
    return `[${match.trim()}](#law-ref?law=${encodeURIComponent(targetLaw)}&article=${artNo})`;
  });
}

export default {
  extractArticleReferences,
  extractOrdinanceNames,
  normalizeArticleNo,
  linkifyArticleReferences
};
