/** 첨부 원문 안에 기존 AI 보고서 틀이 섞인 경우를 표시한다. 원문은 삭제하지 않는다. */
export function generatedReportShellWarning(text = '') {
  return /\[검토 제한 및 출처 안내\]/.test(text)
    && /본 검토의견서는 AI 법령검토 시스템에 의해 작성된 참고자료/.test(text)
    ? '첨부문서에 기존 AI 검토보고서의 머리말·제한 안내가 포함되어 있습니다. 해당 문구는 사건 사실이나 공식 법령 근거가 아닙니다.'
    : '';
}
