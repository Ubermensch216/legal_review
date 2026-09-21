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

// ── 법령명 경계 판정 ──────────────────────────────────────────────
// 평문 법령명은 "제O조" 앞의 어절을 최대 7개까지 끌어온다. 제명이 여러 어절인 법령
// ("공유재산 및 물품 관리법 시행령")을 온전히 잡기 위한 폭이지만, 그대로 두면 제명 앞의
// 문장까지 딸려 온다. ("...신설하는 것이 지방자치법" → 법령 API 조회 실패)
// 그래서 뒤(제명 끝 어절)에서 앞으로 훑으며, 제명의 일부일 수 없는 어절에서 끊는다.

// 제명의 끝 어절에 쓰이는 접미사. 나열 구분자 판정에도 쓴다.
const LAW_HEAD_SUFFIX_REGEX = /(?:법률|법|시행령|시행규칙|령|규칙|조례|규약|정관|규정|헌장)$/;

// 제명 안에서 어절을 잇는 표현. (예: "약관의 규제에 관한 법률")
const NAME_CONNECTIVE_TOKENS = new Set(['및', '또는', '관한', '대한', '위한', '의한', '등']);

// 제명에 나타나지 않는 의존명사·지시어. (예: "...신설하는 것이 지방자치법")
const NON_NAME_TOKENS = new Set([
  '것이', '것은', '것을', '것', '바', '때', '수', '여부', '경우', '이', '그', '저',
  '따라', '따른', '의해', '의하여', '대하여', '관하여', '위하여', '비추어',
  '상기', '해당', '다만', '또한', '그리고', '함', '위배', '저촉', '초과'
]);

// 격조사가 붙은 어절은 문장 성분이지 제명의 일부가 아니다. (예: "처분을", "대하여는", "규정에도")
// '의/에/와/과'로 끝나는 어절은 제명에 흔히 쓰이므로("약관의 규제에 관한") 제외하지 않는다.
const CASE_PARTICLE_SUFFIX_REGEX =
  /(?:을|를|은|는|에서|에게|에도|에는|에만|으로|로서|로써|로부터|부터|까지|보다|처럼|만큼|마다|대로|이나|거나|든지|라도|조차|마저|라는|이라)$/;

// '-하다/-되다/-있다/-없다' 활용형. 어간이 2음절 이상일 때만 활용으로 본다.
// ("제한", "권한", "신고"처럼 어간이 1음절이면 제명에 쓰이는 명사일 가능성이 높다)
const CONJUGATED_SUFFIX_REGEX =
  /[가-힣]{2,}(?:하는|하여|하고|하며|하지|하면|한다|한|함|해|했다|되는|되어|되고|되며|된다|된|됨|있는|있다|없는|없다)$/;

// 어절 하나가 법령 제명의 구성 요소가 될 수 있는지 판정한다.
function isLawNameToken(token) {
  if (!token) return false;
  if (NAME_CONNECTIVE_TOKENS.has(token)) return true;
  if (NON_NAME_TOKENS.has(token)) return false;
  if (CASE_PARTICLE_SUFFIX_REGEX.test(token)) return false;
  if (CONJUGATED_SUFFIX_REGEX.test(token)) return false;
  return true;
}

/**
 * 캡처된 평문 법령명에서, 제명 앞에 딸려 온 문장 부분을 잘라낸다.
 * 제명 끝 어절은 항상 남기고, 거기서 앞으로 훑으며 제명의 일부일 수 없는 어절에서 멈춘다.
 * @param {string} rawName
 * @returns {string}
 */
