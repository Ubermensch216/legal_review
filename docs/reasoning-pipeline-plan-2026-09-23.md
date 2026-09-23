# 단계형 법률 추론 파이프라인 — LLM 효율 중심 구현 계획

- 작성일: 2026-09-23
- 기준: `main` @ `31f2cd4`, 로컬 Ollama 0.34.2 / `gemma4:e2b`(5.1B, Q4_K_M) / `bge-m3`(설치됨, 미사용)
- 입력: `deep-research-report (1).md`(Legal Review 전문 법률분석 시스템 고도화 보고서), 현재 소스, 기존 `docs/audit/*`, `docs/research/*`
- 성격: 설계·구현 계획. 아래 "실측" 표시가 없는 시간·토큰 수치는 추정이며 Phase 0에서 측정으로 대체한다.

---

## 1. 결론

1. **보고서의 방향(쟁점 우선 → 쟁점별 조사 → 요건·사실·증거 매트릭스 → 반대논증 → 근거 검증)은 채택한다.** 다만 보고서는 8~9 FTE·22주·PostgreSQL·`/api/v2` 19개 엔드포인트를 전제로 하므로, 이 저장소(1인 개발, 로컬 5B 모델, SQLite)에는 **중간표현(IR)과 단계 분리만 가져오고 인프라는 보류**한다.
2. 이 프로젝트에서 LLM 비용의 병목은 **출력 토큰(디코드 ≈ 17 tok/s)** 과 **긴 입력의 prefill** 이다. 현재 구조는 한 번의 호출로 13개 필드 JSON(본문 2벌 포함)을 thinking 켠 채 생성해 둘 다 최대로 쓴다.
3. 따라서 새 파이프라인의 설계 원칙은 하나로 요약된다. **"LLM은 좁은 닫힌 질문에 ID로만 답하고, 결론 도출·인용 확인·문서 조립은 코드가 한다."**
4. 3쟁점 기준 LLM 호출은 약 7~9회로 늘지만 출력 토큰은 현재의 절반 이하, 호출 하나의 실패가 검토 전체를 규칙 기반 폴백으로 떨어뜨리지 않으며, 반복 검토에서는 캐시로 호출 수가 더 준다(추정, Phase 0에서 검증).
5. **추론 엔진은 로컬 모델만 쓴다.** 클라우드 제공자 연결 코드는 게이트웨이 어댑터로 남겨 두지만 기본 경로에서 호출하지 않는다. 로컬 엔진이 스스로 답할 수 없는 지점은 **외부 전문가 질의**로 해결한다(§6-A). 이를 위해 파이프라인이 "무엇을 모르는지"를 요건 단위의 구조화된 공백으로 산출하고, 질의서는 그 공백에서 만들어지며, 승인된 답변은 해당 쟁점·요건에 꽂혀 **그 쟁점만 다시 추론**한다.

---

## 2. 보고서 평가 — 채택 / 조정 / 보류

| 보고서 제안 | 판단 | 이유 |
|---|---|---|
| Retrieval 재작성 안 함, 기존 도구를 adapter로 재사용 | **채택** | 현 수집 계층(법령·판례 본문·해석례·조례·행정규칙·시점조회)은 감사 후 보강 완료 상태 |
| Issue를 Retrieval 전 독립 객체로 확정 | **채택** | 현재 쟁점은 최종 JSON의 `coreIssues` 문자열로만 존재해 재현율 측정 불가 |
| Elements-Proof Matrix, legal/proof 평가 분리 | **채택(핵심)** | 소형 모델에 "요건 하나 × 사실 몇 개" 단위 질문은 정확도·출력량 모두 유리 |
| 반대권위 의무 검색(adverse branch) | **조정 채택** | 쿼리 생성은 코드(예외·단서·반대 처분어)로, LLM은 입장 분류만 |
| Legal Warrant Verifier(존재→시점→관할→함의) | **조정 채택** | 존재·시점·관할은 기존 결정적 검증, 함의는 임베딩 선별 후 필요한 쌍만 LLM 판정 |
| 결론 = Rule + Element findings에서 도출 | **채택, 코드로 강제** | 요건 상태에서 결론을 코드가 계산하면 Conclusion Entailment가 구조적으로 100% |
| State Machine + 피드백 루프 | **축소** | LLM이 루프를 결정하지 않는다. 결정적 트리거·쟁점당 최대 1회 재조사 |
| Case Brief(holding/dicta) LLM 생성 | **대체** | 공식 API의 `판시사항`·`판결요지`가 이미 holding 요약이다. 번호별로 코드가 분해 |
| Legal Reasoning Graph DB(PostgreSQL + edge table) | **보류** | IR은 검토 이력 JSON에 저장. 재사용 캐시만 SQLite 테이블 추가 |
| `/api/v2` 19개 엔드포인트 | **보류** | 기존 `/api/law/workbench` NDJSON 스트림에 단계 이벤트만 추가 |
| Human review 등급·Rights Registry·모델/프롬프트 레지스트리 | **최소화** | 실행 원장에 `promptVersion`·모델·단계 기록만. 승인 워크플로는 후속 |
| Frontier + Local Hybrid | **대체** | 추론은 로컬 전용. 고난도 쟁점은 클라우드 모델 자동 호출 대신 **외부 전문가 질의**(사람이 비식별 질의서를 확인·반출하고 답변을 반입·승인)로 해결. 클라우드 어댑터는 연결 가능성만 유지 |
| Institutional knowledge layer(Harvey Vault, CoCounsel Workspaces) | **채택, 기존 기능 확장** | 승인된 외부 답변 카드가 곧 조직 지식층. 쟁점·요건 단위로 연결해 다음 사건의 질의 수를 줄임 |
| 특허 KR20260038848A(인용 의도 적합성 평가) | **주의 표시** | 함의 검증 설계가 문제영역이 가깝다. 상용화 전 청구항 기준 별도 검토 필요(본 계획은 FTO 판단 아님) |

---

## 3. 현행 검토 로직 진단 (LLM 효율 관점)

현재 흐름: `lawApi.js` `/workbench` → `buildWorkbenchContext`(수집, LLM 0회) → `generateLegalReview`(LLM 1~2회) → `verifyAndCorrectReviewCitations`(존재 검증).

