// server/reasoning/stages/gaps.js - S7 공백 산출 (LLM 호출 없음)
//
// 로컬 엔진이 스스로 답하지 못한 지점을 요건 단위로 정리하고, 어디로 보낼지 정한다.
//   법리 공백(해석 불명·근거 충돌·근거 부재·단계 실패) → 외부 전문가 질의
//   사실 공백(사실 불명·입증 부족)                      → 사용자 확인 (외부로 보내지 않는다)
//   수집 공백(조회 실패·예산으로 제외)                   → 재수집
// 사실 공백을 외부로 보내지 않는 이유: 외부 전문가는 사건 사실을 알 수 없고, 보내면 비식별 부담만 커진다.

export const GAP_ROUTE = Object.freeze({
  LEGAL_INTERPRETATION: 'EXTERNAL_INQUIRY', AUTHORITY_CONFLICT: 'EXTERNAL_INQUIRY', MISSING_AUTHORITY: 'EXTERNAL_INQUIRY',
  STAGE_FAILURE: 'EXTERNAL_INQUIRY', FACT_UNKNOWN: 'USER', COLLECTION_FAILURE: 'RECOLLECT'
});
const MAX_INQUIRY_GAPS = 12;

const clip = (text, max) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };
// 모델의 openQuestion은 자유 문장이다. 입증 부족을 설명하는 문장을 법리 질의로 보내면
// 사건 사실이 외부 질의서에 섞이므로, 사실 확인 표현은 사용자 경로로 보낸다.
const FACT_QUESTION = /사실관계|자료|증빙|증거|확인|제시|실제|구체적|존재 여부|이루어졌|지급 여부|산정|내용이 .*없|여부가 .*없/;
const LEGAL_QUESTION = /해석|법리|법적|법률상|판례|조문|법령|효력|어떤 기준|판단.{0,15}기준|기준은 무엇/;

/**
 * @param {object} args
 * @param {object[]} args.issues S1 쟁점
 * @param {object[]} args.issueResults S4 결과
 * @param {object[]} args.warrants S6 원장
 * @param {string[]} args.unknownFacts S1이 찾은 자료 밖 사실
 * @param {string[]} args.collectionWarnings S2 조회 실패 경고
 */
