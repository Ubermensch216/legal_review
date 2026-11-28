# 법령 분석 스킬 (skills.md)

기준일: 2026-11-28 · 상태: **구현 완료 · 스킬 내용은 법률 전문가 검수 전** (`expertReviewed: null`)
구현 계획과 측정 결과: [docs/skills-implementation-plan-2026-11-28.md](../docs/skills-implementation-plan-2026-11-28.md)

이 문서는 Legal Reviewer의 단계형 파이프라인(S0~S7)에 붙는 **법령 분석 스킬**의 색인과 작성 규칙이다.
각 스킬의 실제 내용은 `skills/<id>/` 디렉터리(SKILL.md와 JSON 데이터)에 있고, 서버가 시작할 때 `server/skills/skillLoader.js`가 읽어 검증한다.

## 0. 현재 카탈로그

| ID | 이름 | 종류 | 상태 | 점검 | 쟁점 서식 | 요건 트리 | 조문 지문 | 비고 |
|---|---|---|---|---:|---:|---:|---:|---|
| `labor-work-rules` | 취업규칙·근로조건 검토 | domain | shadow | 13 | 9 | 3 | 16/16 | 기준 스킬(D1), 사례 01·06으로 측정 |
| `contract-services` | 용역·도급 계약 리스크 | domain | **active** (이관) | — | — | — | — | 기존 `contractReview.js`·`verifiedRules.js` 규칙을 동작 그대로 `contract.json`으로 옮김 |
| `privacy-processing` | 개인정보 처리현황 점검 | domain | shadow | 9 (행 단위) | 9 | 0 | 11/11 | 사례 04 |
| `admin-disposition` | 행정처분 절차·실체 검토 | domain | shadow | 5 | 5 | 0 | 6/6 | 사례 03 |
| `ordinance-delegation` | 조례·상위법 위임 한계 검토 | domain | shadow | 3 | 2 | 0 | 3/3 | 지방자치법 2021년 전부개정 기준 |
| `pre-consulting-audit` | 사전컨설팅 견해 비교 | domain | shadow | 0 | 0 | 0 | — | S1·S7 지침만 |
| `method-issue-framing` | 쟁점 구성 방법 | method | shadow | 0 | 0 | 0 | — | 막연한 선결 쟁점 금지 문구 |

- `shadow`: 기본 방식(`auto`)에서는 결과에 반영하지 않고, 문서 점검이 찾은 문장만 `review.reasoning.skills.shadowFindings`에 진단으로 남긴다. 설정의 **분석 스킬 → 검수 전 스킬도 적용**(`skillMode: apply`, 환경변수 `REVIEW_SKILLS=apply`)을 고르면 반영한다.
- `active`: 전문가 검수 기록(`expertReviewed`)이 있거나 기존 코드 규칙을 동작 그대로 옮긴 스킬(`origin: migrated`)만 될 수 있다. 검수 기록 없이 `status: active`라고 적으면 적재기가 `shadow`로 낮춘다.
- 조문 지문은 `node scripts/skillSnapshot.js`로 국가법령정보센터 공식 본문에서 기록한다. 실행 시 본문 해시가 다르면 그 조문의 점검과 요건 트리를 끄고 경고한다.

---

## 1. 왜 스킬인가

현재 파이프라인은 **분석 방법**(쟁점 → 요건 분해 → 포섭 → 근거 검증 → 결론 계산 → 공백 분류)을 이미 코드로 갖고 있다.
측정에서 드러난 약점은 방법이 아니라 **도메인 지식**과 **로컬 모델이 답할 수 있는 질문 형태**에 있다.