| # | 위치 | 문제 | 효율·품질 영향 |
|---|---|---|---|
| 1 | [lawWorkbenchReview.js:137-187](../server/law/lawWorkbenchReview.js) | 단일 호출로 13개 필드 생성. `legalOpinion`과 `draftOpinion`이 같은 내용을 두 번 쓰고, 고정 문구 `disclaimer`까지 모델이 생성 | 출력 토큰의 상당 부분이 중복. 디코드 17 tok/s에서 곧바로 분 단위 시간 |
| 2 | [lawWorkbenchReview.js:585-600](../server/law/lawWorkbenchReview.js) | Ollama 호출에 `think` 제어 없음 | thinking 토큰이 `num_predict`를 먼저 소모(.env 주석: 4096에서 5,043토큰 절단). 실측 아래 §4 |
| 3 | 같은 위치 `format: 'json'` | JSON 스키마 미지정 → [normalizeReviewResult:805-812](../server/law/lawWorkbenchReview.js)의 필수 필드 검증 실패 시 **검토 전체가 규칙 기반 폴백** | 수 분의 생성이 한 필드 누락으로 폐기 |
| 4 | [lawWorkbenchReview.js:298-307](../server/law/lawWorkbenchReview.js) `shrinkToFit` | 모든 섹션을 0.7배씩 일괄 축소 | 쟁점과 무관한 근거와 결정적 근거가 같은 비율로 잘림 |
| 5 | 같은 파일 주석 207-209행 | "소형 모델은 2만 자 입력에서 단서를 못 찾고, 짧은 선택지에서는 정확히 고른다" — 이미 확인된 사실이나 사전 컨설팅감사 1단계에만 적용 | 이 원리를 파이프라인 전체로 일반화하는 것이 핵심 개선 |
| 6 | 1단계·본 호출의 system 프롬프트가 서로 다름 | Ollama KV 캐시 접두부 재사용 불가 | 매 호출 전체 prefill |
| 7 | [reRanker.js](../server/law/reRanker.js) | 문자열 일치·법원 가산 휴리스틱만 사용. `bge-m3` 설치돼 있으나 미사용. 파싱된 `referencedArticles`(참조조문)도 미사용 | 판례 적합도·문서 조항 회수율(contextRecall의 "표지 없는 중간 문장" 실패)의 상한 |
| 8 | [factualityVerifier.js](../server/law/factualityVerifier.js) | `legalBasis` 조문 존재만 확인. 본문 속 인용·주장-근거 대응은 검증 밖 | "실재하는 조문의 오인용"을 못 잡음 |
| 9 | 판례 섹션 | 한 건 3,000자 안팎을 통째로 싣음(.env `precedents:12000`) | `판결요지` 번호 단위로 쟁점 관련 명제만 실으면 입력이 크게 줄어듦 |
| 10 | 검토 간 재사용 없음 | 같은 조문의 요건 분해·같은 판례의 명제 분해를 매번 다시 모델에 맡김 | 반복 검토 시 불필요한 호출 |
| 11 | `callOllama`가 매 호출 `/api/tags` 조회 | 다단계화하면 호출마다 반복 | 사소하지만 실행당 1회로 줄임 |
| 12 | [manualLearning.js `createInquiry`](../server/law/manualLearning.js) | 완성된 검토의 자유서술(`legalOpinion`, `coreIssues`)을 로컬 모델이 **다시 읽고** 미해결 질문을 추측 | LLM 1회 추가 소모. 질문이 어느 쟁점·요건의 공백인지 연결되지 않아 답변이 와도 해당 부분만 다시 추론할 수 없음 |
| 13 | [manualLearningMemory.js `findLearningKnowledge`](../server/law/manualLearningMemory.js) | 승인 카드를 검토 전체 프롬프트에 한 덩어리로 주입, 사건 밖 재사용은 쟁점어 2개 일치로 판정 | 카드가 어느 요건 판단에 쓰였는지 추적 불가. 재검토가 매번 전체 파이프라인을 다시 돎 |
| 14 | 같은 파일 `checkLearningCases` | 외부 답변이 제시한 판례번호가 **이번에 이미 수집한 자료**에 없으면 미확인으로 끝남 | 외부 답변이 알려준 새 근거를 공식 API로 확인해 편입하는 경로가 없음 |

---

## 4. 실측 — 로컬 모델의 비용 구조 (2026-09-23)

동일 PC, `num_ctx 40960`, `temperature 0.1`, 5.2k 토큰 법령 본문 + 짧은 과제. 스크립트는 세션 스크래치에서 실행(저장소 미포함).

| 조건 | 입력 토큰 | prefill | 출력 토큰 | 디코드 | 비고 |
|---|---:|---:|---:|---:|---|
| thinking ON, 쟁점 추출 | 5,249 | 38.7s | **864** (사고 2,663자) | 51.7s | 첫 호출(적재 12.8s 별도) |
| thinking OFF, 예외요건 추출 | 5,244 | 39.2s | **75** | 4.2s | 결과 품질 동등 |
| thinking ON, 같은 과제 | 5,246 | 16.7s | 561 (사고 1,787자) | 32.2s | 내용은 OFF와 사실상 같음 |
| thinking OFF, 새 접두부 | 5,223 | 14.5s | 23 | 1.3s | |
| thinking OFF, **같은 접두부·다른 과제** | 5,224 | **0.3s** | 49 | 2.8s | KV 캐시 재사용 |
| thinking OFF, 같은 접두부·다른 과제 | 5,224 | **0.3s** | 11 | 0.6s | |

해석:

- **디코드 약 17 tok/s**로 일정. 출력 1,000토큰 ≈ 1분. .env 주석대로 컨텍스트가 커지면 디코드도 느려진다(3k → 21.5k에서 10.4 → 7.9 tok/s).
- **thinking은 추출·분류 작업에서 출력을 7~11배 늘리고 결과는 같았다.** 판단 단계에만 선택적으로 쓴다.
- **접두부가 바이트 단위로 같고 think 모드·`num_ctx`가 같으면 prefill이 0.3초**로 떨어진다. think 모드를 바꾸면 템플릿이 달라져 재사용이 깨진다(표 1→2행). 따라서 단계 순서·프롬프트 배치를 캐시에 맞춰 설계한다.
- 현재 단일 호출(입력 약 24k 토큰, 출력 5~8k 토큰 + 사고)은 추정 prefill 1~3분 + 디코드 6~10분이다.

---

## 5. 설계 원칙 — 작은 모델을 최대한 쓰는 법

| 원칙 | 구현 방법 | 효과 |
|---|---|---|
| P1. **닫힌 질문** | 모델에게 "찾아라"가 아니라 "이 후보 중 골라라/이 요건의 상태는?"을 묻는다 | 소형 모델 정확도(§3-5에서 이미 확인된 현상) |
| P2. **ID로만 인용** | 모든 근거·사실·조항에 결정적 ID(A3.2, P1.y2, D7, F4…)를 부여. 모델은 ID를 반환, 코드가 원문 확장 | 출력 토큰 절감 + 존재하지 않는 인용은 스키마 단계에서 원천 거부 |
| P3. **스키마 강제** | Ollama `format: <JSON Schema>`, OpenAI `json_schema`, Gemini `responseSchema` | 파싱 실패 → 폴백 경로 제거. 실패 시 해당 단계 1회 재시도 |
| P4. **think 선택 사용** | 추출·분류·요약 단계 `think:false`. 적용(포섭) 단계만 A/B 후 결정. 대안: `think:false` + 스키마 첫 필드에 200자 이내 `reasoning` | 출력 7~11배 절감(실측) |
| P5. **결론은 코드가** | 요건 상태 → 쟁점 결론, 선결쟁점 상태 → 후속 결론, 유보 조건을 규칙으로 계산 | Conclusion/Dependency 정합성 구조적 보장, 모델 출력 감소 |
| P6. **캐시 친화 프롬프트** | `[고정 system][실행 공통 접두부][쟁점 접두부][과제 접미부]` 순서. 같은 쟁점 단계는 연속 호출, think 모드별로 묶어 실행, 병렬 호출 금지(로컬) | prefill 재사용(실측 14.5s → 0.3s) |
| P7. **좁은 컨텍스트** | 쟁점마다 해당 근거 ID의 원문만 싣는다. 전체 근거는 한 줄 색인으로만 | 정확도 향상 + 긴 컨텍스트의 디코드 저하 회피 |
| P8. **결정적 선처리 우선** | 조문 항·호·단서 분해, 판결요지 번호 분해, 참조조문 매칭, 임베딩 유사도, 시점 효력은 코드·`bge-m3`로 | LLM 호출 자체를 없앰 |
| P9. **재사용 캐시** | 조문 버전별 요건 분해, 판례별 명제 분해를 `(원문 해시, promptVersion, model)` 키로 저장 | 반복 검토에서 해당 단계 LLM 0회 |
| P10. **실패 격리** | 단계·쟁점 단위로 성공/부분/실패 표시. 한 쟁점 실패가 다른 쟁점 결과를 버리지 않음 | 규칙 기반 폴백 빈도 감소 |
| P11. **호출 원장** | 모든 호출의 단계·입력/출력 토큰·prefill/디코드 시간·캐시 적중·재시도 기록 | 효율 개선을 측정으로 판단 |
| P12. **모르는 것은 모른다고 구조화** | 로컬 엔진이 답할 수 없는 지점을 억지로 생성하지 않고 요건 단위 공백(`gaps`)으로 남긴다. 법리 공백은 외부 전문가 질의로, 사실 공백은 사용자 확인으로 보낸다 | 소형 모델의 약점을 환각 대신 사람의 답으로 메움 |
| P13. **답이 오면 그 부분만 다시** | 승인 답변은 공백이 난 쟁점·요건에 연결되고, 재검토는 그 쟁점의 S4 이후만 재실행 | 재검토 비용을 쟁점 수에 비례하게 축소 |

