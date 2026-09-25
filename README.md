# Legal Reviewer (지능형 AI 법령검토 & 공공서식 보고서 생성 워크벤치)

**Legal Reviewer**는 국가법령정보센터 공식 자료, 정밀 문서 파서, LLM 심층 추론, 조문 실존성 검증과 HWPX/PDF/DOCX 공공 표준 서식 보고서 생성을 유기적으로 연결한 로컬 법률 검토 워크벤치입니다. 결과는 근거·시점·사실관계를 확인하는 사람의 최종 검토가 필요합니다.

**현재 상태 (2026-09-25):** 기본 검토는 단일 호출(`monolithic`) 경로이지만, 입력 문서 및 컨텍스트가 모델 예산을 초과하면 토큰 안전을 위해 단계형 분할 검토(`staged` S0~S7)를 먼저 시도합니다. 판례·해석례는 검색 목록 선별 후 필요한 공식 본문만 2단계로 정밀 조회합니다. 단계형 검토(`REVIEW_PIPELINE=staged`)는 쟁점 생략 방지 및 인용 실존성 검증 강화가 적용되어 검증 시험 중입니다. 상세 구현 및 실측 데이터는 [현재 구현·검증 상태](docs/current-status.md)와 [단계형 비교 기록](docs/audit/pipeline-comparison-2026-09-23.md)을 참고하세요.

---

![Legal Reviewer 최종 검토보고서 전체 화면](docs/images/full_size_screenshot.png)

---

