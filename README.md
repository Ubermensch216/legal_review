# Legal Reviewer (AI 법령검토 & 공공서식 보고서 생성 워크벤치)

**Legal Reviewer**는 국가법령정보센터(law.go.kr) 공식 Open API, 대법원 판례, 법제처 유권해석례, 행정규칙 및 자치법규(조례) 연동과 로컬 LLM(Ollama)을 결합하여, 법령 검토 및 공공서식 보고서(HWPX, PDF, DOCX) 생성을 자동화하는 **독립형 AI 법률 검토 워크벤치 솔루션**입니다.

---

## 목차
1. [주요 핵심 기능](#주요-핵심-기능)
2. [시스템 아키텍처](#시스템-아키텍처)
3. [설치 및 실행 가이드](#설치-및-실행-가이드)
4. [AI 모델 및 환경 설정](#ai-모델-및-환경-설정)
5. [테스트 및 샘플 문서 검토 방법](#테스트-및-샘플-문서-검토-방법)
6. [19대 법령 도구 목록](#19대-법령-도구-목록)
7. [프로젝트 디렉토리 구조](#프로젝트-디렉토리-구조)

---

## 주요 핵심 기능

### 1. 6대 법률 검토 프리셋
- **적법성/규제 준수**: 신규 사업 기획, 행정 절차, 인허가 요건 및 법령 위반 여부 검토
- **계약서 리스크 분석**: 독소 조항, 불공정 약관, 손해배상 및 해지 조항의 법률적 효력 검토
- **조례/내규 상위법 충돌**: 지자체 조례안 및 공공기관 내규의 모법 위임 한계 일탈 여부 검토
- **행정처분/민원 대응**: 영업정지, 과태료 등 행정처분의 절차적/실체적 적법성 및 행정심판 가능성 검토
- **개인정보/보안 규제**: 개인정보 수집·이용 동의, 제3자 제공, 안전조치의무 준수 검토
- **인사/노무/근로기준**: 근로계약, 취업규칙, 해고/징계, 주52시간제 등 노동관계법 검토

### 2. 3단계 전문 워크벤치 탭 구조
- **[1단계: 검토 초안 (Review Draft)]**
  - 핵심 검토 결론 요약 (3줄 핵심 정리)
  - 쟁점 및 법적 리스크 매트릭스 (HIGH / MEDIUM / LOW 등급별 제재 및 과태료 위험 분석)
  - 심층 법률 검토의견서 (본론)
  - 보완 권고사항 및 조치 계획 체크리스트
  - 완성형 공문서 마크다운 초안
- **[2단계: 공식 법령 & 근거 (Official Evidences)]**
  - 대한민국 현행 법령 조문 전문 (조·항·호·목 구조화 및 원문 팝업 뷰어)
  - 대법원 판례 및 법제처 유권해석례, 행정규칙(훈령/예규/고시)
  - 자치법규(지자체 조례) 및 법령 별표/서식 다운로드
- **[3단계: 개정 & 영향 분석 (Revisions & Impacts)]**
  - 첨부문서 내 조문 인용 충돌 및 적합성 분석 신호등
  - 삭제/폐지된 과거 구(舊) 조문 인용 시 즉시 경고 알림

### 3. 멀티포맷 첨부문서 파싱 및 공공서식 보고서 생성
- **지원 입력 문서**: HWPX, PDF, DOCX, XLSX, CSV, TXT
- **지원 출력 보고서**:
  - **HWPX**: 한글 2014 이상 버전과 완벽 호환되는 표준 OCF/XML 패키징
  - **PDF**: 인쇄용 공문서 레이아웃 및 한글 폰트 적용
  - **DOCX**: MS Word OpenXML 서식
  - **Markdown**: 텍스트 편집용 마크다운

---

## 시스템 아키텍처

```text
[사용자 브라우저 (Web UI)]
   │  - 6대 검토 프리셋 선택 / 자연어 질의 입력
   │  - HWPX, PDF, DOCX 파일 드래그앤드롭
   │  - 3단계 탭 워크벤치 & 실시간 보고서 스튜디오
   ▼
[Express 메인 서버 (/api/law)]
   │
   ├── [1. 멀티포맷 문서 파서] ── HWPX, PDF, DOCX 텍스트 및 표 추출
   │
   ├── [2. 법령 워크벤치 오케스트레이터]
   │      ├── 국가법령정보센터 (law.go.kr) DRF API ── 현행 법령 및 조문 수집
   │      ├── 종합법률정보 API ── 대법원 판례, 법제처 유권해석례 수집
   │      └── SQLite 2계층 캐시 DB ── 7일~30일 TTL 고속 캐싱
   │
   ├── [3. AI 추론 엔진 (Ollama gemma4:e2b)] ── 10대 검토 JSON 구조화 생성
   │
   └── [4. 공공서식 익스포터] ── HWPX, PDF, DOCX 보고서 즉시 다운로드
```

---

## 설치 및 실행 가이드

### 1. 사전 요구 사항
- **Node.js**: v18.0.0 이상 (Node.js 22+ 권장, 내장 `node:sqlite` 지원)
- **Git**: 최신 버전
- **(선택)** Ollama 로컬 LLM 서버 (http://localhost:11434) 및 `gemma4:e2b` 모델

### 2. 저장소 복제 (Clone Repository)
```bash
git clone https://github.com/Ubermensch216/legal_review.git
cd legal_review
```

### 3. 의존성 패키지 설치
```bash
npm install
```

### 4. 서버 실행
```bash
# 운영 모드 실행
npm start

# 또는 개발 모드 (파일 변경 감지 및 자동 재시작)
npm run dev
```

> **Windows 사용자 팁**: 프로젝트 루트에 있는 `run.bat` 파일을 더블클릭하면 패키지 확인 후 원클릭으로 서버가 구동됩니다.

### 5. 웹 브라우저 접속
서버 구동 후 브라우저에서 아래 주소로 접속합니다:
```text
http://localhost:3000
```
*(만약 3000번 포트가 이미 사용 중인 경우, 자동으로 3001번 등 다음 사용 가능한 포트로 구동됩니다.)*

---

## AI 모델 및 환경 설정

프로젝트 루트의 `.env` 파일 또는 웹 화면 우측 상단의 **설정(아이콘)** 모달에서 원클릭으로 설정을 변경할 수 있습니다.

### 기본 설정 (`.env`)
```env
# 서버 포트
PORT=3000

# 1. Ollama 로컬 LLM 설정 (기본값)
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:e2b

# 2. 국가법령정보센터 오픈API 인증키 (선택)
# 발급처: https://open.law.go.kr (미입력 시 고품질 내장 Mocking 모드로 자동 동작)
LAW_OC=

# 3. 클라우드 LLM 설정 (필요 시 선택 사용)
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-3-5-sonnet-latest

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
```

---

## 테스트 및 샘플 문서 검토 방법

프로젝트의 `test/docs/` 폴더에는 실제 공공 및 기업 환경에서 자주 발생하는 복합 법적 분쟁 시나리오 문서가 준비되어 있습니다.

### 준비된 샘플 문서 목록
1. **`test/docs/test_cctv_guideline.hwpx`**
   - **시나리오**: 공공기관 AI 안면인식 CCTV 영상관제 운영지침(안)
   - **주요 쟁점**: 개인정보보호법 제25조(음성녹음 금지) 위반, 생체인식정보 사전동의 생략, 민간 위탁사 비식별화 없는 실시간 전송, 삭제된 구 조문 인용 충돌
2. **`test/docs/test_mobility_ordinance.pdf`**
   - **시나리오**: OO시 개인형 이동장치(PM) 및 무인대여사업 규제 조례안 검토요청서
   - **주요 쟁점**: 도로교통법 위임 한계 일탈, 지방자치법 제28조(법률유보원칙) 위배, 과태료 상한 초과 부과, 대법원 판례(2019두51234) 저촉

### 웹 UI 테스트 절차
1. `http://localhost:3000`에 접속합니다.
2. 상단 칩에서 **[개인정보/보안]** 또는 **[조례/내규 충돌]**을 선택합니다.
3. 첨부파일 드롭존에 `test/docs/test_cctv_guideline.hwpx` 또는 `test/docs/test_mobility_ordinance.pdf` 파일을 드래그하여 업로드합니다.
4. **[종합 법령검토 실행]** 버튼을 누르면 AI 엔진이 분석을 수행하고 3단계 탭에 결과를 렌더링합니다.
5. 우측 상단의 **[보고서 스튜디오]**를 열어 생성된 의견서를 확인하고 **HWPX** 또는 **PDF** 버튼을 눌러 결과 파일을 다운로드합니다.

---

## 19대 법령 도구 목록

상단 헤더의 **[19대 법령 도구]** 버튼을 클릭하면 세부 법률 도구를 개별적으로 실행해 볼 수 있습니다:

| 도구명 | 기능 설명 |
|---|---|
| `searchLaw` | 국가법령정보센터 현행 법령 키워드 검색 |
| `searchAiLaw` | 자연어 질의를 법률 전문용어로 확장하여 법령 추론 검색 |
| `articleDetail` | 특정 법령의 특정 조문 전문 및 항/호 목록 상세 조회 |
| `articleAt` | 특정 조문의 항/호/목 핀포인트 정밀 추출 |
| `articleDiff` | 구 조문과 신 조문 텍스트 간 단어 단위 추가/삭제 Diff 비교 |
| `lawHistory` | 법령 제정/개정 이력 및 시행일자 타임라인 조회 |
| `lawStructure` | 법령의 편-장-절-조문 계층적 목차 구조 조회 |
| `delegatedLaws` | 상위 법률 → 대통령령(시행령) → 부령(시행규칙) 위임 체계 추적 |
| `linkedOrdinances`| 법령의 위임에 따른 지자체 조례/자치법규 목록 검색 |
| `annexes` | 법령에 딸린 별표, 서식, 과태료 기준표 목록 및 다운로드 링크 |
| `precedents` | 쟁점 및 조문 관련 대법원/하급심 판례 요지 검색 |
| `interpretations`| 법제처 및 관계부처 공식 법령해석례/질의회신 검색 |
| `adminRules` | 소관부처의 훈령, 예규, 고시 등 행정규칙 검색 |
| `decisions` | 헌법재판소 결정례 및 중앙행정심판위원회 재결례 검색 |
| `impactMap` | 내부 규정 텍스트와 상위 법령 간 충돌/규제 영향도 매핑 |
| `timeTravel` | 과거 특정 시점(연월일)에 유효했던 과거 법령 조문 재현 |
| `verifyCitations` | 문서 내 인용된 조문의 현행 실존 여부 및 삭제 여부 검증 |

---

## 자동화 테스트 실행

단위 및 통합 테스트를 실행하여 모든 모듈의 무결성을 검증할 수 있습니다:
```bash
npm test
```
- HWPX, PDF, DOCX 파일 생성 및 파싱 무결성 검증
- 조문 인용 파서, 법률용어 지식베이스 확장, 조문 Diff 엔진 검증
- 19대 도구 러너 및 API 엔드포인트 통합 검증

---

## 프로젝트 디렉토리 구조

```text
legal_review/
├── .env.example                     # 환경변수 템플릿
├── .env                             # 로컬 환경변수 파일
├── package.json                     # 의존성 정의
├── run.bat                          # Windows 원클릭 실행 배치 파일
├── run.sh                           # Linux/macOS 실행 쉘 스크립트
├── README.md                        # 프로젝트 매뉴얼
├── server/
│   ├── index.js                     # 메인 Express 서버 엔트리포인트
│   ├── env.js                       # 환경변수 로더
│   ├── abort.js                     # 비동기 요청 취소 컨트롤러
│   ├── rateLimit.js                 # API Rate Limiter
│   ├── parsers/                     # 첨부문서 파서 (HWPX, PDF, DOCX, XLSX)
│   ├── law/                         # 법령 검토 핵심 엔진
│   │   ├── lawApi.js                # Express 라우터 (/api/law)
│   │   ├── lawApiClient.js          # law.go.kr DRF API 클라이언트
│   │   ├── decisionsApiClient.js    # 판례/해석례 API 클라이언트
│   │   ├── lawWorkbench.js          # 워크벤치 오케스트레이터
│   │   ├── lawWorkbenchReview.js    # LLM 10대 검토 추론 엔진
│   │   ├── lawCache.js              # SQLite 기반 2계층 캐시
│   │   └── tools/                   # 19대 세부 법령 도구 모음
│   └── export/                      # 보고서 생성기 (HWPX, DOCX, PDF, MD)
├── public/                          # 프론트엔드 UI (Vanilla JS & Modern CSS)
│   ├── index.html
│   ├── css/ (main.css, workbench.css, studio.css)
│   └── js/  (app.js, state.js, lawWorkbench.js, documentStudio.js, documentViewer.js)
└── test/                            # 테스트 스위트 및 샘플 문서
    ├── docs/                        # 테스트용 샘플 파일 (test_cctv_guideline.hwpx 등)
    ├── lawApi.test.js
    ├── export.test.js
    └── parsers.test.js
```

---

## 라이선스
MIT License