---

## 6. 목표 파이프라인

```text
[수집] buildWorkbenchContext (기존, LLM 0)
   ↓
S0 근거 등록부  evidenceRegistry  ─ 결정적: ID 부여, 항·호·단서/판결요지 분해, 색인 생성      LLM 0
   ↓
S1 사건·쟁점    caseIssues        ─ 사실(문서 ID+짧은 인용), 쟁점, 선결관계, 검색어, 후보 근거ID   LLM 1 (think off)
   ↓           └ 코드: 인용문 실재 확인 → 미확인 사실은 INFERRED, 쟁점 ≤ N개, 중복 병합
S2 쟁점별 조사  issueResearch     ─ 검색어 → 기존 multiSearch/reRanker, 반대 쿼리, bge-m3 점수      LLM 0
   ↓           └ 부족하면 쟁점당 추가 조회 1회
S3 요건 구성    elements          ─ 조문 → 요건(캐시), 쟁점에 필요한 요건 ID 선택                  LLM 0~N (think off, 캐시 미스 시)
   ↓
S4 포섭         application       ─ 쟁점마다: 요건별 상태·사실ID·근거ID, 판례 유추/구별, 가장 강한 반론, 쟁점 서술([ID] 표기)   LLM N (think A/B)
   ↓           └ 코드: 결론 계산, 선결쟁점 반영, 유보 판단
S5 종합·조립    synthesis         ─ 결론 집계(코드) + 요약문 1회 + (계약 프리셋) 수정조문 ≤5회        LLM 1~6 (think off)
   ↓           └ 코드: v1 스키마(summary, legalBasis, legalOpinion, risks, redlineDiffs, draftOpinion…) 렌더링
S6 근거 검증    warrant           ─ 존재·시점·관할(기존 검증기) → 임베딩 정렬 → 애매한 쌍만 일괄 함의 판정   LLM 0~1 (think off)
   ↓
S7 공백 산출    gaps              ─ 코드: 요건·반론·검증 결과에서 법리/사실/근거 공백을 분류·우선순위화     LLM 0
   ↓
   ├─ 법리 공백 → [외부 전문가 질의] 질의서 생성 → 비식별 확인 → 반출 → 답변 반입 → 카드 승인
   │                  ↓
   │              재검토(sourceHistoryId): 해당 쟁점만 S3·S4 재실행 → S5·S6 → S7
   └─ 사실 공백 → 사용자 확인 요청(furtherChecks) → 사실 보강 후 같은 방식으로 재검토
```

### 단계별 LLM 계약