| 측정된 약점 (사례 01, `docs/audit/analysis-depth-verification-2026-11-23.md`) | 원인 | 스킬이 메우는 방식 |
|---|---|---|
| 기대 조문 재현율 44~56% (제20·54·60조 등 누락) | 기준 법령 1개와 정적 키워드 사전(`lawTermKb.js`)으로만 조문을 모은다 | 도메인 핵심 조문 목록을 **검색 씨앗**으로 수집 단계에 넣는다 |
| 로컬 모델의 문서 인용 위반 지적 0/37 | 열린 판단("문서가 규정을 지키는가 + 원문 인용")이 5B 모델에게 너무 어렵다 | 코드가 문서에서 해당 문장을 먼저 찾고, 모델에게는 **예/아니오 닫힌 질문**만 묻는다 |
| 막연한 선결 쟁점("개별 조항 내용이 확인되는가"), 경업금지·위약벌 누락(로컬·외부 모두) | S1 지시문의 검토 유형별 방향이 한 줄(`PRESET_FOCUS`)뿐이다 | 도메인 **쟁점 점검표**와 금지 쟁점 형태를 S1에 싣고, 빠진 쟁점은 코드가 보충한다 |
| 심화분석 약 1시간, 모델 시간의 75%가 S4 출력 생성 | 요건마다 서술형 출력을 만든다 | 닫힌 질문은 출력 10토큰 내외다(가설 — 측정으로 확인) |
| 도메인 규칙이 코드 곳곳에 흩어짐 | `PRESET_FOCUS`, `documentProfile` TYPES, `contractReview` RULES·CLAUSE_CHECKS, `verifiedRules` ARTICLE_EXPECTATIONS, `gaps` FACT_QUESTION | 한 스킬 패키지로 모으고, 버전·검수·시험을 스킬 단위로 관리한다 |

---

## 2. 설계 원칙

1. **스킬은 법적 근거가 아니다.** 스킬이 적은 조문 번호는 검색 씨앗과 점검 목록일 뿐이다. 의견서에 근거로 오르는 것은 지금처럼 국가법령정보센터에서 공식 본문을 확보하고 S6 검증을 통과한 근거뿐이다.
2. **스킬은 코드가 고른다.** 검토 유형(preset), 문서 성격(`documentProfile`), 키워드·점검 적중으로 결정적으로 고른다. 로컬 모델에게 스킬 색인을 보여 주고 고르게 하지 않는다. 색인을 프롬프트에 실으면 입력 처리 시간이 늘고, 5B 모델의 선택은 매번 달라진다.
3. **3단계 점진 공개.**
   - L1 색인(이름·설명·발동 조건): 코드에만 둔다. 프롬프트에 싣지 않는다.
   - L2 지침 조각: 발동된 스킬의 해당 단계 조각만 싣는다. 단계당 스킬 하나에 600자 이하로 한다.
   - L3 데이터(조문 목록·쟁점 서식·점검 규칙·요건 트리·정답셋): 코드만 읽는다.
4. **모델에게는 닫힌 질문만 묻는다.** 스킬 점검은 코드가 문서 문장(원문 인용)과 조문을 짝지은 다음 `YES / NO / UNCLEAR` 하나만 받는다. 인용은 코드가 찾았으므로 원문 대조가 항상 성립한다.
5. **결론에는 상한이 있다.** 스킬 점검은 `위반 소지`까지만 올릴 수 있고, 위법 확정은 내리지 않는다. 판례에 기대는 점검(포괄임금, 위약 예정과 경업금지 구별 등)은 `검토 필요` 상한으로 묶는다.
6. **법령 개정을 감지한다.** 스킬은 작성 당시 조문의 시행일과 원문 해시를 기록한다. 실행할 때 공식 본문과 다르면 그 조문에 걸린 점검과 요건 트리를 끄고 경고한다.
7. **측정으로 채택한다.** 스킬마다 정답셋 사례와 **위반이 없는 대조 문서**를 둔다. 재현율이 오르고 오탐이 늘지 않을 때만 기본값으로 켠다.

---

## 3. 스킬 패키지 형식

```
skills/
  skills.md                     ← 이 문서 (색인·작성 규칙)
  labor-work-rules/
    SKILL.md                    ← 머리말(메타데이터) + 단계별 지침 조각(L2)
    authorities.json            ← 검색 씨앗 조문과 공식 본문 지문 (L3)
    issues.json                 ← 쟁점 서식과 발동 조건 (L3)
    checks.json                 ← 문서 점검 규칙과 닫힌 질문 (L3)
    elements.json               ← 검수 요건 트리 (L3, 원문 해시에 묶임)
    gold.json                   ← 정답셋 사례와 대조 문서 연결 (L3)
  contract-services/
    SKILL.md, contract.json     ← 이관 스킬: 기존 계약 규칙 데이터
```

