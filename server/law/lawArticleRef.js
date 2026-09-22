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

// 문서 자신을 가리키는 제명 표현. 검토 대상인 조례안·규칙 그 자체이므로 외부 법령이 아니다.
// ('이 법'·'같은 법'은 직전에 인용한 '다른' 법률을 가리키므로 대용 표현으로 따로 다룬다)
const SELF_LAW_REGEX = /(?:^|[\s)\]」』])(?:이|본|당해|해당)\s*(?:조례안|조례|규칙|예규|훈령|지침)$/;

// 제명이 아니라 법형식을 가리키는 일반명사. 이것만 남았다면 법령을 특정하지 못한 것이다.
// (예: "이 조례" -> 앞말을 떼면 "조례"만 남는데, 그런 이름의 법령은 없다)
const GENERIC_LAW_FORM_TOKENS = new Set([
  '법', '법률', '조례', '조례안', '시행령', '시행규칙', '규칙', '정관', '규정', '령', '예규', '훈령'
]);

// ── 인용의 성격(scope) 판정 ────────────────────────────────────
// 법령명 없는 "제N조"는 문맥이 가리키는 대상을 정한다. 직전에 인용한 법령일 수도 있지만,
// 문서 자신의 조문이거나 서식의 빈칸일 수도 있다. 이 셋을 구분하지 않고 전부
// '직전 법령'으로 메우면, 조례안의 제8조가 상위법 제8조로 둔갑해 공식 근거로 실린다.
//
//  EXPLICIT    : 본문에 법령명이 있다
//  ANAPHORIC   : 동법·같은 법 등 대용 표현 (직전 법령으로 승계하는 것이 맞다)
//  SELF        : 문서 자신의 조문 (조회 대상이 아니다)
//  PLACEHOLDER : '관련 법령' 같은 서식 빈칸 (지정 법령이 있을 때만 해석한다)
//  CARRY       : 위 어디에도 걸리지 않는 맨 조문번호 (직전 법령으로 승계)
export const REFERENCE_SCOPE = Object.freeze({
  EXPLICIT: 'EXPLICIT', ANAPHORIC: 'ANAPHORIC', SELF: 'SELF', PLACEHOLDER: 'PLACEHOLDER', CARRY: 'CARRY'
});

// 조회해서는 안 되는 인용. (문서 자신의 조문·서식 빈칸)
const NON_CITATION_SCOPES = new Set([REFERENCE_SCOPE.SELF, REFERENCE_SCOPE.PLACEHOLDER]);

/** 이 인용이 외부 법령을 가리키는 '진짜 인용'인지. 수집·검증은 이것만 대상으로 한다. */
export function isCitationReference(ref) {
  return Boolean(ref) && !NON_CITATION_SCOPES.has(ref.scope);
}