| 단계 | 입력(접두부/접미부) | 출력 스키마 요지 | 출력 상한(목표) | think |
|---|---|---|---:|---|
| S1 | 공통 접두부: 질의·프리셋 지침·문서 조항(D#)·근거 색인 / 접미부: 쟁점 추출 과제 | `facts[{id,text,status,docRef,quote≤40자}]`, `issues[{id,question,type,priority,dependsOn[],factIds[],candidateEvidence[],searchTerms[]}]`, `unknownFacts[]` | 600 | off |
| S3 | 조문 원문(A#) / "이 조문의 적용 요건을 나열" | `elements[{id,text,mandatory,isException,sourceIds[]}]`, `burden` | 250/조문 | off |
| S4 | 쟁점 접두부: 공통 사실·쟁점 요지 + 선택 근거 원문 + 요건 목록 / 접미부: 포섭 과제 | `assessments[{elementId,status,proof,factIds[],contraryFactIds[],evidenceIds[],analysis≤200자}]`, `precedents[{id,relation,decisiveFactor}]`, `counter{position,evidenceIds[],response}`, `narrative≤600자([ID] 표기)` | 800/쟁점 | A/B |
| S5 | 쟁점 결론 표(코드 생성) / 요약 과제 | `summary≤400자`, (계약) `redline{clauseId,revisedText,reason,evidenceIds[]}` | 300 / 150·조항 | off |
| S6 | (주장, 인용 구간) 쌍 목록 | `[{claimId,label:SUPPORTS|PARTIAL|NOT_SUPPORTED}]` | 10/쌍 | off |

- `status`: `SATISFIED | NOT_SATISFIED | PARTIALLY_SATISFIED | DISPUTED | UNKNOWN`, `proof`: `SUFFICIENT | INSUFFICIENT | CONFLICTING | NO_EVIDENCE` (보고서 스키마 그대로).
- 모든 `*Ids`는 스키마 `enum`으로 해당 실행의 유효 ID만 허용한다(ID 수가 많으면 enum 대신 코드 검증 + 1회 재시도).

### 코드가 계산하는 결론 규칙 (S4 후처리)

```text
필수 요건 중 NOT_SATISFIED 존재          → 쟁점 결론 NOT_APPLICABLE (요건 불충족)
필수 요건 전부 SATISFIED, 예외요건 SATISFIED → EXCEPTION_APPLIES
필수 요건 전부 SATISFIED                  → APPLIES
그 외(UNKNOWN / DISPUTED / PARTIAL 포함)   → CONDITIONAL + 결정 요건 목록 = furtherChecks
proof ≠ SUFFICIENT 인 결정 요건 존재        → legalAssessment 유지, proofAssessment = INSUFFICIENT
선결쟁점 결론이 CONDITIONAL/UNRESOLVED      → 후속 쟁점 결론은 최대 CONDITIONAL
공식 근거 0건, 입력 예산으로 결정 근거 제외, 반대권위 미대응 → HUMAN_REVIEW_REQUIRED
```

모델의 `narrative`가 계산된 결론과 어긋나면(예: 결론 CONDITIONAL인데 "위법하다" 단정) 경고로 표시하고 결론 표를 우선한다.

### 프롬프트 배치와 실행 순서 (캐시)

```text
system (전 단계 동일, 짧게 고정)
└ 실행 공통 접두부  = 질의 + 프리셋 지침 + 사실 목록(S1 후 확정) + 근거 색인(한 줄/ID)
   ├ S1 접미부 (think off)
   ├ 쟁점 k 접두부 = 쟁점 k 요지 + 선택 근거 원문 + 요건
   │   └ S4 접미부 (think 모드 고정)
   └ S5 접미부 (think off)
```

- think off 단계(S1, S3, S5, S6)와 think on 단계(S4, 채택 시)를 모드별로 몰아서 실행한다.
- 로컬에서는 호출을 직렬화한다. 병렬로 보내면 슬롯 간 캐시가 흩어져 prefill이 반복된다.
- 나중에 클라우드 어댑터를 켜더라도 같은 배치가 제공자 측 프롬프트 캐시(접두부 캐싱)와 맞물린다.

### 호출·시간 예산 (3쟁점 기준 추정)

| 단계 | 호출 | 출력 토큰 | 추정 시간(로컬, 첫 실행) | 반복 실행 |
|---|---:|---:|---|---|
| S1 | 1 | ~600 | prefill 0.3~0.7분 + 디코드 0.6분 | 동일 |
| S3 | 0~4 | ~1,000 | ~1.5분 | 캐시 적중 시 0 |
| S4 | 3 | ~2,400 | prefill 쟁점당 0.3~0.8분 + 디코드 2.4분 | 동일 |
| S5 | 1(+≤5) | ~300(+750) | ~0.5분(+0.8분) | 동일 |
| S6 | 0~1 | ~200 | ~0.3분 | 동일 |
| **합계** | **7~9** | **~4,500** | **약 6~9분** | **약 5~7분** |
| 현행 | 1~2 | 5,000~8,000 + 사고 | 약 7~13분 | 동일 |

추정의 근거는 §4 실측이며, 실제 값은 Phase 0 기준선과 Phase 5 이후 비교로 확정한다. 시간 단축보다 중요한 효과는 **단계별 결과가 순차적으로 화면에 나오고, 한 단계 실패가 전체 폐기로 이어지지 않는 것**이다.

---

## 6-A. 외부 전문가 질의 연동 — 로컬 엔진의 한계를 메우는 경로

### 원칙

- **클라우드 모델을 자동으로 호출하지 않는다.** 외부로 나가는 모든 내용은 사람이 비식별 상태를 확인하고 직접 반출한다(기존 `confirmInquiry` 절차 유지).
- **외부 답변은 추론의 안내이지 근거가 아니다.** 답변 카드(`K#`)는 요건 후보·해석 방향·검토 순서를 제공하고, 결론의 근거는 여전히 공식 자료(`A#`·`P#`·`Q#`…)여야 한다. 공식 근거 없이 카드에만 기댄 결론은 게이트 `HUMAN_REVIEW_REQUIRED`.
- **질문은 공백에서 만든다.** 완성된 검토문을 로컬 모델이 다시 읽고 질문을 추측하는 현재 방식 대신, S7이 요건 단위로 확정한 공백을 질문으로 옮긴다.

### 공백(gap)의 분류 — S7, 코드로 산출

| 유형 | 발생 조건(결정적) | 보내는 곳 |
|---|---|---|
| `LEGAL_INTERPRETATION` | 필수 요건이 `UNKNOWN`인데 근거는 있음(해석이 갈림), 또는 모델이 `analysis`에 해석 불명을 표시 | 외부 질의 |
| `AUTHORITY_CONFLICT` | 같은 요건에 지지·반대 근거가 함께 있고 `counter.response`가 비었거나 `NOT_SUPPORTED` | 외부 질의 |
| `MISSING_AUTHORITY` | 결정 요건의 `evidenceIds`가 비었고 S2 추가 조회 1회로도 못 찾음 | 외부 질의(관련 조문·판례 번호를 요청) |
| `STAGE_FAILURE` | 해당 쟁점 S4가 스키마 재시도 후에도 실패 | 외부 질의(쟁점 전체를 질문으로) |
| `FACT_UNKNOWN` | 요건 판단에 필요한 사실이 `UNKNOWN`/`INFERRED`, 또는 `proof`가 `INSUFFICIENT`·`NO_EVIDENCE` | **사용자** 확인 요청. 외부로 보내지 않음(외부 전문가가 알 수 없는 사실이며 비식별 부담만 큼) |
| `COLLECTION_FAILURE` | 공식 API 실패·본문 미확보(`LIST_ONLY`)·입력 예산으로 제외 | 재수집 또는 사용자 안내 |

우선순위는 "결론을 바꾸는 공백"부터 매긴다: 선결(THRESHOLD)·CRITICAL 쟁점 > 그 요건 하나만 풀리면 결론이 확정되는 공백 > 나머지. 질의서당 질문 상한은 기존 파서 한도(12)를 따른다.

### 질의서 생성 — `createInquiryFromGaps`

```text
검토 이력의 review.reasoning.gaps (법리 공백만)
   ↓ 코드: 공백 → 질문 문장 템플릿
   │   예) [I2.E3] "행정재산 관리위탁 시 수탁자의 제3자 사용이 '별도 사용허가' 대상인지,
   │        공유재산법 제27조 사용허가 의제 조항의 범위와 관련해 판단 기준은?"
   │   질문마다 anchor = { issueId, elementId, gapType } 저장
   ↓ 로컬 LLM 1회 (think off): 관련 사실만 추상화·비식별 + 민감어 후보 (기존 ANALYSIS 과제를 축소)
   ↓ 기존 절차: 사용자 편집 → 개인정보·논리 보존 확인 → 반출
```

- 현재 `createInquiry`의 "필요 여부 판단(needsHelp)·질문 추측"은 S7이 대신하므로 로컬 호출의 과제가 비식별 추상화 하나로 줄어든다. 공백이 없으면 LLM을 호출하지 않고 "질의 불필요"를 돌려준다. 사용자가 직접 추가하는 질문(`focus`)은 기존대로 받는다(anchor 없음).
- 질의서 끝의 응답 요청 JSON을 질문 번호별 구조로 바꿔 **구조화 반입 경로(로컬 LLM 0회)** 를 기본으로 안내한다.

```json
{"answers":[{"questionNo":1,"position":"판단 요지","conditions":["적용 조건"],"exceptions":["예외"],
  "checklist":["확인 순서"],"citations":[{"lawName":"법령명","articleNo":"제27조 제1항"}],
  "cases":["2019두12345"],"confidence":"확실|견해 대립|미확인"}],
 "card":{...기존 카드 스키마...}}
```

- 기존 `validateKnowledgeCard`·`answeredQuestions`·커버리지 계산은 그대로 쓰고, 질문별 `answers[]`는 카드에 `answersByQuestion`으로 보관한다. 자유서술 답변은 기존 청크 증류 경로로 처리한다(로컬 호출 발생).

### 답변의 편입 — 재검토

1. **새 근거 확인:** 답변의 `citations`·`cases` 중 이번 수집 자료에 없는 것은 공식 API(`getLawArticle`, 판례 번호 검색·본문 조회)로 조회해 확인되면 등록부에 추가한다. 확인되지 않으면 기존대로 `UNVERIFIED`이고 그 카드는 재사용 제외(현행 규칙 유지).
2. **요건 연결:** 카드는 anchor가 가리키는 쟁점의 접두부에 `K#`로 실린다. `conditions`·`exceptions`는 S3의 요건 후보로 제시되며, 채택되려면 `sourceIds`에 공식 조문 ID가 있어야 한다.
3. **부분 재실행:** `sourceHistoryId` 재검토에서 공식 근거 스냅샷(`evidenceHash`)이 같으면 S1·S2 결과를 이력에서 재사용하고, 카드가 연결된 쟁점과 그 후속 쟁점(`dependsOn`)만 S3·S4를 다시 돌린다. 스냅샷이 다르면 전체 재실행(현행 `EVIDENCE_CHANGED` 규칙과 같은 기준).
4. **공백 해소 판정:** 재검토 후 해당 요건이 `UNKNOWN`을 벗어나고 인용이 S6를 통과하면 공백을 `RESOLVED`로, 여전히 남으면 `STILL_OPEN`으로 표시하고 다음 질의 후보로 남긴다. 질문별 커버리지(`inquiryCoverage`)와 공백 해소는 별개로 보여 준다 — 답을 받았다는 것과 판단이 확정됐다는 것은 다르다.

### 사건 밖 재사용 — 조직 지식층

- 새 사건의 S7이 공백을 만들면, 먼저 승인 카드 저장소를 검색한다: 범위 조건(프리셋·기준 법령·기준일·공식 근거 일치·90일·인용 확인)은 현행 규칙 그대로, 관련도 판정만 쟁점어 2개 일치에서 **`bge-m3` 유사도(카드 `issue` ↔ 공백 질문) + 인용 조문 겹침**으로 바꾼다.
- 적용 가능한 카드가 있으면 그 공백은 `COVERED_BY_KNOWLEDGE`로 표시하고 질의서에서 제외, 해당 쟁점 S4에 카드를 실어 재실행한다. 사용자는 "기존 지식으로 해결된 공백"을 따로 확인할 수 있다.
- 효과 지표: 사건당 외부 질의 질문 수, 기존 지식으로 해소된 공백 비율의 추이(§9).

### 클라우드 연결 가능성의 보존

- `llmGateway`는 OpenAI·Anthropic·Gemini 어댑터를 유지하되 역할 라우팅 설정 `REVIEW_MODEL_ROUTE`의 기본값을 모든 역할 `local`로 둔다. 클라우드 역할 지정은 설정만으로 가능하나 이 계획의 기본 흐름·테스트·평가 대상이 아니다(어댑터 계약 테스트만 유지).
- 외부 답변이 결국 대형 AI에서 올 수 있다는 점은 동일하므로, 반입 답변의 신뢰 수준은 출처 라벨과 무관하게 `NOT_CERTIFIED`로 둔다(현행 유지).

---

## 7. 중간표현(IR) — 검토 결과에 추가되는 `reasoning` 필드

DB 테이블 대신 검토 이력 JSON에 저장한다. 기존 v1 필드는 이 IR에서 렌더링해 UI·내보내기·이력 호환을 유지한다.

```js
review.reasoning = {
  version: 1, promptVersion: 'r1', asOfDate,
  evidence: [{ id: 'A3.2', kind: 'ARTICLE', lawName, articleNo, paragraph, item, enforceDate, official: true, textHash }],
  facts:    [{ id: 'F1', text, status: 'CONFIRMED|ALLEGED|DISPUTED|UNKNOWN|INFERRED', docRef: 'D7', quote, quoteVerified }],
  issues:   [{ id: 'I1', question, type, priority, dependsOn: [], factIds: [], evidenceIds: [], adverseEvidenceIds: [],
               elements: [{ id: 'I1.E1', text, mandatory, isException, sourceIds: [] }],
               assessments: [{ elementId, status, proof, factIds, contraryFactIds, evidenceIds, analysis }],
               precedents: [{ id: 'P2', relation: 'ANALOGOUS|DISTINGUISH|NOT_RELEVANT', decisiveFactor }],
               counter: { position, evidenceIds, response },
               conclusion: { legal: 'APPLIES|NOT_APPLICABLE|EXCEPTION_APPLIES|CONDITIONAL', proof, decidingElementIds, derivedBy: 'RULES' },
               narrative, stageStatus: 'OK|PARTIAL|FAILED' }],
  warrants: [{ claimId, text, evidenceIds, checks: { existence, temporal, jurisdiction, alignment, entailment }, overall }],
  gaps:     [{ id: 'G1', issueId, elementId, type: 'LEGAL_INTERPRETATION|AUTHORITY_CONFLICT|MISSING_AUTHORITY|STAGE_FAILURE|FACT_UNKNOWN|COLLECTION_FAILURE',
               route: 'EXTERNAL_INQUIRY|USER|RECOLLECT', priority, changesOutcome: true, question,
               state: 'OPEN|COVERED_BY_KNOWLEDGE|ASKED|RESOLVED|STILL_OPEN', inquiryId, questionNo, knowledgeIds: [] }],
  reuse:    { fromHistoryId, evidenceHashMatched, rerunIssueIds: [], reusedStages: ['S1', 'S2'] },
  gate: 'OK|HUMAN_REVIEW_REQUIRED|BLOCKED', gateReasons: [],
  ledger: [{ stage, issueId, model, think, inputTokens, prefillMs, cachedPrefix, outputTokens, decodeMs, retries, ok }]
};
```

v1 필드 매핑: `coreIssues` ← `issues[].question`, `legalBasis` ← 인용된 `evidence` ID(검증 상태 포함), `legalOpinion` ← 쟁점 `narrative`의 [ID]를 정식 인용으로 치환, `risks` ← NOT_APPLICABLE/CONDITIONAL 쟁점, `furtherChecks` ← `route: USER` 공백 + `unknownFacts`, `opposingViews`/`auditConclusion` ← (사전 컨설팅감사) 견해별 쟁점과 결론 표, `draftOpinion` ← 템플릿, `disclaimer` ← 상수.

---

## 8. 단계별 구현 계획

모든 단계는 `REVIEW_PIPELINE=staged|monolithic`(기본 `monolithic`) 플래그 뒤에서 진행하고, 전환은 Phase 7의 비교 평가로 결정한다. 신규 코드는 `server/reasoning/`에 둔다.

### Phase 0. 측정 기반 — LLM 게이트웨이와 호출 원장

- `server/reasoning/llmGateway.js`: `lawWorkbenchReview.js`의 `callOllama/OpenAi/Anthropic/Gemini`와 스트림 유틸을 이동하고 `complete({ stage, system, prefix, task, schema, think, maxOutput, onToken })` 하나로 노출. 기존 함수는 게이트웨이를 호출하도록 바꿔 동작을 보존.
  - Ollama: `format`에 JSON Schema, `think` 전달, `num_ctx`는 실행 내 고정, `/api/tags` 확인은 실행당 1회.
  - OpenAI/Gemini/Anthropic 어댑터는 연결 가능성 보존용으로 유지(스키마 옵션 포함). 역할 라우팅 `REVIEW_MODEL_ROUTE` 기본값은 전 역할 `local`이며, 학습 경로처럼 외부 전송이 금지된 호출은 게이트웨이가 로컬 외 라우팅을 거부.
  - 스키마 검증 실패 시 "무엇이 틀렸는지"를 접미부에 붙여 1회 재시도.
- `manualLearningLocal.callLearningLocal`도 게이트웨이의 `local` 전용 경로를 쓰도록 맞춘다(localhost·리다이렉트 금지 등 현행 안전장치는 게이트웨이 옵션으로 이전). 검토와 학습 호출이 같은 `num_ctx`를 쓰면 모델 재적재도 피한다.
- `server/reasoning/runLedger.js`: 호출별 원장(§7 `ledger`). Ollama 응답의 `prompt_eval_count/duration`, `eval_count/duration`으로 캐시 적중을 판정(prefill ms/토큰 급감).
- 기준선: 현행 monolithic을 `test/docs/review-samples` 6건 + 벤치마크 20건 중 10건에 실행해 시간·입출력 토큰·파싱 실패·폴백·인용 존재율을 `docs/audit/pipeline-baseline-<date>.json`에 기록.
- 완료 기준: 기존 테스트 전부 통과, 원장이 검토 결과에 포함, 기준선 파일 생성.

### Phase 1. 근거 등록부(S0) — LLM 0회

- `server/reasoning/evidenceRegistry.js`
  - 조문을 항·호 단위 ID로(`A3`, `A3.2`, `A3.2.1`), 단서는 `…x`(예외) 표식. [reviewContext.js:151-189](../server/law/reviewContext.js)의 원칙/단서 분해 로직을 옮겨 재사용.
  - 판례는 `판시사항`·`판결요지`를 `[1]`·`[2]` 번호 단위 명제로 분해(`P2.y1`), `참조조문`(`referencedArticles`)을 파싱해 조문 ID와 연결.
  - 해석례(`I#`는 쟁점과 충돌하므로 `Q#`), 조례(`O#`), 행정규칙(`R#`), 문서 조항(`D#`), 학습 지식(`K#`, 비공식 표식) 등록.
  - `renderIndex()`(한 줄/ID), `renderFull(ids, budget)`, `resolve(ids)`(미등록 ID 거부).
- quick win: 현행 monolithic 프롬프트의 `legalBasis`를 ID 반환으로 바꾸는 옵션 — 인용 존재 검증이 결정적으로 바뀐다.
- 완료 기준: 단위 테스트(가지조문·항·호·단서·판결요지 번호·참조조문 매칭·비공식 근거 표식), 색인 크기 측정.

### Phase 2. 사건·쟁점(S1) — LLM 1회

- `server/reasoning/stages/caseIssues.js` + `schemas.js`.
- 후처리(코드): `quote`가 해당 `D#` 원문에 정규화 일치하는지 확인 → 불일치 사실은 `INFERRED`로 강등, 결론 근거로 사용 금지. 쟁점 상한 `REVIEW_MAX_ISSUES`(기본 5), `bge-m3` 코사인으로 중복 쟁점 병합, `dependsOn` 순환 제거.
- 사전 컨설팅감사: 갑설/을설을 쟁점의 대립 견해로 받고, 기존 [조문 특정 1단계](../server/law/lawWorkbenchReview.js)는 "근거 색인에서 견해별 근거 ID 선택"으로 흡수(닫힌 질문).
- 완료 기준: 스키마 파싱 성공 ≥ 98%(샘플 6건 × 3회), gold 쟁점 재현율 측정 가능, 인용문 실재 확인 테스트.

### Phase 3. 쟁점별 조사(S2) — LLM 0회

- `server/reasoning/stages/issueResearch.js`: 쟁점 `searchTerms` → 기존 `multiSearch`/`searchPrecedents`/`searchInterpretations`/`runTool` 재사용. 전체 조회 예산(쟁점당 API 호출 상한)과 기존 캐시 사용.
- 반대 분기(코드 생성 쿼리): 쟁점 조문 + 예외·단서 문구, 반대 처분어(취소·무효·위법·기각 등), 같은 참조조문을 가진 판례 중 결론 방향이 다른 것. 입장 판정은 S4에서 모델이 `relation`/`counter`로.
- `server/reasoning/embeddings.js`: `bge-m3`(Ollama `/api/embed`)로 쟁점 질문 ↔ 판결요지 명제·문서 조항 유사도. `reRanker` 결과에 **특징을 분리 저장**(문자 일치, 조문/참조조문 일치, 법원, 의미 유사도, 시점 효력) — 보고서의 "87점 하나로 덮지 않기".
- 문서 조항 선택도 쟁점별로 `contextOptimizer` 점수 + 임베딩 점수 결합(contextRecall의 `no-marker-middle-control` 실패 대응).
- 완료 기준: 벤치마크 법령·조문·판례 재현율이 기준선 대비 하락 없음, `contextRecall` 대조군 회수 개선 여부 기록.

### Phase 4. 요건 구성(S3) — 캐시 우선

- `server/reasoning/stages/elements.js`: 조문 단위(쟁점 무관)로 요건 분해 → SQLite `reasoning_cache`(키: 조문 `textHash` + `promptVersion` + 모델). 기존 `lawCache` DB와 같은 파일, 별도 테이블.
- 쟁점에 필요한 요건은 쟁점 `evidenceIds`에 연결된 조문의 요건 합집합에서 코드가 고르고, 선택이 애매할 때만 S4 접미부에 후보로 제시.
- 완료 기준: gold 요건 재현율 측정, 재실행 시 S3 LLM 호출 0회(원장으로 확인).

### Phase 5. 포섭(S4) — 쟁점당 LLM 1회, 핵심 추론 단계

- `server/reasoning/stages/application.js`: §6 스키마. 쟁점 접두부에는 그 쟁점의 근거 원문만(`renderFull`), 다른 쟁점은 한 줄 요지.
- `server/reasoning/verify/conclusion.js`: §6 결론 규칙, 선결쟁점 반영, 유보 게이트.
- think A/B: (a) `think:true` (b) `think:false` + `reasoning≤200자` 필드. 샘플 6건 × 3회로 요건 상태 정확도·출력 토큰·시간 비교 후 기본값 결정(`REVIEW_THINK_STAGES`).
- 실패 격리: 스키마 재시도 후에도 실패하면 해당 쟁점만 `stageStatus:FAILED`·결론 `CONDITIONAL`, 다른 쟁점은 계속.
- 완료 기준: 결론-요건 정합 100%(구조적), 미등록 ID 0건, 보고서 부정 테스트 중 "선행 쟁점 UNKNOWN → 확정 결론 금지", "법리상 적용 가능·증거 부족 분리", "유사하지만 결정적 요소가 다른 판례 → DISTINGUISH" 픽스처 통과.

### Phase 6. 종합·조립·검증(S5, S6)

- `server/reasoning/stages/synthesis.js`: 쟁점 결론 표(코드) → 요약 1회. 계약·조례 프리셋은 `NOT_APPLICABLE` 요건과 연결된 문서 조항(`D#`)만 수정조문 생성(조항당 1회, 최대 5). `originalText`는 모델이 쓰지 않고 `D#` 원문에서 코드가 채움 — 기존 `sourceVerified` 검사가 항상 성립.
- `server/reasoning/render.js`: §7 매핑으로 v1 필드 생성. `draftOpinion`은 템플릿. 기존 `exportFiles`·`reportSafety` 경고 보존 경로 그대로 사용.
- `server/reasoning/verify/warrant.js`
  1. 존재·시점·관할: 등록부 ID의 공식 여부·`asOfDate` 효력·관할(조례 지자체) — 결정적.
  2. 정렬: 주장 문장 ↔ 인용 ID 원문의 임베딩 유사도 + 핵심어 겹침. 임계 이상은 `ALIGNED`.
  3. 함의: 임계 미만 쌍만 모아 1회 일괄 판정(think off, 쌍당 ~10토큰).
  4. 본문 속 [ID] 없는 법적 단정 문장 → `UNSUPPORTED` 집계.
  - 기존 `verifyAndCorrectReviewCitations`는 v1 `legalBasis`에 계속 적용(이중 안전망).
- `lawWorkbenchReview.js`: 플래그가 `staged`면 `runReasoningPipeline()`로 위임, 진행 이벤트는 기존 `progress` 키 체계에 `s1`·`s4:I1` 등으로 추가(`reviewTrace.js`가 그대로 표시).
- 완료 기준: 보고서 부정 테스트 표 10종 중 코퍼스 조작이 필요 없는 항목 전부 픽스처로 통과(가짜 판례 ID → 스키마 거부, 명제 불일치 판례 → `NOT_SUPPORTED`, 원문에 없는 사실 → `INFERRED`, 시행 전 조문 → temporal FAIL, 두 권위 충돌 → 둘 다 표시).

### Phase 7. 비교 평가와 전환 결정

- `test/benchmark-v2/`: 기준선과 동일 샘플로 staged 실행. 지표는 §9.
- 전환 조건(초기안): 인용 존재율·법령/조문 재현율 하락 없음, 폴백률 감소, 미등록 인용 0, 총 시간 기준선 +20% 이내. 충족 시 기본값을 `staged`로.
- 판정 결과를 `docs/audit/pipeline-comparison-<date>.md`에 기록.

### Phase 8. 공백 산출과 외부 전문가 질의 연동 (필수)

§6-A의 구현. 로컬 엔진의 한계를 메우는 유일한 상위 경로이므로 선택이 아니라 필수 단계다.

- 8-1 **공백 산출(S7)** `server/reasoning/stages/gaps.js`: §6-A 분류표를 코드로 구현. 결정적 재조사 트리거(`MISSING_AUTHORITY` 후보는 요건 문구로 S2 1회 추가 조회 → 해당 쟁점 S4만 재실행, 쟁점당 1회, 실행 마감 `REVIEW_DEADLINE_MS`)를 먼저 거친 뒤 남는 공백만 확정. 결과를 `review.reasoning.gaps`에 저장하고 v1 `furtherChecks`에 사용자 공백을 반영.
- 8-2 **공백 기반 질의서** `manualLearning.js`에 `createInquiryFromGaps` 추가: 공백 → 질문 템플릿(anchor 포함) → 로컬 1회 비식별 추상화. 이력에 `reasoning`이 없는 과거 검토는 기존 `createInquiry`로 처리(호환). 질의서 끝 JSON 요청을 질문별 `answers[]` 구조로 확장.
- 8-3 **반입 확장**: `parseStructuredCard`가 `answers[]`를 읽어 `answersByQuestion`과 `answeredQuestions`를 채움(로컬 LLM 0회). 자유서술은 기존 청크 증류. `checkLearningCases`의 미확인 판례번호·조문은 공식 API로 조회해 확인 시 `VERIFIED_EXISTENCE`로 승격하고 다음 재검토의 등록부 편입 목록에 기록.
- 8-4 **부분 재검토**: `/workbench`에 `sourceHistoryId`가 오면 이력의 `reasoning`과 `evidenceHash`를 비교해 S1·S2 재사용 여부를 결정하고, anchor가 가리키는 쟁점과 후속 쟁점만 S3·S4 재실행. `reasoning.reuse`에 재사용 범위 기록, 진행 이벤트에 "재실행 쟁점 N개 / 재사용 단계" 표시.
- 8-5 **사건 밖 재사용**: `findLearningKnowledge`의 관련도 판정을 `bge-m3` 유사도 + 인용 조문 겹침으로 교체(범위·만료·인용 확인 조건은 그대로). 공백과 매칭된 카드는 `COVERED_BY_KNOWLEDGE`.
- 8-6 **학습 탭 UI**: 질의서의 질문 옆에 연결 쟁점·요건과 공백 유형 표시, 재검토 후 공백 상태(`RESOLVED`/`STILL_OPEN`)를 질문별 커버리지와 나란히 표시. 검토 화면의 공백 목록에서 "외부 질의 만들기"로 바로 진입.
- 완료 기준
  - 픽스처: `UNKNOWN` 요건 → 법리 공백 → 질의서 질문 anchor 일치, 사실 공백은 질의서에 들어가지 않음, 공백 없으면 로컬 호출 0회.
  - 구조화 JSON 반입 시 로컬 호출 0회, 질문별 연결 정확.
  - 부분 재검토: 스냅샷 동일 시 재실행 쟁점만 S4 호출(원장으로 확인), 스냅샷 변경 시 전체 재실행.
  - 공식 근거 없이 카드에만 기댄 결론은 `HUMAN_REVIEW_REQUIRED`.
  - 기존 `manualLearning*.test.js` 전부 통과(과거 이력 호환).

### Phase 9. UI (선택)

- 워크벤치에 "쟁점·요건" 탭: 쟁점별 요건 매트릭스(상태·사실·근거·증명), 판례 유추/구별, 반론, 결론 도출 근거, 근거 검증 원장, 공백 목록(외부 질의·사용자 확인 구분). 기존 `reviewTrace.js`에 호출 원장(단계별 시간·토큰·캐시) 표시.

---

## 9. 평가 체계

| 구분 | 지표 | 측정 | 비고 |
|---|---|---|---|
| 안전(하드 게이트) | 미등록·허위 인용 | 원장 + 등록부 | **0건** |
| 안전 | 인용 존재율, 시점 정확도 | 기존 검증기 | 기준선 이상 |
| 안전 | 근거 없는 법적 단정 비율 | warrant `UNSUPPORTED` | 추이 관리 |
| 추론 | 쟁점 재현율(선결쟁점 별도) | gold 대조(수기 판정) | 샘플 6건 + 벤치 10건부터 |
| 추론 | 요건 재현율, 예외 재현율 | gold 요건 | |
| 추론 | 요건 상태 정확도 | gold 매트릭스 | think A/B 판단 기준 |
| 추론 | 결론-요건 정합, 선결 정합 | 코드 검사 | 구조적 100% |
| 추론 | 유보 정밀도/재현율 | gold 유보 조건 | |
| 효율 | 총 시간, 입력/출력 토큰, 호출 수, 캐시 적중률, 재시도율, 폴백률 | 원장 | 기준선 대비 |
| 외부 질의 | 공백 분류 정확도(법리/사실 구분) | gold 공백 라벨 | 사실 공백이 질의서로 새지 않아야 함 |
| 외부 질의 | 공백 해소율 = 재검토 후 `RESOLVED` / 질의한 공백 | `gaps` | 답변 수(커버리지)와 별도 |
| 외부 질의 | 사건당 질의 질문 수, 기존 지식으로 해소된 공백 비율 | `gaps.state` | 시간에 따라 질문 수 감소, 해소 비율 증가가 목표 |
| 외부 질의 | 부분 재검토 비용 | 원장(재실행 쟁점 수·시간) | 전체 재검토 대비 |
| 외부 질의 | 카드 의존 결론 비율 | 게이트 사유 | 공식 근거 없이 카드만으로 확정된 결론 0건 |

- gold 작성 범위는 작게 시작한다: 샘플 6건 각각 `goldIssues`, `goldElements`, `goldAuthorities{supporting,adverse}`, `expectedConclusions`, `abstentionTriggers`. 보고서의 500건 규모 Gold Set과 변호사 2인 판정은 제품화 단계 과제로 남긴다.
- 생성 변동성 때문에 비교는 동일 샘플 3회 반복의 분포로 본다. LLM 판정(judge)은 선별용으로만 쓰고 gold 판정을 대신하지 않는다.

---

## 10. 위험과 대응

| 위험 | 대응 |
|---|---|
| 호출 수 증가로 총 시간이 오히려 늘어남 | Phase 0 기준선 + Phase 7 비교 조건(+20% 이내). S3 캐시, think off 기본, 접두부 재사용으로 상쇄 |
| S1에서 쟁점을 놓치면 이후 전부 누락 | 쟁점 재현율을 첫 지표로 측정. 프리셋별 필수 쟁점 체크리스트(`lawTermKb` 확장)로 코드 보강. 사용자가 쟁점을 추가·삭제하고 S2부터 재실행하는 경로(Phase 9) |
| 스키마 강제가 소형 모델의 내용 품질을 떨어뜨림 | think/reasoning 필드 A/B. 긴 서술은 `narrative` 한 필드로 제한해 자유도 확보 |
| enum 스키마가 커져 문법 제약 비용 증가 | ID 수 임계 초과 시 enum 대신 코드 검증 + 재시도 |
| 임베딩 유사도를 법적 유사성으로 오인 | 유사도는 후보 선별·정렬 특징일 뿐, 유추/구별 판정은 S4의 결정적 사실 비교로만 |
| 캐시된 요건 분해가 개정 후 재사용 | 키에 조문 원문 해시·시행일 포함. 원문이 바뀌면 자동 미스 |
| KV 캐시 가정이 모델·Ollama 버전에 따라 다름 | 원장에서 캐시 적중을 계측. 적중이 없으면 쟁점 접두부 축소로 전환 |
| 기존 UI·내보내기 회귀 | v1 필드 렌더링 유지, 플래그 기본값 monolithic, 기존 테스트 전부 유지 |
| 함의 검증 특허와의 근접성 | 상용화 전 청구항 기준 검토 과제로 기록 |
| 외부 질의가 반출 경로가 되어 사건 정보 유출 | 사실 공백은 외부로 보내지 않음. 질문은 공백 템플릿 + 비식별 추상화, 기존 사람 확인·`assertNoDetectedIdentifiers` 절차 유지 |
| 외부 답변의 환각이 검토에 유입 | 카드는 `K#` 비공식 근거. 요건 채택에 공식 조문 ID 필수, 새 판례·조문은 공식 API 확인 후에만 편입, 카드 단독 결론은 게이트 |
| 외부 답변 대기로 검토가 끝나지 않음 | 1차 검토는 공백을 `CONDITIONAL`로 표시하고 완료. 답변은 비동기로 반입해 부분 재검토 |
| 공백 과다 산출로 질의서가 비대 | 결론을 바꾸는 공백 우선, 질문 상한 12, 기존 지식으로 해소된 공백 제외 |
| 과거 지식 재사용 오판 | 현행 범위·스냅샷·만료·인용 확인 조건을 완화하지 않고, 관련도 판정만 임베딩으로 교체 |

---

## 11. 남은 판단 사항

1. S4의 think 기본값 — Phase 5 A/B 결과로 결정.
2. ~~클라우드 승급 허용 여부~~ — **결정(2026-09-23): 클라우드 모델은 사용하지 않고 연결 가능성만 유지한다. 고난도 쟁점은 외부 전문가 질의로 해결한다.** 이후 클라우드를 켤 경우 `.env`의 `ANTHROPIC_MODEL=claude-3-5-sonnet-latest` 등 구형 모델명 갱신이 선행되어야 한다.
3. gold 작성 주체 — 초기 16건은 개발자 수기로 가능하지만 요건·결론 정답은 법률 전문가 확인이 바람직. 공백 분류(법리/사실) 라벨도 함께 작성.
4. `REVIEW_MAX_ISSUES` 기본값(5) — 시간 예산과 쟁점 재현율의 교환 관계를 Phase 7에서 조정.
5. ~~외부 전문가의 범위~~ — **결정·구현(2026-09-23): 반입 시 답변 주체를 `EXTERNAL_AI` / `HUMAN_EXPERT`로 구분한다.** 카드에 `sourceType`·`provenance`(`USER_IMPORTED_HUMAN_EXPERT`)·출처 문구를 저장하고, 검토 프롬프트(`answerSource`)·제한사항 문구·학습 탭 배지에 드러낸다. 승인 전에는 주체를 바꿀 수 있다. 신뢰 수준 차등은 두지 않는다 — 인용 확인·근거 스냅샷·만료·`NOT_CERTIFIED` 규칙이 두 주체에 똑같이 적용된다. 기존 카드(`sourceType` 없음)는 `EXTERNAL_AI`로 본다.

---

## 12. 구현 현황 (2026-09-23)

기본값은 기존 단일 호출 검토(`REVIEW_PIPELINE` 미설정)다. 단계형은 `.env`에 `REVIEW_PIPELINE=staged`를 넣어 켠다. 쟁점 정리(S1)에 실패하면 자동으로 단일 호출 검토로 넘어간다.

| 단계 | 상태 | 파일 | 비고 |
|---|---|---|---|
| Phase 0 게이트웨이·호출 원장 | 완료 | `server/reasoning/llmGateway.js` | 모든 검토 결과에 `llmLedger`(단계·입출력 토큰·prefill/디코드 시간·접두부 캐시 추정). JSON Schema `format`, `think` 지원 |
| Phase 0 기준선 | 측정 중 | `test/benchmark/pipelineBaseline.js`, `docs/audit/pipeline-baseline-2026-09-23.json` | 아래 "기준선에서 드러난 결함" 참조 |
| Phase 1 근거 등록부 | 완료 | `server/reasoning/evidenceRegistry.js` | 항·호·단서·판결요지 번호·참조조문 연결 |
| Phase 2 S1 사건·쟁점 | 완료 | `stages/caseIssues.js` | 인용문 실재 확인·ID 거부·중복 병합·순환 제거 |
| Phase 3 S2 쟁점별 조사 | 완료 | `stages/issueResearch.js`, `embeddings.js` | `bge-m3` 사용, 불가 시 문자열 특징만 |
| Phase 4 S3 요건 분해 | 완료 | `stages/elements.js`, `stageCache.js` | `data/cache/reasoning_cache.db`에 조문 해시 단위 저장 |
| Phase 5 S4 포섭·결론 규칙 | 완료 | `stages/application.js`, `verify/conclusion.js` | 기본 think off + `reasoning` 필드. think A/B는 실측 후 결정 |
| Phase 6 S5·S6·조립 | 완료 | `stages/synthesis.js`, `verify/warrant.js`, `pipeline.js` | v1 필드 렌더링, 인용 검증기 이중 적용 |
| Phase 7 비교 평가 | 대기 | — | 기준선 완료 후 `BASELINE_PIPELINE=staged`로 같은 사례 측정 |
| Phase 8-1 공백 산출 | 완료 | `stages/gaps.js` | |
| Phase 8-2 공백 기반 질의서 | 완료 | `manualLearning.js` `createInquiryFromGaps` | 단계형 검토 이력이면 자동 적용. 이전 이력은 기존 방식 |
| Phase 8-3 질문별 답변 반입 | 완료 | `normalizeAnswers`, `parseStructuredCard` | 새 판례·조문의 공식 API 확인은 **보류**(아래) |
| Phase 8-4 부분 재검토 | 완료 | `pipeline.js`, `knowledgeAnchors` | 공식 근거 지문이 같을 때만 S1·S2 재사용 |
| Phase 8-5 임베딩 관련도 | **보류** | — | `findLearningKnowledge`가 동기 함수라 호출부 변경 필요 |
| Phase 8-6 학습 탭 공백 표시 | 완료 | `public/js/learningTab.js` | 질문별 연결 쟁점·요건·공백 유형 |
| HUMAN_EXPERT 출처 | 완료 | `manualLearning.js`, `learningTab.js` | 신뢰 차등 없음 |
| Phase 9 쟁점·요건 탭 | 미착수 | — | |

### 계획과 달라진 점

- **판례는 명제 단위가 아니라 통째로 싣는다.** 가장 가까운 판결요지 명제만 실으면 같은 판례 안의 반대 명제(예외·제한)가 빠져 반대 근거 탐색의 취지가 무너진다. 판결요지는 짧아 입력 부담이 작다.
- **LLM 호출에 전용 undici dispatcher를 쓴다(`undici` 의존성 추가).** 기준선 사례 03에서 기존 단일 호출 검토가 CPU prefill 300초를 넘겨 Node fetch의 헤더 타임아웃(`UND_ERR_HEADERS_TIMEOUT`)으로 실패하고 규칙 기반 폴백으로 떨어졌다. 스트리밍이어도 Ollama는 prefill이 끝나야 헤더를 보낸다. 헤더·본문 타임아웃을 `LLM_TIMEOUT`에 맞췄다.
- **원칙·단서 인용 병합.** `legalBasis`에서 같은 조·항의 원칙과 단서를 한 항목으로 합치고 `includesProviso`로 표시한다.

### 기준선에서 드러난 결함 (단일 호출 검토)

| 사례 | 결과 | 원인 |
|---|---|---|
| 01 취업규칙 HWPX | 737초 (prefill 250초 + 디코드 486초, 출력 4,046토큰, 8.3 tok/s) | 정상 완료, 부분 결과 |
| 02 용역계약 DOCX | 파싱 실패 | 샘플 README의 기존 이슈(mammoth ↔ `@xmldom/xmldom` 0.9 overrides 충돌) |
| 03 영업정지 PDF | 304초 뒤 규칙 기반 폴백 | 위 헤더 타임아웃. dispatcher 수정으로 해결(기준선 프로세스는 수정 전 코드로 측정) |

### 보류 항목과 이유

- **외부 답변이 제시한 새 판례·조문의 공식 API 확인·편입(8-3b):** 확인 자체는 가능하지만, 편입하면 재검토의 공식 근거 스냅샷이 달라져 기존 규칙(`EVIDENCE_CHANGED`)에 따라 그 카드가 제외된다. 사건 내 재검토에서 스냅샷 규칙을 "상위 집합 허용"으로 완화할지 결정이 필요하다.
- **임베딩 기반 사건 밖 지식 재사용(8-5):** 위 표 참조.
- ~~단계형 검토의 수정 조문(redline) 생성~~ **구현함:** S5가 HIGH·MEDIUM 위험으로 정리한 쟁점에 연결된 첨부문서 조항만 조항당 1회(최대 5개) 생성한다. 결론의 방향(요건 충족이 위반인지 적법인지)은 질문 문장에 따라 달라 코드로 판정할 수 없으므로, 위험 판단은 S5 요약 단계에 맡겼다. 원문은 문서에서 그대로 가져온다(사전 컨설팅감사 제외).
