// server/law/lawTermKb.js - 일상어 ↔ 법률 전문용어 사전 및 법령 추천 지식베이스

export const LAW_TERM_KB = {
  // 1. 일상어 -> 법률 용어 매핑
  synonyms: {
    '월세': ['차임', '임대차', '주택임대차보호법'],
    '전세': ['임대차', '전세권', '주택임대차보호법', '보증금'],
    '계약해지': ['계약의 해제', '계약의 해지', '채무불이행'],
    '위약금': ['손해배상액의 예정', '위약벌'],
    '퇴직금': ['퇴직급여', '근로자퇴직급여 보장법'],
    '야근수당': ['연장근로수당', '야간근로수당', '휴일근로수당', '근로기준법 제56조'],
    '해고': ['근로계약의 해지', '부당해고', '근로기준법 제23조'],
    'CCTV': ['영상정보처리기기', '개인정보 보호법 제25조'],
    '개인정보유출': ['개인정보 유출 통지', '개인정보 보호법 제34조', '과징금'],
    '환불': ['청약철회', '원상회복', '전자상거래 등에서의 소비자보호에 관한 법률'],
    '사기': ['기망행위', '형법 제347조', '불법행위'],
    '명예훼손': ['사실적시 명예훼손', '허위사실유포', '정보통신망법 제70조'],
    '음주운전': ['도로교통법 제44조', '음주측정거부', '면허취소'],
    '영업정지': ['행정처분', '행정절차법', '사전통지', '청문', '행정심판'],
    '조례위반': ['지방자치법', '자치법규', '과태료 부과처분'],
    '수의계약': ['국가계약법', '지방계약법', '추정가격'],
    '하도급': ['하도급거래 공정화에 관한 법률', '대금직접지급', '원사업자']
  },

  // 2. 주요 법률 도메인별 핵심 법령 목록
  domainLaws: {
    privacy: [
      { name: '개인정보 보호법', mainArticles: ['제15조', '제17조', '제18조', '제29조', '제34조'] },
      { name: '정보통신망 이용촉진 및 정보보호 등에 관한 법률', mainArticles: ['제44조', '제50조'] },
      { name: '신용정보의 이용 및 보호에 관한 법률', mainArticles: ['제32조', '제33조'] }
    ],
    labor: [
      { name: '근로기준법', mainArticles: ['제23조', '제26조', '제50조', '제53조', '제56조'] },
      { name: '남녀고용평등과 일·가정 양립 지원에 관한 법률', mainArticles: ['제14조', '제19조'] },
      { name: '산업안전보건법', mainArticles: ['제38조', '제39조'] }
    ],
    contract: [
      { name: '민법', mainArticles: ['제390조', '제398조', '제543조', '제548조', '제750조'] },
      { name: '상법', mainArticles: ['제46조', '제54조', '제64조'] },
      { name: '약관의 규제에 관한 법률', mainArticles: ['제6조', '제8조', '제9조'] }
    ],
    admin: [
      { name: '행정기본법', mainArticles: ['제8조', '제10조', '제14조', '제18조', '제19조'] },
      { name: '행정절차법', mainArticles: ['제21조', '제22조', '제23조'] },
      { name: '행정심판법', mainArticles: ['제13조', '제27조'] },
      { name: '지방자치법', mainArticles: ['제28조', '제29조'] }
    ]
  }
};

/**
 * 질의어에서 법률 키워드 및 동의어 확장
 * @param {string} query 
 * @returns {{ expandedTerms: string[], suggestedLaws: Array<{name: string, mainArticles: string[]}> }}
 */
export function expandQueryKeywords(query) {
  if (!query) return { expandedTerms: [], suggestedLaws: [] };
  
  const expandedTerms = new Set();
  const matchedLaws = new Set();

  for (const [term, lawTerms] of Object.entries(LAW_TERM_KB.synonyms)) {
    if (query.includes(term)) {
      expandedTerms.add(term);
      lawTerms.forEach(lt => expandedTerms.add(lt));
    }
  }

  // 도메인 매칭
  if (/개인정보|정보보호|cctv|동의|유출/i.test(query)) {
    LAW_TERM_KB.domainLaws.privacy.forEach(l => matchedLaws.add(JSON.stringify(l)));
  }
  if (/근로|퇴직|휴일|임금|해고|근무|야근/i.test(query)) {
    LAW_TERM_KB.domainLaws.labor.forEach(l => matchedLaws.add(JSON.stringify(l)));
  }
  if (/계약|해제|해지|위약|손해배상|약관|채무/i.test(query)) {
    LAW_TERM_KB.domainLaws.contract.forEach(l => matchedLaws.add(JSON.stringify(l)));
  }
  if (/처분|취소|행정|인허가|조례|과태료|영업정지/i.test(query)) {
    LAW_TERM_KB.domainLaws.admin.forEach(l => matchedLaws.add(JSON.stringify(l)));
  }

  return {
    expandedTerms: Array.from(expandedTerms),
    suggestedLaws: Array.from(matchedLaws).map(s => JSON.parse(s))
  };
}

export default {
  LAW_TERM_KB,
  expandQueryKeywords
};