새 의존성은 들이지 않는다. 머리말은 `key: value`와 `key: [a, b]`만 쓰는 YAML 부분집합으로 자체 파서가 읽는다. JSON 파일은 `server/skills/skillLoader.js`의 `SKILL_SCHEMAS`(기존 `validateSchema`)로 검증하고, 형식 오류·잘못된 정규식·없는 쟁점 참조는 적재 시점에 오류로 알린다(그 스킬만 빠지고 다른 스킬은 적재된다).

### 3.1 SKILL.md 머리말 필드

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | ✓ | 스킬 식별자. 디렉터리 이름과 같아야 한다 |
| `name` | ✓ | 화면·의견서에 표시할 이름 |
| `kind` | ✓ | `domain`(도메인 지식 팩) 또는 `method`(분석 방법 조각) |
| `version` | ✓ | 내용이 바뀌면 올린다. 스킬 내용 해시와 함께 `review.reasoning.skillSet.digest`에 들어가 재검토 재사용을 막는다 |
| `origin` | | `migrated`면 기존 코드 규칙을 동작 그대로 옮긴 스킬이다(검수 기록 없이 active 가능, 선택기 대상 아님) |
| `presets` | ✓ | 발동하는 검토 유형 (`labor_hr` 등). `[*]`는 모든 유형 |
| `documentTypes` | | 문서 성격(`documentProfile`의 `REGULATION` 등). 발동 이유로 기록한다 |
| `keywords` | | 발동 이유 기록과 지식 카드 개정 후보 연결에 쓴다 |
| `stages` | ✓ | 붙는 단계: `collect`, `s1`, `s1-coverage`, `s3`, `s4-checks`, `s7` |
| `lawSnapshot` | ✓ | 조문 내용을 확인한 기준일 |
| `expertReviewed` | ✓ | 검수자·검수일. 검수 전이면 `null` |
| `status` | ✓ | `draft`(적재만) / `shadow`(진단만) / `active`(적용) |

### 3.2 SKILL.md 본문 절

| 절 제목 | 단계 | 쓰임 |
|---|---|---|
| `## S1 지침` | s1 | 공통 접두부의 `[쟁점 설정 방향]`을 대신한다 (600자 이하, 넘으면 적재 오류) |
| `## 금지 쟁점` | s1 | `- ` 목록. 도메인 지침 뒤에 `세우지 않을 쟁점: …`으로 붙는다(방법 스킬 포함) |
| `## S4 점검 지침` | s4-checks | 닫힌 질문 앞에 붙는 한두 문장 |
| `## 사실 질문 안내` | s7 | 사람이 읽는 사실 확인 안내(점검별 `factQuestions`가 실제 공백 문장이 된다) |
| `## 작성 메모` | — | 사람용. 프롬프트에 싣지 않는다 |

### 3.3 데이터 파일

`authorities.json` — `snapshot`은 `node scripts/skillSnapshot.js`가 채운다(손으로 쓰지 않는다).
```json
{ "laws": [ { "lawName": "근로기준법", "role": "CORE", "articles": ["제53조", "제94조"], "snapshotPolicy": "HASH",
             "when": { "checks": ["LB-08"], "keywords": ["경업"] },
             "snapshot": { "제53조": { "title": "연장 근로의 제한", "enforceDate": "20261008", "textHash": "8834848ae5577878" } } } ],
  "snapshotAt": "2026-11-28" }
```
`when`이 있으면 그 점검이 문서에 걸리거나 키워드가 나올 때만 씨앗이 된다.

`issues.json` — 점검이 위반 소지·검토 필요로 판정됐는데 그 내용을 다루는 쟁점이 없을 때 코드가 보충하는 쟁점 서식.
```json
{ "issues": [ { "id": "LB-I3", "question": "취업규칙의 연장근로 규정이 당사자 합의와 1주 12시간 한도를 지키는가?",
  "type": "PRIMARY", "priority": "HIGH", "articles": [{ "lawName": "근로기준법", "articleNo": "제53조", "unit": "제1항" }],
  "searchTerms": ["연장근로 한도"], "keywords": [["연장"], ["한도", "12시간", "합의", "동의"]],
  "triggers": { "checks": ["LB-01"] } } ] }
```

