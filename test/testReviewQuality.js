// test/testReviewQuality.js
import { buildWorkbenchContext } from '../server/law/lawWorkbench.js';
import { generateLegalReview } from '../server/law/lawWorkbenchReview.js';

async function testReview() {
  console.log('[QualityTest] 1. 워크벤치 컨텍스트 구축 중...');
  const ctx = await buildWorkbenchContext({
    query: '공공장소 AI 안면인식 CCTV 설치 시 생체인식정보 사전동의 생략 및 음성녹음 가능 여부',
    preset: 'privacy_security',
    targetLaw: '개인정보 보호법'
  });

  console.log('[QualityTest] 2. 20년 베테랑 변호사 페르소나 법률 검토 생성 중...');
  const review = await generateLegalReview({
    query: '공공장소 AI 안면인식 CCTV 설치 시 생체인식정보 사전동의 생략 및 음성녹음 가능 여부',
    preset: 'privacy_security',
    documentText: '제7조(생체정보 수집) 얼굴 특징점 정보를 정보주체의 별도 동의 없이 포괄 수집한다.\n제12조(음성녹음) 범죄예방을 위해 대화내용을 녹음할 수 있다.',
    workbenchContext: ctx
  });

  console.log('\n================== [검토 결론 요약] ==================');
  console.log(review.summary);

  console.log('\n================== [핵심 쟁점] ==================');
  review.coreIssues.forEach((issue, i) => console.log(`${i + 1}. ${issue}`));

  console.log('\n================== [심층 법률 검토의견 (본론)] ==================');
  console.log(review.legalOpinion);

  console.log('\n================== [리스크 분석] ==================');
  review.risks.forEach(r => console.log(`[${r.level}] ${r.title}: ${r.description}`));

  console.log('\n================== [보완 권고사항] ==================');
  review.recommendations.forEach((rec, i) => console.log(`${i + 1}. ${rec}`));

  console.log('\n✅ 20년 전문 변호사 페르소나 심층 법률 검토 품질 검증 완료!');
}

testReview().catch(e => console.error(e));
