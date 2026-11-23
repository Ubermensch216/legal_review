// public/js/analysisDepthView.js - 기본분석 결과임을 알리고 심화분석으로 이어 가는 안내
//
// 기본분석 결과가 전체 검증을 거친 결과처럼 읽히지 않도록 결과 맨 위에 범위를 숫자로 보여 준다.

const text = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
};

/** 무엇을 했고 무엇을 하지 않았는지 한 줄씩. 값이 없는 항목은 뺀다. */
export function describeCoverage(coverage = {}) {
  const done = [];
  if (Number.isFinite(coverage.judgedElements)) done.push(`판단한 요건 ${coverage.judgedElements}개`);
  if (Number.isFinite(coverage.pairs)) done.push(`근거 대조 ${coverage.checkedPairs ?? 0}/${coverage.pairs}쌍`);
  const left = [];
  if (coverage.skippedSkeletons) left.push(`미검증 요건 ${coverage.skippedSkeletons}개`);
  if (coverage.deferredEvidence) left.push(`판례·해석례 등 근거 ${coverage.deferredEvidence}건`);
  left.push('판례 유추', '반대 논리', '수정 조문');
  return { done: done.join(' · '), left: left.join(', ') };
}

export function renderDepthBanner(data) {
  const banner = document.getElementById('analysis-depth-banner');
  if (!banner) return;
  const review = data?.review;
  const isBasic = review?.analysisDepth === 'BASIC';
  banner.classList.toggle('hidden', !isBasic);
  banner.replaceChildren();
  if (!isBasic) return;

  const { done, left } = describeCoverage(review.analysisCoverage);
  const body = document.createElement('div');
  body.className = 'depth-banner-body';
  body.append(text('strong', '', '기본분석 결과입니다'));
  if (done) body.append(text('span', '', done));
  body.append(text('span', 'depth-banner-left', `심화분석에서 추가로 확인: ${left}`));

  // 방금 실행한 검토만 서버에 산출물이 남아 있어 이어서 분석할 수 있다.
  const live = Boolean(data.escalationLive && review.analysisSession?.reviewId);
  if (!live) body.append(text('span', 'depth-banner-left', '이력에서 불러온 결과는 질의와 문서를 다시 입력한 뒤 심화분석을 처음부터 실행합니다.'));

  const button = text('button', 'btn btn-primary btn-sm', '심화분석 실행');
  button.type = 'button';
  button.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('analysis:deepen', { detail: { reviewId: live ? review.analysisSession.reviewId : null } }));
  });
  banner.append(body, button);
}

document.addEventListener('workbench:rendered', event => renderDepthBanner(event.detail));
