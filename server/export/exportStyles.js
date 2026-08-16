// server/export/exportStyles.js - 공공기관 공문서/보고서 표준 서식 스타일 프로필

export const EXPORT_STYLES = {
  // 공공기관 표준 검토의견서 프로필
  LEGAL_OPINION: {
    title: '법 률 검 토 의 견 서',
    fontFamily: 'Batang, 바탕, 맑은 고딕, Arial',
    titleFontSize: 22,
    h1FontSize: 15,
    h2FontSize: 12,
    bodyFontSize: 10.5,
    lineSpacing: 1.6,
    margins: { top: 20, bottom: 20, left: 25, right: 25 },
    colors: {
      primary: '#1E3A8A', // Deep Navy
      secondary: '#475569',
      border: '#CBD5E1',
      tableHeaderBg: '#F1F5F9',
      riskHigh: '#DC2626',
      riskMed: '#D97706',
      riskLow: '#2563EB'
    }
  },

  // 자치법규/조례 정비안 프로필
  ORDINANCE_REVIEW: {
    title: '자 치 법 규 검 토 보 고 서',
    fontFamily: 'Batang, 바탕, 맑은 고딕',
    titleFontSize: 20,
    h1FontSize: 14,
    bodyFontSize: 10,
    lineSpacing: 1.5
  },

  // 민원 회신 공문 프로필
  ADMIN_REPLY: {
    title: '법 령 질 의 회 신 서',
    fontFamily: 'Malgun Gothic, 맑은 고딕',
    titleFontSize: 20,
    h1FontSize: 13,
    bodyFontSize: 10,
    lineSpacing: 1.6
  }
};

export default EXPORT_STYLES;
