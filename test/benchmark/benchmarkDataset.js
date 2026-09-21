// test/benchmark/benchmarkDataset.js - 실제 공공/기업 법률 검토 20종 벤치마크 데이터셋

export const BENCHMARK_20_DATASET = [
  {
    id: 'BENCH-01',
    category: 'privacy',
    title: '스마트시티 AI 안면인식 CCTV 생체정보 수집 및 음성녹음',
    query: '공공장소 AI 안면인식 CCTV 설치 시 생체인식정보 사전동의 생략 및 음성녹음 허용 지침의 적법성 검토',
    targetLaw: '개인정보 보호법',
    expectedArticles: ['제15조', '제23조', '제25조'],
    keyRisks: ['음성녹음 금지 위반', '생체인식 민감정보 사전동의 생략'],
    expectedPrecedentCourt: '대법원',
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-02',
    category: 'admin_ordinance',
    title: '지자체 공유 개인형 이동장치(PM) 무단견인 및 즉시 등록취소 조례안',
    query: '공유 킥보드 무단 방치 시 청문 절차 없는 즉시 사업자 등록취소 및 조례를 통한 가중 과태료 50만원 부과의 상위법 충돌 검토',
    targetLaw: '지방자치법',
    expectedArticles: ['제28조', '제29조'],
    keyRisks: ['법률유보원칙 위배', '행정절차법상 청문 생략 위법'],
    expectedPrecedentCourt: '대법원',
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-03',
    category: 'labor',
    title: 'IT 스타트업 포괄임금제 취업규칙 및 야근수당 부지급',
    query: '기본급에 모든 연장·야간·휴일근로수당이 포함된 것으로 간주하고 실제 초과근로에 대한 가산수당을 지급하지 않는 취업규칙의 효력',
    targetLaw: '근로기준법',
    expectedArticles: ['제23조', '제56조'],
    keyRisks: ['포괄임금제 약정 무효', '임금체불 및 형사처벌 위험'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-04',
    category: 'contract',
    title: '소프트웨어 개발 용역 계약서의 일방적 지체상금 및 손해배상 면책 조항',
    query: '수급인의 경미한 지체에 대해 1일당 계약금의 1% 지체상금을 부과하고 발주자의 손해배상 책임을 전면 면책하는 계약 조항',
    targetLaw: '약관의 규제에 관한 법률',
    expectedArticles: ['제6조', '제7조'],
    keyRisks: ['과다한 손해배상액 예정 무효', '일방적 면책 조항 무효'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-05',
    category: 'admin',
    title: '지자체 문화재단 보조금 환수 처분 및 신뢰보호원칙 위배',
    query: '적법하게 교부된 지자체 지방보조금에 대해 정책 변경을 이유로 사후 일괄 환수 처분을 내릴 경우의 적법성',
    targetLaw: '지방보조금법',
    expectedArticles: ['제34조'],
    keyRisks: ['신뢰보호원칙 위반', '수익적 행정행위 철회 한계 일탈'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-06',
    category: 'privacy',
    title: '온라인 플랫폼 회원가입 시 필수적 마케팅 정보 수집 및 제3자 제공 동의',
    query: '서비스 이용 필수 조건으로 위치정보 및 맞춤형 광고 수신 동의를 포괄적으로 획득하는 행위의 적법성',
    targetLaw: '개인정보 보호법',
    expectedArticles: ['제16조', '제17조', '제18조'],
    keyRisks: ['최소수집원칙 위반', '동의 거부를 이유로 한 서비스 거부 금지 위반'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-07',
    category: 'subcontract',
    title: '하도급 대금 부당 감액 및 대금직접지급 청구',
    query: '원사업자가 수급사업자의 납품 완료 후 자사 경영 악화를 이유로 하도급 대금을 15% 일방 삭감한 행위',
    targetLaw: '하도급거래 공정화에 관한 법률',
    expectedArticles: ['제11조', '제13조', '제14조'],
    keyRisks: ['부당한 하도급대금 감액 금지 위반', '과징금 부과 및 3배 손해배상'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-08',
    category: 'ecommerce',
    title: '전자상거래 플랫폼의 단순변심 환불 일체 불가 특약',
    query: '해외 직구 또는 주문제작 상품이라는 이유로 7일 이내 청약철회를 전면 거부하는 쇼핑몰 이용약관',
    targetLaw: '전자상거래 등에서의 소비자보호에 관한 법률',
    expectedArticles: ['제17조', '제18조'],
    keyRisks: ['청약철회권 제한 무효', '시정명령 및 과태료 대상'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-09',
    category: 'labor',
    title: '육아휴직 복직자에 대한 직무 미부여 및 불리한 전보 처분',
    query: '육아휴직 후 복귀한 근로자에게 기존 관리직 대신 단순 서무직을 부여하고 연봉을 삭감한 조치의 적법성',
    targetLaw: '남녀고용평등과 일·가정 양립 지원에 관한 법률',
    expectedArticles: ['제14조', '제19조'],
    keyRisks: ['육아휴직 복귀자 차별처우 금지 위반', '3년 이하 징역 또는 3천만원 이하 벌금'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-10',
    category: 'public_contract',
    title: '국가계약법상 부정당업자 입찰참가자격 제한 및 효력정지 가처분',
    query: '공공기관 입찰 과정에서 단순 서류 오기를 이유로 6개월 입찰참가자격을 제한한 행정처분의 비례원칙 위반 여부',
    targetLaw: '국가를 당사자로 하는 계약에 관한 법률',
    expectedArticles: ['제27조'],
    keyRisks: ['재량권 일탈·남용', '과잉금지원칙 위배'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-11',
    category: 'privacy',
    title: '클라우드 SaaS 데이터 센터 해외 이전 시 개인정보 국외이전 동의',
    query: '이용자의 개인정보가 저장된 데이터베이스를 싱가포르 AWS 리전으로 이전하면서 별도 동의나 고지를 생략한 경우',
    targetLaw: '개인정보 보호법',
    expectedArticles: ['제28조의8', '제39조의11'],
    keyRisks: ['개인정보 국외이전 법정 요건 미충족', '과징금 부과 위험'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-12',
    category: 'admin',
    title: '식품위생법상 영업소 폐쇄명령 전 사전통지 및 의견제출 기회 미부여',
    query: '위생점검 적발 직후 행정절차법상 사전통지 및 청문 절차를 거치지 않고 당일 영업소 폐쇄 처분을 단행한 경우',
    targetLaw: '행정절차법',
    expectedArticles: ['제21조', '제22조', '제23조'],
    keyRisks: ['절차적 하자(사전통지 누락)로 인한 처분 취소 사유'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-13',
    category: 'commercial',
    title: '상가 임대인의 계약갱신 요구 거절 및 권리금 회수 방해',
    query: '10년의 계약갱신기간이 경과하였다는 이유로 임차인이 주선한 신규 임차인과의 임대차계약 체결을 거절하고 권리금을 회수하지 못하게 한 행위',
    targetLaw: '상가건물 임대차보호법',
    expectedArticles: ['제10조', '제10조의4'],
    keyRisks: ['권리금 회수방해로 인한 손해배상 책임'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-14',
    category: 'labor',
    title: '정규직 전환 약정 기간제 근로자의 갱신기대권 부당 거절',
    query: '2년 계약만료 시 평가를 거쳐 무기계약직으로 전환하기로 공지하였으나, 합리적 이유 없이 재계약을 거부한 해고 통보',
    targetLaw: '기간제 및 단시간근로자 보호 등에 관한 법률',
    expectedArticles: ['제4조'],
    keyRisks: ['갱신기대권 침해', '부당해고 구제신청 인용 가능성'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-15',
    category: 'civil',
    title: '부동산 매매계약 체결 후 중도금 지급 전 매도인의 계약금 배액상환 해제',
    query: '매수인이 중도금 기일 전에 중도금을 일방 입금한 경우 매도인의 민법 제565조 해약금에 기한 계약해제권 행사 가능 여부',
    targetLaw: '민법',
    expectedArticles: ['제543조', '제565조'],
    keyRisks: ['이행 착수 인정 여부에 따른 해제권 상실'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-16',
    category: 'fair_trade',
    title: '프랜차이즈 가맹본부의 필수품목 강제 및 과도한 차액가맹금 수취',
    query: '시중에서 쉽게 구할 수 있는 주방 집기를 가맹본부로부터만 고가에 구매하도록 강제하고 미구매 시 계약을 해지하는 행위',
    targetLaw: '가맹사업거래의 공정화에 관한 법률',
    expectedArticles: ['제12조'],
    keyRisks: ['구속조건부 거래 및 불공정거래행위', '시정명령 및 과징금'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-17',
    category: 'privacy',
    title: '근로자 동의 없는 사내 메신저 및 웹 방문 기록 열람 감시',
    query: '회사 보안 감사를 이유로 근로자 사전 동의 없이 사내 메신저 비밀대화 내역과 개인 메일을 열람한 경우',
    targetLaw: '개인정보 보호법',
    expectedArticles: ['제15조', '제29조'],
    keyRisks: ['통신비밀보호법 및 개인정보보호법 위반', '형사 책임'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-18',
    category: 'admin',
    title: '건축 불허가 처분에 대한 비례원칙 위반 및 행정심판 청구',
    query: '인근 주민들의 집단 민원이 있다는 사유만으로 법정 건축요건을 모두 충족한 건축신고를 반려한 행정처분',
    targetLaw: '행정기본법',
    expectedArticles: ['제8조', '제10조', '제12조'],
    keyRisks: ['부당결부금지원칙 위반', '재량권 일탈에 따른 취소'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-19',
    category: 'copyright',
    title: '생성형 AI 모델 학습용 웹 크롤링 데이터 이용과 저작권 침해',
    query: '저작권자의 사전 허락 없이 저작권 표기가 있는 인터넷 뉴스 기사 및 도서를 상업적 AI 파운데이션 모델 학습에 무단 크롤링한 사안',
    targetLaw: '저작권법',
    expectedArticles: ['제35조의3', '제35조의5'],
    keyRisks: ['공정이용(Fair Use) 성립 한계', '손해배상 및 서비스 중단 위험'],
    hasRedlineExpected: true
  },
  {
    id: 'BENCH-20',
    category: 'safety',
    title: '중대재해처벌법상 경영책임자의 안전보건확보의무 미이행',
    query: '도급인이 수급업체 근로자의 추락 위험 구역에 대한 안전조치 예산 및 점검 체계를 배정하지 않아 사망사고가 발생한 경우',
    targetLaw: '중대재해 처벌 등에 관한 법률',
    expectedArticles: ['제4조', '제5조', '제6조'],
    keyRisks: ['경영책임자 1년 이상 징역 또는 10억원 이하 벌금', '5배 징벌적 손해배상'],
    hasRedlineExpected: true
  },
  {
    // 실제 사건 기반 정답 케이스.
    // 부산광역시 사전 컨설팅감사 의견서(접수번호 2026-24)의 결론을 정답으로 삼는다.
    // 자치법규·행정규칙 조문이 수집되지 않으면 이 사안은 답할 수 없으므로,
    // 조례/고시 조회 경로의 회귀를 잡아내는 케이스이기도 하다.
    id: 'BENCH-21',
    category: 'public_property',
    title: '영화의전당 국제영화제 사무공간 행정재산 사용료 산정방식 (사전 컨설팅감사)',
    query: '관리위탁 중인 행정재산을 사용허가받은 단체에 사용료를 부과할 때 감정평가법인등의 감정평가액으로 산출해야 하는지(갑설), 공유재산법령·조례의 공용면적 산정방식으로 산출해야 하는지(을설)',
    targetLaw: '공유재산 및 물품 관리법 시행령',
    expectedArticles: ['제14조', '제31조'],
    expectedOrdinances: ['부산광역시 공유재산 및 물품 관리 조례', '부산광역시 사전 컨설팅감사 운영 조례'],
    expectedOrdinanceArticles: ['제22조'],
    expectedAdminRules: ['지방자치단체 공유재산 운영기준'],
    keyRisks: ['감정평가액 적용은 시행령 제31조제2항제1호 단서의 예외 요건을 충족할 때만 가능', '지방자치단체장의 자유재량 사항이 아님'],
    expectedPrecedentCourt: '서울고등법원',
    expectedConclusion: '반려',
    expectedPrevailingView: '을설',
    hasRedlineExpected: false
  }
];

export default {
  BENCHMARK_20_DATASET
};
