// server/reasoning/documentProfile.js - 첨부문서의 성격과 의뢰 목적을 코드로 식별한다 (LLM 호출 없음)
//
// 같은 "법률 검토"여도 계약서, 감사 결과 보고서, 처분서, 규정 본문, 기존 검토의견서는 쟁점을 세우는 방향이 다르다.
// 문서 종류를 모르는 채 쟁점을 뽑으면 보고서의 지적 문장을 사실로 받아들이거나, 규정 본문을 사건 사실로
// 오인한다. 키워드 신호로 종류를 가볍게 판별해 S1 지시문에 한 줄 방향으로 싣는다.
// 판별은 후보일 뿐이다. 신호가 약하면 UNKNOWN으로 두고 아무것도 덧붙이지 않는다.

const TYPES = [
  { type: 'AI_REVIEW', label: '기존 검토의견서', min: 2,
    signals: [/법률\s*검토\s*의견서|검토\s*의견서/, /검토\s*요지/, /쟁점별\s*검토/, /결론\s*표/, /AI\s*법령검토/, /참고자료이며.{0,20}최종\s*감수/],
    guidance: '이 문서는 이미 작성된 검토의견서다. 문서가 내린 결론을 사실로 받아들이지 말고, 그 결론이 의존한 사실·법령 적용이 타당한지를 쟁점으로 세운다.' },
  { type: 'AUDIT_REPORT', label: '감사 결과 보고서', min: 2,
    signals: [/감사\s*결과|감사\s*보고|지적\s*사항/, /처분\s*요구|시정|주의|통보|징계|회수/, /관련\s*규정|위반\s*사항/, /감사\s*기간|피감|수감/],
    guidance: '이 문서는 감사 결과 보고서다. 지적 사항마다 근거 법령 적용과 처분 수위가 타당한지를 쟁점으로 세운다. 지적문의 서술은 감사기관의 주장이며 확정 사실이 아니다.' },
  { type: 'DISPOSITION', label: '처분서·통지서', min: 2,
    signals: [/처분\s*사유|처분의\s*내용|처분\s*통지|통지서/, /이의\s*신청|행정심판|행정소송|불복/, /수신|발신|시행/, /과태료|영업정지|시정명령|허가\s*취소|부과/],
    guidance: '이 문서는 행정청의 처분서·통지서다. 처분의 절차(사전통지·의견제출·이유제시)와 실체(요건·재량·비례) 쟁점을 나눈다.' },
  { type: 'CONTRACT', label: '계약서', min: 3,
    signals: [/계약서|용역\s*계약|도급\s*계약|위탁\s*계약/, /\(?\s*갑\s*\)?.{0,12}\(?\s*을\s*\)?/s, /계약\s*기간|계약\s*금액|계약\s*보증금/, /해지|손해배상|지체상금|위약금/, /본\s*계약/],
    guidance: '이 문서는 계약서다. 계약 문언의 위험과 법적 효력을 분리하고, 조항별로 적용 법령과 강행규정 위반 여부를 쟁점으로 세운다.' },
  { type: 'REGULATION', label: '규정·조례·지침', min: 3,
    signals: [/제\s*1\s*조\s*\(?\s*목적/, /총칙|부칙/, /조례|규칙|규정|지침|훈령|예규/, /시행\s*한다|시행한다/, /제\s*\d+\s*조\s*\(/],
    guidance: '이 문서는 규정·조례·지침 본문이다. 사건 사실이 아니라 규범이므로, 조항이 상위 법령과 충돌하는지 또는 의뢰 질의에 어떻게 적용되는지를 쟁점으로 세운다.' },
  { type: 'INQUIRY', label: '질의서·질의회신 요청', min: 2,
    signals: [/질의\s*요지|질의\s*사항|질의\s*배경/, /회신|회답|답변\s*요청/, /갑설|을설|견해/, /사전\s*컨설팅|컨설팅\s*감사/],
    guidance: '이 문서는 질의서다. 질의 요지를 법률 쟁점으로 바꾸고, 견해가 갈리면 해석 대립 쟁점으로 세운다.' }
];

// 의뢰 목적. 질의 문장에서 무엇을 판단해 달라는지 읽는다.
const PURPOSES = [
  { purpose: 'LEGALITY', label: '위법·적법 여부 판단', test: /위법|적법|위반|합법|법에\s*맞|문제\s*(?:가\s*)?없|하자/ },
  { purpose: 'CONSEQUENCE', label: '처분·책임의 타당성 판단', test: /처분|징계|책임|환수|회수|과태료|배상|수위/ },
  { purpose: 'AMENDMENT', label: '개정·수정 방향 검토', test: /개정|수정|고쳐|보완|개선|정비/ },
  { purpose: 'APPLICABILITY', label: '적용 대상·요건 해당 여부', test: /해당\s*(?:되|하)|대상(?:인|이|에)|적용\s*(?:되|할|가능)|지급\s*대상|요건/ },
  { purpose: 'PROCEDURE', label: '절차 적정성 검토', test: /절차|기한|통지|의견\s*제출|청문|기간/ }
];

/**
 * @param {object} args
 * @param {string} [args.query] 사용자 질의
 * @param {string} [args.documentText] 첨부문서 전문(또는 앞부분)
 * @param {string} [args.fileName]
 * @returns {{ type: string, label: string, confidence: 'HIGH'|'MEDIUM'|'LOW', signals: string[], purpose: string|null,
 *   purposeLabel: string|null, guidance: string }}
 */
export function profileDocument({ query = '', documentText = '', fileName = '' } = {}) {
  const sample = `${fileName}\n${String(documentText).slice(0, 12000)}`;
  let best = null;
  for (const spec of TYPES) {
    const hits = spec.signals.filter(re => re.test(sample));
    if (hits.length < spec.min) continue;
    const score = hits.length - spec.min;
    if (!best || score > best.score || (score === best.score && hits.length > best.hits.length)) best = { spec, hits, score };
  }
  const purpose = PURPOSES.find(p => p.test.test(String(query)));
  const base = { purpose: purpose?.purpose || null, purposeLabel: purpose?.label || null };
  if (!best) {
    return { type: 'UNKNOWN', label: '문서 종류 미확정', confidence: 'LOW', signals: [], guidance: '', ...base };
  }
  return { type: best.spec.type, label: best.spec.label, confidence: best.score >= 2 ? 'HIGH' : 'MEDIUM',
    signals: best.hits.map(re => String(re.source).slice(0, 24)), guidance: best.spec.guidance, ...base };
}

/** S1 지시문에 덧붙일 문서 성격 문단. 판별이 약하면 빈 문자열. */
export function profilePromptLines(profile) {
  if (!profile || profile.type === 'UNKNOWN') {
    return profile?.purposeLabel ? `[의뢰 목적] ${profile.purposeLabel}` : '';
  }
  return [`[문서 성격] ${profile.label}${profile.confidence === 'MEDIUM' ? ' (추정)' : ''} — ${profile.guidance}`,
    profile.purposeLabel ? `[의뢰 목적] ${profile.purposeLabel}` : ''].filter(Boolean).join('\n');
}