export function deriveGaps({ issues, issueResults, warrants = [], unknownFacts = [], collectionWarnings = [],
  contractMode = false, registry = null }) {
  const gaps = [];
  const seen = new Set();
  const add = gap => {
    // 같은 조문의 요건은 여러 쟁점에 걸쳐 나온다. 요건 단위 공백은 쟁점이 달라도 한 번만 묻는다.
    // 쟁점에 매이지 않는 공백(자료 밖 사실·수집 실패)은 문장마다 다른 공백이다.
    const key = gap.elementId ? `${gap.elementId}|${gap.type}` : gap.issueId ? `${gap.issueId}||${gap.type}` : `-|${gap.type}|${gap.question}`;
    if (seen.has(key)) return;
    seen.add(key);
    gaps.push({ ...gap, route: GAP_ROUTE[gap.type], state: 'OPEN' });
  };

  for (const result of issueResults) {
    const issue = issues.find(i => i.id === result.issueId);
    const deciding = new Set(result.conclusion?.decidingElementIds || []);
    const weight = (issue.type === 'THRESHOLD' || issue.priority === 'CRITICAL') ? 2 : issue.priority === 'HIGH' ? 1 : 0;
    const base = elementId => ({ issueId: issue.id, elementId, changesOutcome: elementId ? deciding.has(elementId) : true,
      priority: weight + (elementId && deciding.has(elementId) ? 2 : 0) });

    if (result.stageStatus === 'FAILED' || result.stageStatus === 'SKIPPED') {
      const skipped = result.stageStatus === 'SKIPPED';
      add({ ...base(null), type: skipped ? 'MISSING_AUTHORITY' : 'STAGE_FAILURE',
        question: skipped
          ? `다음 쟁점에 적용할 공식 법령·판례·해석례와 판단 요건은 무엇인가? — ${issue.question}`
          : `다음 쟁점을 판단하기 위한 적용 요건·예외와 판단 기준은 무엇인가? — ${issue.question}` });
      continue;
    }
    for (const a of result.assessments || []) {
      // 결론을 좌우하지 않는 요건의 공백은 묻지 않는다. 소형 모델은 거의 모든 요건에 의문을 남기므로,
      // 걸러내지 않으면 질의서가 결론과 무관한 질문으로 찬다(실측: 사례 01에서 공백 24개).
      if (!deciding.has(a.elementId)) continue;
      const element = result.elements.find(e => e.id === a.elementId);
      const open = ['UNKNOWN', 'DISPUTED', 'PARTIALLY_SATISFIED'].includes(a.status);
      const proofMissing = ['INSUFFICIENT', 'NO_EVIDENCE'].includes(a.proof);
      const factualQuestion = Boolean(a.openQuestion) && (FACT_QUESTION.test(a.openQuestion)
        || (proofMissing && !LEGAL_QUESTION.test(a.openQuestion)));
      if (a.openQuestion && !factualQuestion) {
        add({ ...base(a.elementId), type: 'LEGAL_INTERPRETATION', question: clip(a.openQuestion, 300) });
      } else if (open && !a.evidenceIds.length && !proofMissing) {
        add({ ...base(a.elementId), type: 'MISSING_AUTHORITY',
          question: `'${clip(element?.text, 120)}' 요건의 충족 여부를 판단할 법령·판례·해석례는 무엇인가? (쟁점: ${clip(issue.question, 120)})` });
      } else if (open && a.status !== 'PARTIALLY_SATISFIED' && !proofMissing) {
        // 근거도 사실도 있는데 판단이 서지 않았다 — 해석 문제다.
        add({ ...base(a.elementId), type: 'LEGAL_INTERPRETATION',
          question: `'${clip(element?.text, 120)}' 요건은 어떤 기준으로 판단하는가? (쟁점: ${clip(issue.question, 120)})` });
      }
      // 법리 판단과 별개로 입증이 모자라면 사용자에게 사실 확인을 요청한다.
      const genericDocumentGap = contractMode && issue.documentIds?.length && !factualQuestion;
      if ((proofMissing || factualQuestion) && a.status !== 'NOT_SATISFIED' && !genericDocumentGap) {
        add({ ...base(a.elementId), type: 'FACT_UNKNOWN',
          question: factualQuestion
            ? clip(a.openQuestion, 300)
            : `'${clip(element?.text, 120)}' 요건을 입증할 자료(사실관계)를 확인해 주십시오.` });
      }
    }
    const supports = (result.precedents || []).some(p => p.stance === 'SUPPORTS' && p.relation !== 'NOT_RELEVANT');
    const opposes = (result.precedents || []).some(p => p.stance === 'OPPOSES' && p.relation !== 'NOT_RELEVANT');
    const unanswered = result.counter?.position && !result.counter?.response;
    if ((supports && opposes) || unanswered) {
      add({ ...base(null), type: 'AUTHORITY_CONFLICT', question: clip(`다음 쟁점에서 반대 견해 "${result.counter?.position || '상반된 판례·해석례'}"를 어떻게 평가해야 하는가? — ${issue.question}`, 300) });
    }
  }

  // 근거가 주장을 뒷받침하지 않는다고 판정된 결론 요건도 법리 공백이다.
  for (const w of warrants.filter(w => w.overall === 'NOT_SUPPORTED')) {
    const result = issueResults.find(r => r.issueId === w.issueId);
    if (!result?.conclusion?.decidingElementIds?.includes(w.elementId)) continue;
    add({ issueId: w.issueId, elementId: w.elementId, changesOutcome: true, priority: 3, type: 'MISSING_AUTHORITY',
      question: clip(`인용 근거가 다음 판단을 뒷받침하지 않습니다. 이를 뒷받침하거나 반박하는 근거는 무엇인가? — ${w.text}`, 300) });
  }
  for (const fact of unknownFacts) {
    if (contractMode && /D\d+/.test(fact) && [...fact.matchAll(/D\d+(?:\.\d+)?/g)].some(m => registry?.get(m[0]))) continue;
    add({ issueId: null, elementId: null, changesOutcome: false, priority: 0, type: 'FACT_UNKNOWN', question: clip(fact, 300) });
  }
  for (const warning of collectionWarnings) add({ issueId: null, elementId: null, changesOutcome: false, priority: 0, type: 'COLLECTION_FAILURE', question: clip(warning, 300) });

  gaps.sort((a, b) => b.priority - a.priority);
  // 질의서 질문 상한을 넘는 외부 질의 공백은 버리지 않고 다음 질의로 미룬다.
  let inquiries = 0;
  for (const gap of gaps) if (gap.route === 'EXTERNAL_INQUIRY' && ++inquiries > MAX_INQUIRY_GAPS) gap.state = 'DEFERRED';
  return gaps.map((g, i) => ({ id: `G${i + 1}`, ...g }));
}