`checks.json` — 한 점검이 한 조문 요건에 대응한다.
```json
{ "checks": [ {
  "id": "LB-01", "issueId": "LB-I3", "label": "합의 없는 연장근로·1주 12시간 초과",
  "article": { "lawName": "근로기준법", "articleNo": "제53조", "unit": "제1항" },
  "scope": "SENTENCE",
  "match": { "all": ["연장|최대 ?근로 ?시간"], "any": ["(동의|합의) ?없이", "최대 ?근로 ?시간"], "none": ["초과할 ?수 ?없", "검토", "여부"] },
  "numeric": [ { "pattern": "최대 ?근로 ?시간[은는이가]? ?([0-9]+) ?시간", "violatesIf": "> 52", "unit": "시간" } ],
  "numericDecides": false,
  "closedQuestion": "이 문장은 근로자와의 합의 없이 연장근로를 시킬 수 있게 하거나, 1주 12시간을 넘는 연장근로를 허용하는가?",
  "ceiling": "VIOLATION_RISK", "route": "USER",
  "legalQuestion": "", "factQuestions": ["특별연장근로 인가를 받았는지 확인해 주십시오."],
  "positiveExamples": ["…"], "negativeExamples": ["연장근로는 당사자 간 합의로 1주 12시간을 한도로 한다."]
} ] }
```
- 정규식의 **공백은 '공백이 있거나 없음'**으로 바뀐다(`"동의 없이"` → `동의\s*없이`). 문자 클래스 안에는 공백을 쓰지 않는다.
- `scope`: `SENTENCE`(조항 문장 단위, 기본) 또는 `ROW`(표·CSV 한 행 단위, 행마다 따로 판정).
- `unit`: `제1항`, `제1항 제2호`, `제1항 단서`(등록부의 `A3.1x` 단서 단위).
- `numeric`: 숫자 비교가 성립하면 모델을 부르지 않고 위반 소지 후보가 된다. `numericDecides: true`면 숫자가 모두 기준 안일 때 점검을 해소로 본다(기간·금액만이 쟁점인 점검).
- `ceiling`: `VIOLATION_RISK`(위반 소지까지) 또는 `REVIEW_POINT`(검토 필요까지 — 판례 판단·사실 의존 점검). `VIOLATION_RISK` 점검은 닫힌 질문이나 숫자 판정이 반드시 있어야 한다.
- `route`·`legalQuestion`: 검토 필요 판정의 법리 질문을 외부 전문가 질의(`EXTERNAL_INQUIRY`)로 보낸다. 사실 질문은 항상 사용자 확인이다.
- `positiveExamples`는 반드시 걸리고 `negativeExamples`는 걸리지 않아야 한다(`test/skills.test.js`가 모든 스킬에 대해 확인).

`elements.json` — 검수 요건 트리. 공식 원문 해시(`textHash`)가 등록부와 같을 때만 S3 결과로 쓴다. `checks`로 점검과 요건을 정확히 잇는다.
```json
{ "articles": [ { "lawName": "근로기준법", "articleNo": "제94조", "textHash": "e008671954109e9e",
  "elements": [ { "text": "취업규칙을 근로자에게 불리하게 변경할 때는 … 동의를 받아야 한다", "mandatory": true,
                  "isException": false, "operator": "ALL_OF", "unit": "제1항 단서", "checks": ["LB-09"] } ] } ] }
```
등록부는 `다만,` 단서를 예외(`isException`)로 나누지만, 제94조 제1항 단서처럼 **더 엄격한 요건**인 단서는 요건 트리에서 일반 요건으로 바로잡는다.

---

## 4. 스킬 카탈로그

### 4.1 도메인 스킬