## 목차
1. [주요 핵심 기능](#주요-핵심-기능)
2. [UI 구조 및 작동 메커니즘](#ui-구조-및-작동-메커니즘)
3. [성능 고도화 5대 핵심 기술](#성능-고도화-5대-핵심-기술)
4. [시스템 아키텍처](#시스템-아키텍처)
5. [설치 및 실행 가이드](#설치-및-실행-가이드)
6. [벤치마크 및 테스트](#벤치마크-및-테스트)
7. [19대 법령 도구 카탈로그](#19대-법령-도구-카탈로그)
8. [프로젝트 디렉토리 구조](#프로젝트-디렉토리-구조)

---

## 주요 핵심 기능

### 1. 6대 법률 검토 프리셋 및 전문 행정감사 검토
- **적법성/규제 준수 (`compliance`)**: 신규 사업 기획, 행정 절차, 인허가 요건 및 상위 법령(시행령·시행규칙) 위반 여부 전면 검토
- **계약서 리스크 (`contract_risk`)**: 독소 조항, 불공정 약관, 손해배상 및 위약벌 과다 위험, 해제·해지 요건의 법률적 효력 분석 및 신·구 조문 수정 대안 제시
- **조례/내규 충돌 (`ordinance_conflict`)**: 지자체 조례안 및 공공기관 내규의 법률유보원칙 위배, 포괄위임금지 및 모법 위임 한계 일탈 여부 검토
- **행정처분/민원 (`admin_dispute`)**: 영업정지, 과징금, 시정명령 등 불이익 행정처분의 절차적/실체적 적법성 및 행정심판/소송 방어 논리 검토
- **개인정보/보안 (`privacy_security`)**: 개인정보 수집·이용 동의, 제3자 제공, 위탁 적법성, 안전성확보조치(암호화, 접근통제) 준수 여부 검토
- **인사/노무/근로 (`labor_hr`)**: 취업규칙, 근로계약, 해고/징계의 정당성, 주52시간제, 포괄임금제, 연장수당 등 노동관계법 검토
- **사전 컨설팅감사 전문 의견**: 적극행정 사전 컨설팅감사 신청에 대하여 대립 견해(갑설·을설)의 타당성을 비교하고 수용/반려 처리 의견 및 자치법규·행정규칙 근거를 반영한 전용 보고서 서식 출력

### 2. 검토 기준 시점 지정 (과거 법령 검토)
검토 요청 시 **검토 기준 시점(Date)**을 지정하면, 그 날짜에 실제로 시행 중이던 법령 버전으로 소급 검토합니다. 사건 발생일이나 계약 체결일이 현재와 다를 때 현행 조문으로 오판하는 것을 원천 차단합니다.
- 기준 법령, 문서가 인용한 타 법령, 법–시행령–시행규칙 연쇄 체계를 **모두 같은 시점 버전으로 동기화**합니다.
- 특정 단계의 해당 시점 버전을 공식 API에서 확인하지 못하면 현행 조문으로 임의 대체하지 않고 제외한 뒤 제한 사항으로 명시합니다.
- 기준일 이후 시행된 조문은 근거에서 제외하며, 인용 실존성 검증 기준일도 해당 시점으로 전환됩니다.
- 검토 화면과 HWPX/PDF/DOCX 보고서에 시점 검토 명시 및 **부칙·경과조치 별도 확인 필요성**을 표시합니다. 형식이 잘못된 기준일은 자동으로 오늘 날짜로 대체하지 않고 요청을 거절합니다.

### 3. 실시간 검토 추론 과정 스트리밍 (Review Trace)
- **NDJSON 스트림 전송**: 백엔드 검토 엔진(`progressReporter.js`)에서 단계별 진행 상황을 실시간 스트리밍합니다.
- **5단계 진행 트랙**: 준비(`prepare`) ➔ 수집(`collect`) ➔ 분석(`analyze`) ➔ 작성(`write`) ➔ 검증(`verify`) 단계별 가중치 기반 진행률(%) 및 소요 시간 실시간 표시.
- **세부 추론 로그**: 조문 수집, 판례 2단계 선별, 토큰 예산 검사, 요건 포섭 등 내부 판단 단계를 투명하게 열람 가능.

### 4. 멀티포맷 정밀 파싱 및 공공 표준 서식 보고서 생성
- **지원 입력 문서**: HWPX, PDF, DOCX, XLSX/XLS, CSV, TXT (표/Table 구조, 셀 병합, 조항 계층 트리 청킹 완벽 복원)
- **지원 출력 보고서**:
  - **HWPX**: 한컴오피스 표준 OCF/OWPML 바이너리 패키징 (신·구 조문 대비표 및 공공 결재선 내장)
  - **PDF**: 인쇄용 공문서 레이아웃, 조판 스타일 및 한글 폰트 적용
  - **DOCX**: MS Word OpenXML 호환 보고서 서식
  - **Markdown**: 텍스트 편집용 마크다운 서식
- **보고서 스튜디오 연동**: 의견서 텍스트를 인라인으로 심층 편집하고 커스텀 공문서로 재출력 가능.

### 5. 브라우저 IndexedDB 영구 검토 이력 관리
- **영구 보존 (Persistent Storage API)**: 검토 결과 스냅샷이 브라우저 로컬 저장소인 `IndexedDB(LegalReviewDB)`에 안전하게 자동 저장됩니다. 브라우저를 닫거나 시스템을 재부팅해도 보존됩니다.
- **원클릭 복원**: 우측 검토 이력 드로어에서 이전 검토 결과를 클릭 한 번으로 완벽 복원합니다.

---

## UI 구조 및 작동 메커니즘

```text
[사용자 입력: 문서 첨부(HWPX/DOCX/PDF 등) + 질의 입력 + 6대 프리셋 + 기준시점 선택]
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 실시간 검토 추론 진행 엔진 (NDJSON Review Trace Stream)                      │
│ [준비(prepare)] ➔ [수집(collect)] ➔ [분석(analyze)] ➔ [작성(write)] ➔ [검증]  │
│  - 실시간 경과 시간 및 가중치 기반 전체 진행률(%) 게이지                      │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 법령 데이터 수집, 판례 선별 & Re-ranking 엔진                            │
│    - 국가법령정보센터 DRF API / 판례 / 해석례 실시간 수집                   │
│    - 판례·해석례 2단계 선별: 목록 선별(Screening) ➔ 통과 후보 공식 본문 확보 │
│    - legalDocChunker(조·항·호 계층 분할 및 위험 조항 태깅)                  │
│    - 시맨틱 Re-ranking (Top 3 판례, Top 2 해석례 엄선)                     │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. LLM 검토 엔진 & 조문 실존성 검증기                                       │
│    - 단일 호출(Monolithic) 또는 토큰 안전 단계형(Staged S0~S7) 추론          │
│    - 쟁점(Issue) ➔ 규범(Rule) ➔ 포섭(Application) ➔ 결론(Conclusion) IRAC   │
│    - factualityVerifier: 공식 조문 전수 교차 검증 (미확인 인용 UNVERIFIED)   │
│    - Redline Diff: 위법/독소 조항 신·구 조문 대비표 자동 생성                │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ [탭 1] 공식 근거 │        │ [탭 2] 개정·영향 │        │ [탭 3] 외부 질의 │
│ - 공식 조문 본문 │        │ - 위험 조항 분석 │        │ - 비식별 질의서  │
│ - Re-rank 판례   │        │ - 4열 조문대조표 │        │ - 답변 반입 카드 │
│ - 유권해석/조례  │        │ - 법령 개정연혁  │        │ - 연결 재검토    │
└──────────────────┘        └──────────────────┘        └──────────────────┘
                                      │
                                      ▼
                            ┌──────────────────┐
                            │ [탭 4] 의견서    │
                            │ - 조문검증 뱃지  │
                            │ - IRAC 분석 전문 │
                            │ - Redline 대비표 │
                            │ - HWPX/PDF 다운  │
                            │ - 스튜디오 편집  │
                            └──────────────────┘
```

### 탭 1: [1. 공식 법령 & 근거] (`#tab-evidence`)
- **공식 법령 조문 본문**: 국가법령정보센터 공식 DRF API로 수집된 관련 법령의 조·항·호 원문 카드.
- **시맨틱 Re-ranked 판례 및 유권해석례**: 사안 적합도 점수와 매칭 사유가 포함된 판결요지 전문 팝업 카드.
- **연쇄 법령 체계 및 자치법규(조례)**: 모법(법률) ➔ 시행령 ➔ 시행규칙 3단계 연쇄 구조와 행정규칙, 지자체 조례 및 별표/서식 카드.

### 탭 2: [2. 개정 & 영향 분석] (`#tab-revisions`)
- **1. 내부 문서 쟁점 및 위험 조항 영향도 분석**: 사전동의 생략, 음성녹음, 과다 위약벌, 일방 해지 등 독소 조항 자동 감지 및 파급 효과 분석.
- **2. 조문 인용 충돌 및 현행 법령 적합성 대조표**: 4열 표준 테이블 (인용 조문 / 적합성 판정 / 공식 조문 내용 / 실무 조치 가이드).
- **3. 소관 법령 최근 개정 연혁 및 시행 타임라인**: 최근 공포일자, 공포번호, 시행일자, 소관 부처 개정 히스토리.

### 탭 3: [3. 외부 전문가 질의] (`#tab-learning`)
- **비식별 질의서 생성 및 반출**: 소형 로컬 LLM이 스스로 판단하기 어려운 법리적 공백을 비식별 질의서로 자동 추출하여 반출 준비(`READY`).
- **외부 답변 반입 및 지식 카드 승인**: 외부 고성능 AI 또는 법률 전문가로부터 받은 답변을 질문별로 반입하여 구조화 지식 카드로 검토·승인(`APPROVED`).
- **승인 지식 기반 연결 재검토**: 원 검토의 공식 근거 스냅샷·사실·쟁점을 재사용하여 답변이 연결된 요건만 부분 재추론하고 종합 결론 갱신.

### 탭 4: [4. 법률검토의견서] (`#tab-official-report`)
- **조문 실존성 검증 뱃지**: 수집된 공식 조문 및 법령 API와 대조한 인용 검증 비율(검증 건수/전체 인용 건수) 실시간 표시. 미확인 인용은 `UNVERIFIED`로 표기.
- **쟁점별 IRAC 심층 법률 검토의견**: 쟁점(Issue), 적용 규범(Rule), 구체적 사실관계 포섭(Application), 종합 결론(Conclusion).
- **신·구 조문 대비표 (Redline Diff)**: 독소/위법 조항에 대한 `[현행 문구]` vs `[수정 권고안]` vs `[개정 사유]` 대조 테이블.
- **보완 권고사항 체크리스트 & 적용 조문 근거표**.
- **원클릭 공문서 내보내기**: HWPX, PDF, DOCX 원클릭 다운로드 및 **[보고서 스튜디오]** 심층 편집 연동.

---

## 성능 고도화 5대 핵심 기술

1. **문서 정밀 구조화 (Document Engine)**
   - HWPX `<hp:tbl>` 및 DOCX `<table>` 마크다운 표 변환 복원.
   - `legalDocChunker`: `제O조`, `①항`, `1.호`, `가.목` 계층 트리 청킹 및 위험 조항 태깅 (`clauseSalience.js`).
   - `contextOptimizer`: 50~100페이지 대용량 문서의 쟁점 조항 우선 슬라이싱.
2. **하이브리드 검색 & 시맨틱 Re-ranking (Retrieval Engine)**
   - 60+ 법률 도메인 실무 키워드 및 다중 질의어 사전 확장 (`lawTermKb.js`).
   - 3단계 체계적 연쇄 검색 (`cascadingRetriever.js`) — 모법·시행령·시행규칙 추적.
   - 판례·해석례 2단계 선별 (`evidenceScreen.js`): 목록 선별 후 통과·불확실 후보만 공식 본문 정밀 수집.
   - 시맨틱 Re-ranking 알고리즘 (조문 일치 45% + 쟁점 포섭 40% + 대법원/전합 권위 15%) ➔ **Top 3 판례, Top 2 해석례 엄선**.
3. **LLM 추론과 인용 확인 (Reasoning & Quality)**
   - 기본 단일 호출(`monolithic`) 경로 및 대용량 입력 시 토큰 안전 단계형(`staged` S0~S7) 추론.
   - `factualityVerifier`: LLM 인용 조문의 실존성을 공식 조문(법령ID, 버전, 조, 가지번호, 항·호)과 전수 교차 검증하고 미확인 인용을 `UNVERIFIED`로 명시.
4. **UI 렌더링 & 공공 표준 서식 패키징**
   - 실시간 NDJSON 진행률 스트리밍 렌더러 (`reviewTrace.js`).
   - HWPX/PDF/DOCX 공문서 출력 시 신구 조문 대비표, 조문 검증 결과, 사전 컨설팅감사 전용 서식(`consultingAuditReport.js`) 내장.
5. **다계층 캐시 및 안정성 인프라**
   - 인메모리 L1 + SQLite L2 (WAL 모드) 캐시 3종 (`law_cache.db`, `law_history.db`, `manual_learning.db`).
   - `AbortController` 및 전용 dispatcher 기반 요청 취소 및 타임아웃 안전 제어 (`abort.js`, `llmGateway.js`).

---

## 시스템 아키텍처

```mermaid
flowchart TB
    subgraph Client["프론트엔드 (웹 워크벤치)"]
        UI_Input["문서 첨부 (HWPX/DOCX/PDF/XLSX/CSV/TXT) + 6대 프리셋 질의"]
        UI_Trace["실시간 진행률 및 추론 과정 패널 (Review Trace)"]
        UI_Tabs["워크벤치 4대 결과 탭 (공식근거 / 개정영향 / 외부질의 / 의견서)"]
        UI_Studio["보고서 스튜디오 & HWPX/PDF/DOCX 다운로드"]
        UI_History["IndexedDB 영구 검토 이력 관리 드로어"]
    end

    subgraph Server["백엔드 (Node.js/Express ESM)"]
        API_Router["Law API Router (/api/law)"]
        WB_Builder["Law Workbench Engine"]
        Progress["실시간 진행률 리포터 (progressReporter.js)"]
        Doc_Parser["통합 문서 파서 (HWPX/DOCX/PDF/Excel/Chunker)"]
        Law_Client["국가법령 DRF API 클라이언트 & 파서"]
        Screen["판례·해석례 2단계 선별기 (evidenceScreen.js)"]
        ReRanker["시맨틱 Re-ranking 엔진 (reRanker.js)"]
        LLM_Engine["법리 추론 엔진 (단일호출 / 단계형 S0~S7)"]
        Verifier["조문 실존성 검증기 (factualityVerifier.js)"]
        Learning["외부 전문가 질의·지식 관리 (manualLearning.js)"]
        Export_Engine["공공 표준 서식 생성기 (HWPX/PDF/DOCX/MD)"]
        Cache_DB["SQLite L2 WAL 캐시 DB"]
    end

    subgraph External["외부 연동"]
        Law_DRF["국가법령정보센터 DRF API (법령/조문/행정규칙/자치법규/판례)"]
        LLM_Service["로컬 Ollama (gemma4 등) 또는 클라우드 LLM"]
    end

    UI_Input --> API_Router
    API_Router --> Doc_Parser
    API_Router --> WB_Builder
    WB_Builder --> Progress
    Progress -.-> UI_Trace
    WB_Builder <--> Cache_DB
    WB_Builder <--> Law_Client
    Law_Client <--> Law_DRF
    WB_Builder --> Screen
    WB_Builder --> ReRanker
    WB_Builder --> LLM_Engine
    LLM_Engine <--> LLM_Service
    LLM_Engine --> Verifier
    API_Router <--> Learning
    API_Router --> UI_Tabs
    UI_Tabs --> UI_Studio
    UI_Tabs <--> UI_History
    UI_Studio --> Export_Engine
```

---

## 설치 및 실행 가이드

### 1. 환경 요구사항
- **Node.js 22.0.0 이상** (`node:sqlite` 내장 모듈을 사용합니다. Node 18/20에서는 구동되지 않습니다.)
- npm 9.0.0 이상
- (권장) 로컬 LLM 구동 시: [Ollama](https://ollama.ai)

> **LAW_OC 미설정 시 동작**: 국가법령정보센터 API 인증(`LAW_OC`)이 없으면 서버는 공식 자료를 조회하지 않고 `UNAVAILABLE` 상태와 제한 사항을 반환합니다. 샘플은 `LAW_DEMO_MODE=true`로 명시한 경우에만 제공하며, 공식 근거로 검증하지 않습니다.

### 2. 설치 및 실행
```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정 (.env 파일 생성)
# LAW_OC는 국가법령정보공동활용(open.law.go.kr)에서 발급받은 계정 ID를 입력합니다.
# .env 파일에 LAW_OC 및 사용할 LLM 설정을 입력합니다.

# 3. 서버 실행
npm start
# 또는 개발 모드: npm run dev
```

브라우저에서 `http://localhost:3000`으로 접속하여 사용합니다.

기본 검토는 단일 호출이며, 입력 예산을 초과하면 단계형 분할 검토를 먼저 시도합니다. 로컬 Ollama에서 단계형 경로를 직접 시험하려면 `.env`에 `REVIEW_PIPELINE=staged`를 설정합니다. 단계형은 현재 검증 중이며 기본 운영 경로로 권장하지 않습니다.

---

## 벤치마크 및 테스트

### 단위 테스트
```bash
npm test
```
2026-09-25 현재 **231건 통과, 0건 실패**입니다. 단위 테스트는 외부 통신을 차단한 픽스처 기반이며, 법령 파싱, 조문 실존성 검증, 시맨틱 Re-ranking, 진행률 NDJSON 스트리밍, 시점 검토, 단계형 검토 등 시스템 전반을 검증합니다.

### 벤치마크 실행
```bash
# 환경설정(.env)의 LLM_PROVIDER 기준
node test/benchmark/runBenchmark.js

# 엔진 지정
BENCH_PROVIDER=ollama node test/benchmark/runBenchmark.js

# 폴백 결과까지 집계에 포함 (진단용)
BENCH_ALLOW_FALLBACK=1 node test/benchmark/runBenchmark.js
```

하네스는 데이터셋(`test/benchmark/benchmarkDataset.js`)의 `targetLaw`와 `expectedArticles`를 정답으로 삼아 다음을 채점합니다.
- **기준 법령 일치**: 시스템이 실제로 조회한 법령이 기대 법령과 일치하는가
- **조문 인용 정확도 / 재현율**: 인용 조문이 정답 조문 집합과 얼마나 일치하는가
- **판례 적합도**: Re-ranker 점수 (값이 없으면 기본값을 채우지 않고 '측정 불가')
- **Redline 수정안**: 탐지 건수가 아니라 실제 수정 문구가 작성된 건수

---

## 19대 법령 도구 카탈로그

헤더의 **[19대 법령 도구]** 버튼으로 접근할 수 있는 실행 가능한 도구 17종과 인프라 모듈 2종(`toolRunner`, `toolRegistry`)입니다.

| 도구명 | 설명 |
|---|---|
| `searchLaw` | 키워드/법령명 기반 법령 목록 검색 |
| `searchAiLaw` | 자연어 질의 기반 AI 스마트 법령 검색 |
| `articleDetail` | 법령 ID 및 조문 번호 기준 상세 조문 조회 |
| `articleAt` | 특정 시행일자 기준 과거/미래 조문 조회 |
| `articleDiff` | 개정 전·후 조문 비교 및 변경사항 하이라이트 |
| `impactMap` | 내부 문서 조문 인용 충돌 및 현행 법령 적합성 대조 분석 |
| `precedents` | 대법원 및 하급심 판례 검색 |
| `interpretations` | 법제처 유권해석례 검색 |
| `decisions` | 행정심판 및 특별행정심판 재결례 검색 |
| `adminRules` | 소관 부처 훈령, 예규, 고시 검색 |
| `linkedOrdinances` | 법령 위임 지자체 조례 및 자치법규 검색 |
| `delegatedLaws` | 모법 위임 하위 시행령/시행규칙/고시 추적 |
| `lawStructure` | 법령 전체 편-장-절-조 계층 트리 구조 조회 |
| `lawHistory` | 법령 버전 목록 조회 (`target=eflaw`, `nw`, `LID` 활용) |
| `timeTravel` | 시행일 기준 버전 선택 및 본문 조회 (`MST`, `efYd` 활용) |
| `annexes` | 법령 별표 및 서식 조회 |
| `verifyCitations` | 인용 조문 실존성 검증 (미확인 인용은 `UNVERIFIED`로 표시) |
| `toolRunner` | *(인프라)* 도구 실행기 |
| `toolRegistry` | *(인프라)* 도구 카탈로그 메타데이터 |

---

## 프로젝트 디렉토리 구조

```text
legal_review/
├── .env                          # 환경 설정 (LAW_OC, LLM_PROVIDER 등)
├── package.json                  # 프로젝트 의존성 및 스크립트
├── README.md                     # 프로젝트 종합 안내서
├── docs/                         # 핵심 문서 및 실측 자료
│   ├── current-status.md         # 현재 아키텍처·구현·검증 상태 통합 문서
│   ├── images/                   # 스크린샷 및 아이콘 에셋
│   │   ├── full_size_screenshot.png # 최종 검토보고서 전체 화면
│   │   ├── screenshot_main.png   # 워크벤치 메인 화면
│   │   └── app_icon.png          # 앱 아이콘
│   └── audit/                    # 벤치마크 및 진단 실측 기록
│       ├── pipeline-comparison-2026-09-23.md # 5건 실측 비교 분석
│       └── *.json                # 벤치마크 원본 데이터
├── public/                       # 프론트엔드 정적 파일
│   ├── index.html                # 메인 워크벤치 UI (4대 결과 탭 + 19대 도구 + 스튜디오)
│   ├── css/
│   │   ├── main.css              # 디자인 시스템 토큰 및 공통 레이아웃
│   │   ├── workbench.css         # 검토 화면, Redline 대비표, 대조표 스타일
│   │   ├── studio.css            # 보고서 스튜디오 및 이력 드로어 스타일
│   │   └── reviewTrace.css       # 실시간 검토 추론 진행 패널 스타일
│   └── js/
│       ├── app.js                # 메인 엔트리포인트, 6대 프리셋 및 이벤트 바인딩
│       ├── lawWorkbench.js       # 검토 화면 렌더러 및 뱃지 상태 제어
│       ├── reviewTrace.js        # 실시간 진행률 및 분석 추적 렌더러 (NDJSON)
│       ├── reasoningView.js      # 단계형 결과의 쟁점·요건 표
│       ├── learningTab.js        # 외부 질의·답변 반입 UI
│       ├── learningIssues.js     # 학습 쟁점 관리 모듈
│       ├── documentStudio.js     # 보고서 스튜디오 에디터
│       ├── documentViewer.js     # 조문/판례 전문 팝업 뷰어
│       ├── history.js            # 검토 이력 드로어 UI
│       ├── historyDb.js          # IndexedDB 영구 저장소
│       └── state.js              # 프론트엔드 전역 상태 관리
├── server/                       # 백엔드 모듈 (Node.js ESM)
│   ├── index.js                  # Express 서버 엔트리포인트
│   ├── env.js                    # 환경변수 로딩 및 유효성 검증
│   ├── rateLimit.js              # 요청 제한 미들웨어
│   ├── abort.js                  # 요청 취소 제어기
│   ├── requestOrigin.js          # 요청 오리진 검증 미들웨어
│   ├── export/
│   │   ├── exportFiles.js        # HWPX, PDF, DOCX, MD 표준 공문서 생성
│   │   ├── exportStyles.js       # 공문서 스타일 정의
│   │   ├── reportSafety.js       # 보고서 출력 안전 검증기
│   │   └── consultingAuditReport.js # 사전 컨설팅감사 전용 공문서 서식 생성기
│   ├── law/
│   │   ├── lawApi.js             # Law API Express 라우터
│   │   ├── lawApiClient.js       # 국가법령정보센터 DRF 통신 클라이언트
│   │   ├── lawApiParser.js       # 법령 XML 파서
│   │   ├── decisionsApiClient.js # 판례/해석례 DRF 클라이언트
│   │   ├── decisionsApiParser.js # 판례/해석례 XML 파서
│   │   ├── evidenceScreen.js     # 판례·해석례 2단계 선별기
│   │   ├── cascadingRetriever.js # 모법-시행령-시행규칙 3단계 연쇄 검색
│   │   ├── reRanker.js           # 판례/해석례 시맨틱 Re-ranking 엔진
│   │   ├── factualityVerifier.js # 조문 실존성 검증 및 오인용 교정
│   │   ├── lawWorkbench.js       # 워크벤치 오케스트레이션 엔진
│   │   ├── lawWorkbenchReview.js # 기본 단일 호출 검토 및 단계형 위임
│   │   ├── progressReporter.js   # NDJSON 진행률 스트리밍 리포터
│   │   ├── decisionDiagnostics.js# 결정 진단 분석기
│   │   ├── manualLearning*.js    # 비식별 질의서, 답변 카드, 지식 승인
│   │   ├── lawTermKb.js          # 60+ 도메인 법률 전문용어 KB
│   │   ├── lawArticleRef.js      # 조문 정규식 추출기
│   │   ├── lawDiff.js            # 조문 신구 비교 엔진
│   │   ├── lawCache.js           # SQLite L2 캐시
│   │   └── tools/                # 17개 법령 도구 및 실행 인프라 (총 19종)
│   ├── reasoning/                # 시험용 단계형 검토(S0~S7), 호출 원장·검증·공백
│   └── parsers/
│       ├── index.js              # 통합 문서 파서
│       ├── hwpxParser.js         # HWPX 표(Table) 및 문단 파서
│       ├── docxParser.js         # DOCX 표(Table) 파서
│       ├── pdfParser.js          # PDF 텍스트 정규화 파서
│       ├── excelParser.js        # 엑셀 파서
│       ├── legalDocChunker.js    # 조항 계층 트리 청킹 & 위험 조항 태깅
│       ├── clauseSalience.js     # 조항 위험도 중요도 분석기
│       └── contextOptimizer.js   # 대용량 문서 쟁점 중심 압축기
└── test/                         # 테스트 및 벤치마크 스위트
    ├── advancedParsers.test.js   # 고도화 파서 단위 테스트
    ├── export.test.js            # HWPX/PDF/DOCX 생성 테스트
    ├── lawApi.test.js            # 법령 API 클라이언트 테스트
    ├── lawHistory.test.js        # 법령 개정 이력 테스트
    ├── parsers.test.js           # 기본 문서 파서 테스트
    ├── reRankerAndVerifier.test.js # Re-ranking 및 환각 검증 테스트
    ├── reviewProgress.test.js    # 진행률 및 스트리밍 테스트
    └── benchmark/
        ├── benchmarkDataset.js   # 20종 실무 법률 검토 벤치마크 데이터셋
        ├── runBenchmark.js       # 기존 벤치마크 하네스
        └── pipelineBaseline.js   # 단일 호출·단계형 5개 샘플 진단 측정
```

### 검증과 운영 범위

`npm test`는 임시 캐시·업로드 경로와 주입한 픽스처를 사용하며 외부 통신을 차단합니다. `npm run test:integration`은 실제 `LAW_OC`가 있을 때 공식 API 계약을 검증하고, 키가 없으면 건너뜁니다. 통합 테스트 건너뜀은 실측 성공으로 계산하지 않습니다.

기본 바인딩은 `127.0.0.1`입니다. 외부 서비스로 공개하려면 별도의 사용자 인증·권한 통제가 필요합니다. 출처·조문 존재 확인은 법리 타당성 검증과 다르며, 관련도 점수는 휴리스틱입니다. 시행령·시행규칙 연결 결과는 부분 탐색입니다.

현재 아키텍처 및 상태는 [현재 구현·검증 상태](docs/current-status.md)와 [단계형 비교 기록](docs/audit/pipeline-comparison-2026-09-23.md)을 참고하십시오.
