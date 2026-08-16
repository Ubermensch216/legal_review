// server/law/tools/toolRegistry.js - 19대 법령 도구 메타데이터 및 레지스트리

export const TOOL_DEFINITIONS = [
  {
    name: 'searchLaw',
    description: '국가법령정보센터에서 법령명 또는 키워드로 현행 법령을 검색합니다.',
    parameters: {
      query: { type: 'string', description: '검색할 법령명 또는 키워드', required: true },
      page: { type: 'number', description: '페이지 번호 (기본 1)' },
      display: { type: 'number', description: '출력 건수 (기본 10)' }
    }
  },
  {
    name: 'searchAiLaw',
    description: '자연어 질의를 법률 전문용어로 확장하여 가장 적합한 법령과 조문을 추론 검색합니다.',
    parameters: {
      query: { type: 'string', description: '자연어 질문 또는 상황 설명', required: true }
    }
  },
  {
    name: 'articleDetail',
    description: '특정 법령의 특정 조문(예: 제15조, 제15조의2)의 전문과 항/호 목록을 상세 조회합니다.',
    parameters: {
      lawName: { type: 'string', description: '법령명', required: true },
      articleNo: { type: 'string', description: '조문 번호 (예: 15 또는 15의2)', required: true }
    }
  },
  {
    name: 'articleAt',
    description: '조문의 특정 항/호/목(예: 제1항 제2호 가목) 세부 텍스트를 정확히 핀포인트 추출합니다.',
    parameters: {
      lawName: { type: 'string', description: '법령명', required: true },
      articleNo: { type: 'string', description: '조문 번호', required: true },
      paragraphNo: { type: 'string', description: '항 번호' },
      itemNo: { type: 'string', description: '호 번호' }
    }
  },
  {
    name: 'articleDiff',
    description: '개정 전 조문과 개정 후 조문 텍스트 간의 변경점(추가/삭제)을 정밀 비교합니다.',
    parameters: {
      oldText: { type: 'string', description: '구 조문 텍스트', required: true },
      newText: { type: 'string', description: '신 조문 텍스트', required: true }
    }
  },
  {
    name: 'lawHistory',
    description: '특정 법령의 제정/개정 이력 및 공포일자, 시행일자 타임라인을 조회합니다.',
    parameters: {
      lawName: { type: 'string', description: '법령명', required: true }
    }
  },
  {
    name: 'lawStructure',
    description: '법령의 편-장-절-관-조문 전체 계층적 목차 구조를 반환합니다.',
    parameters: {
      lawName: { type: 'string', description: '법령명', required: true }
    }
  },
  {
    name: 'delegatedLaws',
    description: '상위 법률에서 대통령령(시행령) 또는 부령(시행규칙)으로 위임된 조문 체계를 추적합니다.',
    parameters: {
      lawName: { type: 'string', description: '모법 법률명', required: true },
      articleNo: { type: 'string', description: '위임 조문 번호' }
    }
  },
  {
    name: 'linkedOrdinances',
    description: '해당 법령의 위임에 따라 지자체에서 제정한 관련 조례/자치법규 목록을 검색합니다.',
    parameters: {
      lawName: { type: 'string', description: '상위 법령명', required: true },
      region: { type: 'string', description: '특정 지자체명(예: 서울특별시, 경기도 등)' }
    }
  },
  {
    name: 'annexes',
    description: '법령에 딸린 별표, 서식, 과태료/행정처분 기준표 목록 및 다운로드 링크를 조회합니다.',
    parameters: {
      lawName: { type: 'string', description: '법령명', required: true }
    }
  },
  {
    name: 'precedents',
    description: '관련 쟁점 및 조문에 대한 대법원 판례 및 하급심 판결요지를 검색합니다.',
    parameters: {
      query: { type: 'string', description: '판례 검색 키워드 또는 사건번호', required: true },
      display: { type: 'number', description: '가져올 건수' }
    }
  },
  {
    name: 'interpretations',
    description: '법제처 및 관계부처의 공식 법령해석례 및 질의회신 사례를 검색합니다.',
    parameters: {
      query: { type: 'string', description: '해석례 검색 키워드', required: true },
      display: { type: 'number', description: '가져올 건수' }
    }
  },
  {
    name: 'adminRules',
    description: '소관부처의 훈령, 예규, 고시 등 행정규칙을 검색합니다.',
    parameters: {
      query: { type: 'string', description: '행정규칙 검색 키워드', required: true }
    }
  },
  {
    name: 'decisions',
    description: '헌법재판소 결정례 및 중앙행정심판위원회 재결례를 검색합니다.',
    parameters: {
      query: { type: 'string', description: '결정례/재결례 검색 키워드', required: true }
    }
  },
  {
    name: 'impactMap',
    description: '첨부문서나 내부 규정 텍스트를 분석하여 관련 상위 법령과의 충돌 위험 및 규제 영향도를 매핑합니다.',
    parameters: {
      documentText: { type: 'string', description: '검토 대상 내부 문서 텍스트', required: true },
      targetLaw: { type: 'string', description: '기준이 되는 상위 법령명' }
    }
  },
  {
    name: 'timeTravel',
    description: '과거 특정 시점(연월일)에 유효했던 과거 법령 조문을 조회합니다.',
    parameters: {
      lawName: { type: 'string', description: '법령명', required: true },
      targetDate: { type: 'string', description: '조회 기준일자 (YYYYMMDD)', required: true },
      articleNo: { type: 'string', description: '조문 번호' }
    }
  },
  {
    name: 'verifyCitations',
    description: '문서 내에 인용된 모든 조문(제O조)이 현행 법령상 실제로 존재하는지 유효성을 검증합니다.',
    parameters: {
      text: { type: 'string', description: '인용문이 포함된 원문 텍스트', required: true },
      lawName: { type: 'string', description: '기본 법령명' }
    }
  }
];

export default TOOL_DEFINITIONS;
