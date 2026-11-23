// server/reasoning/analysisDepth.js - 기본분석과 심화분석의 작업 범위
//
// 실측(사례 01, CPU 실행 3,533초): 포섭(S4) 75%, 근거 검증(S6) 17%, 나머지 8%.
// 포섭 호출의 대부분은 "요건 묶음 × 근거 묶음"의 반복이고, 절반은 결론에 영향을 주지 않는 미검증 골격 요건 판단이다.
// 그래서 기본분석은 검증만 줄이지 않고 포섭의 출력과 반복을 함께 줄인다.
//
// 두 분석은 같은 사실·쟁점·근거 수집(S1·S2)과 같은 결론 계산 규칙을 쓴다. 달라지는 것은
//   - 무엇을 모델에게 판단시키는가(결론을 좌우하는 요건만 / 전부)
//   - 판단이 근거와 맞는지 얼마나 확인하는가(판단을 내린 요건의 대표 근거만 / 모든 주장·근거 쌍)
// 이다. 기본분석은 어떤 경우에도 '검토 완료'로 표시하지 않는다.

export const ANALYSIS_DEPTH = Object.freeze({ BASIC: 'BASIC', DEEP: 'DEEP' });

const PROFILES = Object.freeze({
  BASIC: Object.freeze({
    depth: 'BASIC', label: '기본분석',
    // 임베딩으로 가르지 못한 경계 후보를 LLM에 묻지 않고 본문 확인 대상으로 남긴다(버리지 않는다).
    screenBoundary: 'KEEP',
    factTopUp: false,
    application: Object.freeze({ compact: true, elementsPerCall: 8, evidenceChars: 6000 }),
    verification: Object.freeze({ scope: 'DETERMINATE', pairsPerClaim: 2, fragmentsPerPair: 1 }),
    redlines: false,
    note: '이 의견서는 기본분석 결과입니다. 결론을 좌우하는 요건만 판단했고, 판단을 내린 요건마다 대표 근거 일부만 원문과 대조했습니다. '
      + '판례 유추·반대 논리·수정 조문은 포함하지 않았습니다. 결재나 외부 제출 전에는 심화분석을 실행하십시오.'
  }),
  DEEP: Object.freeze({
    depth: 'DEEP', label: '심화분석',
    screenBoundary: 'LLM',
    factTopUp: true,
    application: Object.freeze({ compact: false }),
    verification: Object.freeze({ scope: 'ALL' }),
    redlines: true,
    note: ''
  })
});

/** 값이 없거나 알 수 없으면 심화분석이다. 조용히 검증을 줄이는 쪽으로 떨어지면 안 된다. */
export const depthProfile = value => PROFILES[String(value || '').trim().toUpperCase()] || PROFILES.DEEP;