| ID | 이름 | 검토 유형 / 문서 성격 | 붙는 단계 | 우선순위 | 기존 코드와의 관계 |
|---|---|---|---|---|---|
| D1 `labor-work-rules` | 취업규칙·근로조건 검토 | `labor_hr` / `REGULATION` | collect, s1, s1-coverage, s3, s4-checks, s7 | **1** (측정 사례·정답셋 있음) | 적용 시 `PRESET_FOCUS.labor_hr`를 대신함 |
| D2 `contract-services` | 용역·도급 계약 리스크 | `contract_risk` / `CONTRACT` | (계약 경로 데이터) | 2 (이관 완료) | `contractReview.js` RULES·CLAUSE_CHECKS·AUTHORITY_HINTS, `verifiedRules.js` ARTICLE_EXPECTATIONS를 옮김 |
| D3 `privacy-processing` | 개인정보 처리현황 점검 | `privacy_security` / 표 문서 | collect, s1-coverage, s4-checks | 3 | `PRESET_FOCUS`와 `privacyCoverage.js`는 그대로, 행 단위 점검을 더함 |
| D4 `admin-disposition` | 행정처분 절차·실체 | `admin_dispute` / `DISPOSITION` | collect, s1, s1-coverage, s4-checks, s7 | 4 | 적용 시 `PRESET_FOCUS.admin_dispute`를 대신함 |
| D5 `ordinance-delegation` | 조례·상위법 위임 한계 | `ordinance_conflict` / `REGULATION` | collect, s1, s1-coverage, s4-checks, s7 | 5 | 적용 시 `PRESET_FOCUS.ordinance_conflict`를 대신함 |
| D6 `pre-consulting-audit` | 사전컨설팅 견해 비교 | `pre_consulting_audit` / `INQUIRY` | s1, s7 | 6 | 적용 시 `PRESET_FOCUS.pre_consulting_audit`를 대신함 |

### 4.2 방법 스킬 (대부분 이미 코드로 구현됨 — M1만 스킬 파일)

방법 스킬은 새 프롬프트를 늘리지 않는다. 이미 코드가 하는 일은 그대로 두고, 측정으로 드러난 실패 형태를 막는 짧은 조각만 둔다.

| ID | 방법 | 현재 구현 위치 | 스킬로 더할 것 |
|---|---|---|---|
| M1 | 쟁점 구성 (요건사실·IRAC) | `stages/caseIssues.js` | `method-issue-framing`: 막연한 선결 쟁점 금지 문구 |
| M2 | 법령 체계·시점 탐색 (상위·하위법, 위임·준용, 특별법, 부칙) | `law/lawWorkbench.js`, `lawVersionAt.js`, `cascadingRetriever.js` | 없음. 도메인 스킬의 `authorities.json`이 씨앗을 준다 |
| M3 | 요건 분해 (원칙·단서·열거) | `stages/elements.js` | 도메인 `elements.json` (검수된 요건 트리) |
| M4 | 문서 대조 포섭 | `stages/application.js` 문서 판단, `verify/conclusion.js` `resolveDocumentVerdict` | 도메인 `checks.json` (닫힌 질문) |
| M5 | 반대 논리·판례 구별 | `stages/application.js` counter·precedents, `issueResearch.js` 단서 반대 후보 | 없음 (심화분석 전용 유지) |
| M6 | 근거 검증 | `verify/warrant.js`, `verifiedRules.js` | 없음 |
| M7 | 공백 분류 (법리 → 외부 질의 / 사실 → 사용자) | `stages/gaps.js` | 도메인 `## 사실 질문 안내` |

---

## 5. D1 `labor-work-rules` (기준 스킬)

전체 내용은 [labor-work-rules/](labor-work-rules/)에 있다. 아래는 점검 요약이다. 조문 문구는 2026-11-28 공식 본문 기준이다.

| ID | 조문 | 코드가 찾는 문장 | 숫자 판정 | 상한 |
|---|---|---|---|---|
| LB-01 | 제53조 제1항 | 연장근로 + "동의·합의 없이", "12시간을 초과하는 연장", "최대 근로시간" | 최대 근로시간 > 52, 연장 1주 > 12 | 위반 소지 |
| LB-02 | 제27조 제1항 | 해고 + "구두·메신저·문자·전화", "서면 통지를 갈음" | — | 위반 소지 |
| LB-03 | 제26조 | 해고 + "예고 없이", "N일 전 예고" | N < 30 (숫자로 결정) | 위반 소지 |
| LB-04 | 제54조 제1항 | 휴게 + "종료 후", "일괄", "퇴근 시" | — | 위반 소지 |
| LB-05 | 제54조 제1항 | "휴게시간 N분" | — (닫힌 질문) | 위반 소지 |
| LB-06 | 제56조 제1항 | 연장·야간·휴일 + "포괄임금", "기본급에 포함", "추가 수당 청구 불가" | — | 검토 필요 → 외부 질의 |
| LB-07 | 제61조 제1항 | 연차·미사용 + "자동 소멸", "수당 미지급" (사용 촉진 언급 없음) | — | 검토 필요 |
| LB-08 | 제20조 | 위약금·위약벌·배상액 + "지급한다", "퇴직 후", "N배" | — | 검토 필요 → 외부 질의 (정답셋 `mustNotConclude`) |
| LB-09 | 제94조 제1항 단서 | 불이익·불리 + "동의 없이", "의견 청취로 갈음" | — | 위반 소지 |
| LB-10 | 제95조 | 감봉·감급 + "N%", "N분의", "N개월" | 급여의 N% > 10 | 위반 소지 |
| LB-11 | 제23조 제1항 | 해고 + "즉시 해고", "청문·소명 없이", "이의 제기 불가" | — (닫힌 질문 없음) | 검토 필요 → 외부 질의 |
| LB-12 | 제50조 | 근로시간 + "1일 9시간 이상", "1주 41시간 이상"(연장 문장 제외) | 1일 > 8, 1주 > 40 (숫자로 결정) | 위반 소지 |
| LB-13 | 제63조 | 근로시간 + "적용하지 아니한다" | — | 검토 필요 |

