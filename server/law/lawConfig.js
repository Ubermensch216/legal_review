// server/law/lawConfig.js - 법령 API 및 워크벤치 설정 상수

export const LAW_CONFIG = {
  // 법제처 국가법령정보센터 DRF API (공식 오픈API)
  LAW_DRF_BASE_URL: 'http://www.law.go.kr/DRF/lawSearch.do',
  LAW_SERVICE_BASE_URL: 'http://www.law.go.kr/DRF/lawService.do',
  
  // 판례 및 기타 결정례 API
  PRECEDENT_BASE_URL: 'http://www.law.go.kr/DRF/lawSearch.do?target=prec',
  DECISION_BASE_URL: 'http://www.law.go.kr/DRF/lawSearch.do?target=expc',
  ADMIN_RULE_BASE_URL: 'http://www.law.go.kr/DRF/lawSearch.do?target=admrul',
  ORDINANCE_BASE_URL: 'http://www.law.go.kr/DRF/lawSearch.do?target=ordin',
  
  // API 타임아웃 및 재시도 설정 (고속 응답 최적화)
  TIMEOUT_MS: 3500,
  MAX_RETRIES: 1,
  RETRY_DELAY_MS: 200,
  
  // 캐시 TTL 설정 (밀리초)
  CACHE_TTL: {
    LAW_DETAIL: 7 * 24 * 60 * 60 * 1000,       // 법령 본문: 7일
    LAW_SEARCH: 24 * 60 * 60 * 1000,           // 검색 결과: 1일
    PRECEDENT_DETAIL: 30 * 24 * 60 * 60 * 1000,// 판례/해석례: 30일
    ORDINANCE_DETAIL: 7 * 24 * 60 * 60 * 1000, // 자치법규: 7일
    HISTORY: 30 * 24 * 60 * 60 * 1000          // 개정이력: 30일
  },
  
  // 기본 검토 프리셋 목록
  REVIEW_PRESETS: {
    COMPLIANCE: {
      id: 'compliance',
      name: '적법성/규제 준수 검토',
      description: '사업 기획, 제도 운영, 내부 규정의 관련 법령 위반 여부 및 인허가/신고 요건 검토'
    },
    CONTRACT_RISK: {
      id: 'contract_risk',
      name: '계약서/협약서 법적 리스크 분석',
      description: '독소 조항, 불공정 약관, 손해배상 및 해지 조항의 법률적 효력 및 리스크 검토'
    },
    ORDINANCE_CONFLICT: {
      id: 'ordinance_conflict',
      name: '조례/내규 상위법 충돌 검토',
      description: '지자체 조례, 공공기관 내규/지침의 상위 법령 위임 한계 일탈 및 법령 저촉 여부 검토'
    },
    ADMIN_DISPUTE: {
      id: 'admin_dispute',
      name: '행정처분/민원 대응 적법성',
      description: '인허가 불허, 과태료, 영업정지 등 행정처분의 절차적/실체적 적법성 및 행정심판/소송 가능성 검토'
    },
    PRIVACY_SECURITY: {
      id: 'privacy_security',
      name: '개인정보/보안 규제 검토',
      description: '개인정보보호법, 정보통신망법, 위치정보법 상 수집·이용 동의, 제3자 제공, 안전조치 의무 검토'
    },
    LABOR_HR: {
      id: 'labor_hr',
      name: '인사/노무/근로기준 검토',
      description: '근로계약, 취업규칙, 해고/징계, 주52시간제, 포괄임금 등 근로기준법 및 노동관계법 준수 검토'
    },
    PRE_CONSULTING_AUDIT: {
      id: 'pre_consulting_audit',
      name: '사전 컨설팅감사 의견 검토',
      description: '적극행정 사전 컨설팅감사 신청에 대하여 대립하는 견해(갑설·을설)의 타당성을 비교하고 수용/반려 의견을 제시'
    }
  }
};

export default LAW_CONFIG;
