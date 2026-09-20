// server/law/lawApiParser.js - 국가법령정보센터(law.go.kr) DRF XML/JSON 응답 정규화 파서
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false
});

/**
 * 안전하게 배열 형태로 변환
 */
function ensureArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

/**
 * 텍스트 값 추출 헬퍼
 */
function getText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object') {
    if (node['#text'] !== undefined) return String(node['#text']).trim();
    if (node._ !== undefined) return String(node._).trim();
  }
  return '';
}

/**
 * 법령 목록 검색 응답 파싱
 * @param {string|object} rawResponse 
 * @returns {Array<object>}
 */
export function parseLawSearchList(rawResponse) {
  if (!rawResponse) return [];
  let root = rawResponse;

  if (typeof rawResponse === 'string') {
    try {
      if (rawResponse.trim().startsWith('{')) {
        root = JSON.parse(rawResponse);
      } else {
        if (XMLValidator.validate(rawResponse) !== true) throw new Error('유효한 XML이 아닙니다.');
        root = xmlParser.parse(rawResponse);
      }
    } catch (err) {
      console.warn('[LawApiParser] 법령 검색 파싱 실패:', err.message);
      throw new Error('법령 목록 응답을 해석할 수 없습니다.');
    }
  }

  // XML 구조: LawSearch > law / lawSearch > law / Law > law
  const searchRoot = root.LawSearch || root.lawSearch;
  if (!searchRoot || typeof searchRoot !== 'object') throw new Error('법령 목록 응답 루트가 올바르지 않습니다.');
  const lawList = ensureArray(searchRoot.law || searchRoot.Law || searchRoot.item || []);

  return lawList.map(item => ({
    lawId: getText(item.법령ID || item.lawId),
    lawSeq: getText(item.법령일련번호 || item.lawSeq),
    historyStatus: getText(item.현행연혁코드),
    lawName: getText(item.법령명한글 || item.법령명 || item.lawName || item.lawNm),
    lawNameShort: getText(item.법령약칭명 || item.lawNameShort),
    promulDate: getText(item.공포일자 || item.promulDate),
    promulNo: getText(item.공포번호 || item.promulNo),
    enforceDate: getText(item.시행일자 || item.enforceDate),
    lawType: getText(item.법령구분명 || item.법종구분 || item.lawType),
    ministry: getText(item.소관부처명 || item.소관부처 || item.ministry),
    detailUrl: getText(item.법령상세링크 || item.detailUrl)
  })).filter(l => l.lawName || l.lawId);
}

/**
 * 법령 상세 및 조문 구조 파싱
 * @param {string|object} rawResponse 
 * @returns {object}
 */
export function parseLawDetail(rawResponse) {
  if (!rawResponse) return null;
  let root = rawResponse;

  if (typeof rawResponse === 'string') {
    try {
      if (rawResponse.trim().startsWith('{')) {
        root = JSON.parse(rawResponse);
      } else {
        if (XMLValidator.validate(rawResponse) !== true) throw new Error('유효한 XML이 아닙니다.');
        root = xmlParser.parse(rawResponse);
      }
    } catch (err) {
      console.warn('[LawApiParser] 법령 상세 파싱 실패:', err.message);
      return null;
    }
  }

  const lawRoot = root.법령 || root.Law || root.lawService;
  if (!lawRoot || typeof lawRoot !== 'object') return null;
  const basicInfo = lawRoot.기본정보 || lawRoot.basicInfo || lawRoot;

  // 1. 기본 정보
  const parsed = {
    lawId: getText(basicInfo.법령ID || basicInfo.lawId),
    lawSeq: getText(basicInfo.법령일련번호 || basicInfo.lawSeq),
    lawName: getText(basicInfo.법령명_한글 || basicInfo.법령명 || basicInfo.lawName),
    lawNameShort: getText(basicInfo.법령약칭명 || basicInfo.lawNameShort),
    promulDate: getText(basicInfo.공포일자 || basicInfo.promulDate),
    promulNo: getText(basicInfo.공포번호 || basicInfo.promulNo),
    enforceDate: getText(basicInfo.시행일자 || basicInfo.enforceDate),
    lawType: getText(basicInfo.법종구분 || basicInfo.법령구분명 || basicInfo.lawType),
    ministry: getText(basicInfo.소관부처 || basicInfo.소관부처명 || basicInfo.ministry),
    articles: [],
    annexes: [],
    addenda: []
  };

  // 2. 조문 목록 파싱
  const articleRoot = lawRoot.조문 || lawRoot.articles || lawRoot;
  const rawArticles = ensureArray(articleRoot.조문단위 || articleRoot.article || []);

  parsed.articles = rawArticles.map(art => {
    const artNo = getText(art.조문번호 || art.articleNo);
    const artBranchNo = getText(art.조문가지번호 || art.branchNo);
    const artTitle = getText(art.조문제목 || art.title);
    const artContent = getText(art.조문내용 || art.content);
    const enforceDate = getText(art.조문시행일자 || art.enforceDate);
    const isDeleted = art.isDeleted === true || /삭제/.test(getText(art.조문제개정유형)) || /^제\s*\d+조(?:의\d+)?\s*삭제/.test(artContent);

    // 항 파싱
    const rawParagraphs = ensureArray(art.항 || art.paragraph || []);
    const paragraphs = rawParagraphs.map(p => {
      const pNo = getText(p.항번호 || p.pNo);
      const pContent = getText(p.항내용 || p.content);
      
      // 호 파싱
      const rawItems = ensureArray(p.호 || p.item || []);
      const items = rawItems.map(it => {
        const itemNo = getText(it.호번호 || it.itemNo);
        const itemContent = getText(it.호내용 || it.content);
        
        // 목 파싱
        const rawSubItems = ensureArray(it.목 || it.subItem || []);
        const subItems = rawSubItems.map(sub => ({
          subItemNo: getText(sub.목번호 || sub.subItemNo),
          content: getText(sub.목내용 || sub.content)
        }));

        return {
          itemNo,
          content: itemContent,
          subItems
        };
      });

      return {
        paragraphNo: pNo,
        content: pContent,
        items
      };
    });

    return {
      articleNo: artNo,
      branchNo: artBranchNo,
      fullArticleNo: artBranchNo ? `${artNo}의${artBranchNo}` : artNo,
      title: artTitle,
      content: artContent,
      enforceDate,
      isDeleted,
      paragraphs
    };
  });

  // 3. 별표 / 서식 파싱
  const annexRoot = lawRoot.별표 || lawRoot.annexes || lawRoot;
  const rawAnnexes = ensureArray(annexRoot.별표단위 || annexRoot.annex || []);
  parsed.annexes = rawAnnexes.map(an => ({
    annexNo: getText(an.별표번호 || an.annexNo),
    annexBranchNo: getText(an.별표가지번호 || an.branchNo),
    title: getText(an.별표제목 || an.title),
    fileType: getText(an.별표서식파일링크 || an.fileType),
    fileUrl: getText(an.별표서식링크 || an.fileUrl || an.별표PDF파일링크)
  }));

  return parsed;
}

export default {
  parseLawSearchList,
  parseLawDetail
};