요건 트리: 제53조(합의·12시간 한도·인가 예외), 제94조(의견 청취·**불이익 변경 동의**·신고 시 의견서), 제27조(서면 통지·효력·서면 예고 간주).
정답셋: 사례 01(알려진 위반 4건), 대조 문서 06(`test/docs/review-samples/06_취업규칙_준수본.txt`, 위반 소지 0건이어야 함).

---

## 6. D2~D6 요약

### D2 `contract-services` — 기존 계약 규칙 이관 (active)
`contractReview.js`의 RULES·CLAUSE_CHECKS·TOPIC_MENTION·ISSUE_TERMS·AUTHORITY_HINTS·조문 씨앗과 `verifiedRules.js`의 ARTICLE_EXPECTATIONS를 `contract.json`으로 옮겼다. 정규식은 공백 변환 없이 그대로 컴파일한다(`server/skills/contractSkill.js`). 옮기기 전후 결과는 샘플 문서와 합성 문장 89건에서 같았고(`scripts/checkContractMigration.mjs`), `test/contractReview.test.js`가 그대로 통과한다. 계약 검토 경로는 스킬 적용 방식과 무관하게 이 데이터를 쓴다.

### D3 `privacy-processing` — 개인정보 처리현황 (행 단위)
점검 9개를 표·CSV **행 단위**로 돈다: 민감정보 별도 동의(제23조), 주민등록번호 처리·암호화(제24조의2), 기한 없는 보관(제21조), 안전조치(제29조), 근거 없는 제3자 제공(제17조), 국외 이전(제28조의8, 검토 필요), 위탁 공개·관리(제26조), 영상정보처리기기 녹음(제25조 제5항), 포괄·간주 동의(제22조). 기존 행 범위 판정(`privacyCoverage.js`)은 그대로다.

### D4 `admin-disposition` — 행정처분
의견제출 기간 10일 미만(행정절차법 제21조 제3항, 숫자로 결정), 청문 생략(제22조, 개별법 확인이 먼저라 검토 필요 → 외부 질의), 이유 미제시(제23조), 불복 고지 누락(제26조), 사전통지 생략(제21조 제1항, 검토 필요).

### D5 `ordinance-delegation` — 조례 위임 한계
위임 근거 없는 권리 제한·의무 부과(지방자치법 제28조 제1항 단서, 검토 필요 → 외부 질의), 과태료 1천만원 초과(제34조, 숫자로 결정), 조례의 형벌 규정(제28조 제1항 단서). 2022. 1. 13. 전 시점 검토에서는 조문 해시가 달라 점검이 자동으로 꺼진다.

### D6 `pre-consulting-audit` — 사전컨설팅 견해 비교
문서 점검 없이 S1 지침(갑설·을설을 하나의 해석 쟁점으로, 처리 의견의 절차 근거를 별도 쟁점으로)과 사실 질문 안내만 둔다.

### M1 `method-issue-framing` — 쟁점 구성 방법
"문서나 개별 조항의 내용이 확인되는가" 같은 막연한 선결 쟁점과 조문을 옮긴 질문을 금지 쟁점으로 붙인다. 도메인 스킬이 적용될 때 그 지침 뒤에 붙는다.

---

## 7. 런타임 계약 (구현)