// 규칙1: 줄머리(불릿 허용)에서 시작하고 뒤에 괄호 제목이 붙는 "제N조(제목)"은
//        조문의 '정의'이지 인용이 아니다. (예: "■ 제8조 (무인대여사업자의 등록 취소)")
const SELF_HEADING_BEFORE_REGEX = /(?:^|\n)[ \t]*(?:[■□▪▫●○◆◇※=·•\-*]+[ \t]*)*$/;
const SELF_HEADING_AFTER_REGEX = /^[ \t]*[（(]/;

// 규칙2: '상기·위·본 조례안' 등은 이 문서 안의 앞부분을 가리킨다.
//        앞 글자가 한글이면 어절 중간이므로("규정이", "상위") 마커로 보지 않는다.
const SELF_MARKER_BEFORE_REGEX =
  /(?:^|[\s(（\[「『.,·])(?:상기|위|앞서|전술한|본|이)[ \t]*(?:조례안?|규정|조항|건)?[ \t]*$/;

// 규칙3: '관련 법령 제1조'의 '관련 법령'은 제명이 아니라 서식의 빈칸이다.
const PLACEHOLDER_BEFORE_REGEX =
  /(?:^|[\s(（\[「『.,·])(?:관련|해당|상위|근거|소관|본건)[ \t]*법령[ \t]*$/;

// 규칙4: "제8조 및 제14조"처럼 접속사로 이어진 인용은 앞 인용의 성격을 물려받는다.
//        이것이 없으면 "상기 제8조 및 제14조"에서 뒤쪽만 새어나간다.
const ENUM_LINK_BEFORE_REGEX =
  /제[ \t]*\d+[ \t]*조(?:[ \t]*의[ \t]*\d+)?(?:[ \t]*제[ \t]*\d+[ \t]*[항호])*[ \t]*(?:[,、·]|및|또는|과|와|내지)[ \t]*$/;

/**
 * 법령명이 캡처되지 않은 인용의 성격을 주변 문맥으로 판정한다.
 * @param {string} text 전체 원문
 * @param {number} start 조문 표기가 시작하는 위치
 * @param {number} end 조문 표기가 끝나는 위치
 * @param {string} previousScope 직전 인용의 성격 (열거 상속용)
 */
function classifyBareReference(text, start, end, previousScope) {
  const before = text.slice(Math.max(0, start - 64), start);
  const after = text.slice(end, end + 4);
  if (SELF_HEADING_BEFORE_REGEX.test(before) && SELF_HEADING_AFTER_REGEX.test(after)) return REFERENCE_SCOPE.SELF;
  if (SELF_MARKER_BEFORE_REGEX.test(before)) return REFERENCE_SCOPE.SELF;
  if (PLACEHOLDER_BEFORE_REGEX.test(before)) return REFERENCE_SCOPE.PLACEHOLDER;
  if (previousScope && ENUM_LINK_BEFORE_REGEX.test(before)) return previousScope;
  return REFERENCE_SCOPE.CARRY;
}

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
  // 열거("제8조 및 제14조")에서 뒤쪽 인용이 앞쪽의 성격을 물려받도록 직전 성격을 들고 간다.
  let previousScope = '';

  const regex = new RegExp(ARTICLE_REF_REGEX.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    const bracketLawName = (match[1] || '').trim();
    const rawPlainName = (match[2] || '').trim().replace(LEADING_CONJUNCTION_REGEX, '').trim();
    // 평문 표기는 제명 앞 문장까지 딸려오므로 경계를 다시 잡는다.
    // 다만 대용 표현("없으면 같은 법")은 앞 어절까지 있어야 대용인지 알 수 있으므로 원형을 유지한다.
    const isSelfLawName = !bracketLawName && SELF_LAW_REGEX.test(rawPlainName);
    const trimmedPlainName = ANAPHORIC_LAW_REGEX.test(rawPlainName) ? rawPlainName : trimLawNamePrefix(rawPlainName);
    // 법형식 일반명사만 남았으면 제명을 특정하지 못한 것이므로 맨 조문번호와 동일하게 문맥으로 판정한다.
    const plainLawName = (isSelfLawName || GENERIC_LAW_FORM_TOKENS.has(trimmedPlainName)) ? '' : trimmedPlainName;
    // 「」로 묶인 표기는 법령명 경계가 확정적이므로 가공하지 않고 그대로 사용한다.
    const rawLawName = bracketLawName || plainLawName;

    let scope;
    let lawName = rawLawName;
    if (lawName && !ANAPHORIC_LAW_REGEX.test(lawName)) {
      scope = REFERENCE_SCOPE.EXPLICIT;
      lastResolvedLawName = lawName;
    } else if (lawName) {
      // 대용 표현. 직전에 확정된 법령으로 해석한다.
      scope = REFERENCE_SCOPE.ANAPHORIC;
      lawName = lastResolvedLawName || defaultLawName;
    } else {
      // 법령명이 없는 맨 조문번호. 문맥으로 성격을 가른다.
      // '이 조례'처럼 문서 자신을 가리키는 표현은 문맥을 보지 않고 바로 자기 조문으로 확정한다.
      scope = isSelfLawName
        ? REFERENCE_SCOPE.SELF
        : classifyBareReference(text, match.index, match.index + match[0].length, previousScope);
      if (scope === REFERENCE_SCOPE.SELF) {
        // 문서 자신의 조문이므로 어떤 법령에도 귀속시키지 않는다.
        lawName = '';
      } else if (scope === REFERENCE_SCOPE.PLACEHOLDER) {
        // 서식 빈칸. 직전 법령으로 메우면 엉뚱한 조문이 붙으므로, 지정 법령이 있을 때만 해석한다.
        lawName = defaultLawName;
      } else {
        lawName = lastResolvedLawName || defaultLawName;
      }
    }
    previousScope = scope;

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

    const key = `${scope}|${lawName}|${articleNoStr}|${paragraphNo}|${itemNo}|${subItemNo}`;
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
        fullRef,
        scope
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
  isCitationReference,
  REFERENCE_SCOPE,
  extractOrdinanceNames,
  trimLawNamePrefix,
  normalizeArticleNo,
  linkifyArticleReferences
};