export function trimLawNamePrefix(rawName) {
  const tokens = String(rawName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return tokens.join(' ');

  let start = tokens.length - 1;
  for (let i = tokens.length - 2; i >= 0; i--) {
    const token = tokens[i];
    // "행정대집행법 및 약관의 규제에 관한 법률"처럼 완결된 제명 뒤에 오는 '및'은
    // 제명 내부의 '및'이 아니라 두 법령을 잇는 나열 구분자다. 거기서 끊는다.
    if ((token === '및' || token === '또는') && i > 0 && LAW_HEAD_SUFFIX_REGEX.test(tokens[i - 1])) break;
    if (!isLawNameToken(token)) break;
    start = i;
  }
  return tokens.slice(start).join(' ');
}

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
    const rawPlainName = (match[2] || '').trim().replace(LEADING_CONJUNCTION_REGEX, '').trim();
    // 평문 표기는 제명 앞 문장까지 딸려오므로 경계를 다시 잡는다.
    // 다만 대용 표현("없으면 같은 법")은 앞 어절까지 있어야 대용인지 알 수 있으므로 원형을 유지한다.
    const plainLawName = ANAPHORIC_LAW_REGEX.test(rawPlainName) ? rawPlainName : trimLawNamePrefix(rawPlainName);
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
        rawMatch: dropTrimmedPrefix(match[0], match[2], plainLawName),
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

// 법령명 앞에 딸려온 문장 부분을 원문(전체 매치)에서도 동일하게 잘라낸다.
// 평문 법령명은 매치의 맨 앞에서 시작하므로, 줄어든 길이만큼 앞을 뗀다.
function dropTrimmedPrefix(fullMatch, rawPlainName, trimmedName) {
  const raw = String(rawPlainName || '');
  const full = String(fullMatch);
  if (!raw || !full.startsWith(raw)) return full.trim();
  const cut = raw.length - String(trimmedName || '').length;
  return cut > 0 ? full.slice(cut).trim() : full.trim();
}

// 자치법규명 패턴: "<지자체명> <제명>조례"
// 조문 인용 없이 제명만 언급되는 근거 법규(예: 신청 서식의 근거 조례)를 놓치지 않기 위함이다.
// 지자체명과 제명 본문을 나눠 잡고 각각을 검증한다. 하나의 넓은 패턴으로 두면
// "규정에도 불구하고 지자체 조례"처럼 문장 조각이 제명으로 둔갑한다.
const ORDINANCE_NAME_REGEX =
  /([가-힣]{2,10}(?:특별자치도|특별자치시|광역시|특별시)|[가-힣]{2,9}(?:시|군|구|도))\s+([가-힣0-9()·\s]{2,40}?조례)/g;

// 지자체명에서 행정구역 접미사를 떼어낸 어간이 조사로 끝나면 지자체명이 아니다.
// ("규정에도" → 어간 "규정에" / "부산광역시" → 어간 "부산")
const LOCAL_GOV_STEM_PARTICLE_REGEX = /(?:이|가|을|를|은|는|에|의|와|과|도|만|께)$/;

function isLocalGovernmentName(token) {
  const name = String(token || '');
  const stem = name.replace(/(?:특별자치도|특별자치시|광역시|특별시|시|군|구|도)$/, '');
  if (!stem) return false;
  if (LOCAL_GOV_STEM_PARTICLE_REGEX.test(stem)) return false;
  if (CONJUGATED_SUFFIX_REGEX.test(stem)) return false;
  return isLawNameToken(name);
}

/**
 * 문서에서 언급된 자치법규(조례) 제명을 추출한다.
 * extractArticleReferences는 "제O조" 인용이 있어야 잡아내므로, 제명만 등장하는 경우를 보완한다.
 * @param {string} text
 * @returns {string[]}
 */
export function extractOrdinanceNames(text) {
  if (!text || typeof text !== 'string') return [];
  const names = new Set();
  const regex = new RegExp(ORDINANCE_NAME_REGEX.source, 'g');
  let match;
  while ((match = regex.exec(text)) !== null) {
    const govName = match[1];
    const bodyTokens = match[2].split(/\s+/).filter(Boolean);
    const isValid =
      isLocalGovernmentName(govName) &&
      // 제명 본문의 모든 어절이 제명의 일부일 수 있어야 한다.
      bodyTokens.every(isLawNameToken) &&
      // 접속어뿐인 "말뭉치"는 제명이 아니다. (예: "고시 및 조례")
      bodyTokens.some(t => t !== '조례' && !NAME_CONNECTIVE_TOKENS.has(t));
    if (isValid) {
      const name = `${govName} ${bodyTokens.join(' ')}`.trim();
      if (name.length >= 6) names.add(name);
    } else {
      // 후보를 버리더라도 그 안에서 시작하는 더 짧은 제명을 놓치지 않도록 한 칸만 전진한다.
      regex.lastIndex = match.index + 1;
    }
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
    const rawPlain = (plainLaw || '').replace(LEADING_CONJUNCTION_REGEX, '').trim();
    // 대용 표현은 가리키는 법령을 알 수 없으므로 호출자가 준 기준 법령으로 연결한다.
    const plain = ANAPHORIC_LAW_REGEX.test(rawPlain) ? '' : trimLawNamePrefix(rawPlain);
    const targetLaw = ((bracketLaw || '').trim() || plain || lawName || '').trim();
    const branchNo = beforeBranch || afterBranch;
    const artNo = branchNo ? `${mainNo}의${branchNo}` : mainNo;
    // 잘라낸 앞부분은 본문 그대로 두고, 제명부터만 링크로 묶는다.
    const linked = dropTrimmedPrefix(match, plainLaw, plain);
    const prefix = match.slice(0, match.length - linked.length);
    return `${prefix}[${linked.trim()}](#law-ref?law=${encodeURIComponent(targetLaw)}&article=${artNo})`;
  });
}

export default {
  extractArticleReferences,
  extractOrdinanceNames,
  trimLawNamePrefix,
  normalizeArticleNo,
  linkifyArticleReferences
};