| 모듈·함수 | 호출 지점 | 하는 일 |
|---|---|---|
| `skillLoader.loadSkills` / `getSkillCatalog` | 서버 첫 사용 시 1회 | 머리말·절·JSON 검증, 정규식 컴파일, 검수 규칙(active → shadow), 내용 해시 |
| `skillLoader.skillMode` | 요청마다 | `llmConfig.skillMode` → `REVIEW_SKILLS` → `auto` |
| `skillRouter.selectSkills` | `lawWorkbench.buildWorkbenchContext`, `pipeline.runReasoningPipeline` | 검토 유형·문서 성격·키워드로 적용(applied)·진단(shadow) 스킬 결정, `skillSetDigest` |
| `skillRouter.skillAuthoritySeeds` | 수집 단계 키워드 확장 직후 | 조문 씨앗을 `suggestedLaws`에 합치고, 다른 법령 씨앗은 명시 수집 대상으로 |
| `skillRouter.skillPromptFragment` | S0 `buildCommonPrefix(skillFocus)`, S1 분할 추출 | `[쟁점 설정 방향]`을 스킬 지침으로 대신하고 금지 쟁점을 붙임 |
| `skillElements.checkSkillStaleness` | S0 직후 | 조문 해시가 기록과 다르면 그 조문의 점검·요건 트리를 끄고 경고 |
| `skillChecks.findCheckHits` / `evaluateCheckHits` | S0 직후 (`progress` 단계 `skills`) | 문장·행 탐색 → 숫자 판정 → 닫힌 질문(`{"answer":"YES|NO|UNCLEAR"}`). 조문이 등록부에 없으면 `NO_AUTHORITY`로 두고 반영하지 않음 |
| `skillChecks.coverSkillIssues` | S1 조문·문서 연결 직후 | 판정된 점검의 쟁점이 없으면 보충(`origin: SKILL`), 있으면 문서 조항·조문을 이음 |
| `skillElements.skillElementTrees` | S3 `decomposeArticles(skillTrees)` | 해시가 맞는 검수 요건 트리를 모델 분해·캐시보다 먼저 씀(`source: SKILL`) |
| `skillChecks.skillAssessmentsFor` | S4 `applyIssue(skillAssessments)` | 판정을 문서 판단(`VIOLATES`/`UNCLEAR` + 코드가 찾은 원문 인용)으로 주입. 주입한 요건은 모델에게 다시 묻지 않음 |
| `skillChecks.skillGaps` | S7 `deriveGaps(skillGaps)` | 사실 질문 → 사용자 확인, 법리 질문 → 외부 전문가 질의 |
| `renderReview(skillNote)` | S5 | 의견서 머리에 `[적용 분석 스킬] … (전문가 검수 전)` |
| `review.reasoning.skillSet` / `skills` | 결과 | 적용 방식·다이제스트, 판정·진단·보충 쟁점·요건 트리·개정 감지 기록 |
| `skillCandidates.skillRevisionCandidates` | `GET /api/law/skills/candidates` | 승인된 지식 카드 → 스킬 개정 후보(자동 반영 없음) |
| `GET /api/law/skills` | 설정 화면 | 카탈로그 요약(상태·검수·점검 목록·조문 지문 수) |

재검토(외부 답변 반영)는 원 검토의 `skillSet.digest`가 지금과 다르면 저장된 쟁점 구조를 재사용하지 않고 멈춘다. 심화분석 이어가기는 기본분석의 스킬 방식을 그대로 쓴다.

---

## 8. 작성·검수 규칙

1. 점검은 조문에서 출발해 쓴다. 표본 문서 문장을 정규식으로 옮기지 않는다.
2. 점검 하나에 `negativeExamples`를 최소 1개 둔다.
3. 판례 판단이 필요한 기준은 `ceiling: REVIEW_POINT`로 둔다.
4. `version`을 올리지 않고 내용을 바꾸지 않는다. 버전이 바뀌면 단계 캐시와 재검토 재사용이 자동으로 무효가 된다.
5. `status: active`는 (a) 전문가 검수 기록, (b) 정답셋 재현율 개선, (c) 대조 문서 오탐 0을 모두 갖춘 뒤에만 쓴다.
6. 외부 전문가 질의에서 승인된 지식 카드가 같은 도메인에서 반복되면 스킬 개정 후보로 올린다. 자동 반영하지 않고 사람이 스킬에 옮긴다.
