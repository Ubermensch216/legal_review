# ⚖️ Legal Reviewer (AI 법령검토 Standalone 솔루션)

**Legal Reviewer**는 국가법령정보센터(law.go.kr) 공식 Open API + 판례/결정례 API + 공공 첨부문서(HWPX/PDF/DOCX) 파싱 + LLM 추론 + 공공서식 보고서(HWPX/PDF/DOCX) 생성이 결합된 고성능 **독립형 AI 법령검토 워크벤치 솔루션**입니다.

---

## 🌟 주요 핵심 기능

1. **6대 법률 검토 프리셋**
   - 🛡 **적법성/규제 준수**: 사업 기획, 행정 절차, 인허가 요건 검토
   - 📑 **계약서 리스크**: 불공정 조항, 독소 조항, 손해배상 검토
   - 🏛 **조례/내규 상위법 충돌**: 지자체 조례안 및 공공기관 내규의 모법 저촉 검토
   - ⚖️ **행정처분/민원 대응**: 영업정지, 과태료 등 행정처분 적법성 및 행정심판 검토
   - 🔒 **개인정보/보안**: 개인정보보호법 상 수집·이용 동의 및 안전조치 의무 검토
   - 👥 **인사/노무/근로**: 근로계약, 취업규칙, 해고/징계, 주52시간제 검토

2. **3단계 전문 워크벤치 탭 구조**
   - **[1단계: 검토 초안]**: 3줄 요약, 핵심 쟁점, 리스크 매트릭스(High/Med/Low), 법률의견, 보완권고, 마크다운 초안
   - **[2단계: 공식 근거]**: 공식 법령 조문 전문, 3단 비교 체계, 대법원 판례, 법제처 유권해석례, 별표/서식, 자치법규
   - **[3단계: 개정/영향]**: 과거 법령 타임트래블, 내부 문서 조문 충돌 분석 및 삭제/폐지 조문 경고 신호등

3. **19대 세부 법령 도구 지원**
   - `searchLaw`, `searchAiLaw`, `articleDetail`, `articleAt`, `articleDiff`, `lawHistory`, `lawStructure`, `delegatedLaws`, `linkedOrdinances`, `annexes`, `precedents`, `interpretations`, `adminRules`, `decisions`, `impactMap`, `timeTravel`, `verifyCitations` 등

4. **멀티포맷 문서 파서 및 공공서식 보고서 생성**
   - **입력 파서**: HWPX, PDF, DOCX, XLSX, CSV, TXT, Markdown
   - **출력 익스포터**: HWPX (한글 2014 이상 호환 OCF 패키징), DOCX, PDF, Markdown

5. **하이브리드 AI 지원 (로컬 & 클라우드)**
   - **Ollama** (로컬 LLM - 보안 최우선): `qwen2.5`, `gemma4`, `llama3` 등
   - **클라우드 LLM**: OpenAI (GPT-4o), Anthropic (Claude 3.5 Sonnet), Google (Gemini)

---

## 🚀 빠른 시작 (Getting Started)

### 1. 요구 사항
- **Node.js**: v18.0.0 이상 (Node.js 22+ 권장, 내장 `node:sqlite` 지원)
- **(선택)** Ollama 로컬 LLM 서버 (http://localhost:11434)

### 2. 설치 및 실행
```bash
# 1. 의존성 패키지 설치
npm install

# 2. 서버 실행
npm start
# 또는 개발 모드 (자동 리로드)
npm run dev
```

Windows 사용자의 경우 **`run.bat`** 파일을 더블클릭하면 원클릭으로 구동됩니다.

브라우저에서 **`http://localhost:3000`** 으로 접속합니다.

---

## ⚙️ 환경 변수 설정 (`.env`)

`.env.example` 파일을 복사하여 `.env`를 생성하고 필요한 키를 설정할 수 있습니다. (설정 화면 UI에서도 직접 입력 가능)

```env
PORT=3000

# 1. 국가법령정보센터 오픈API 인증키 (https://open.law.go.kr)
LAW_OC=your_law_oc_id

# 2. LLM 프로바이더 ('ollama' | 'openai' | 'anthropic' | 'gemini')
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:14b

# 클라우드 API Key (선택)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

---

## 🧪 테스트 실행

```bash
npm test
```

- 단위/통합 테스트 (조문 정규식 파서, KB 확장, 조문 Diff, 19대 도구 러너, HWPX/PDF 생성 무결성 등)

---

## 📂 프로젝트 디렉토리 구조

```text
legal_review/
├── docs/                            # 기획 및 아키텍처 문서
├── server/
│   ├── index.js                     # 메인 Express 서버
│   ├── env.js                       # 환경변수 로더
│   ├── abort.js                     # 요청 취소 제어
│   ├── rateLimit.js                 # API Rate Limiter
│   ├── parsers/                     # HWPX, PDF, DOCX, XLSX 파서
│   ├── law/                         # 법령 검토 핵심 엔진
│   │   ├── lawApi.js                # Express API 라우터 (/api/law)
│   │   ├── lawApiClient.js          # law.go.kr DRF 연동 클라이언트
│   │   ├── lawApiParser.js          # 법령 XML/JSON 파서
│   │   ├── decisionsApiClient.js    # 판례/해석례 연동 클라이언트
│   │   ├── decisionsApiParser.js    # 판례 XML/JSON 파서
│   │   ├── lawWorkbench.js          # 워크벤치 오케스트레이터
│   │   ├── lawWorkbenchReview.js    # 10대 검토 JSON 생성 LLM 엔진
│   │   ├── lawTermKb.js             # 법률용어 지식베이스
│   │   ├── lawArticleRef.js         # 조문 인용 파서
│   │   ├── lawCache.js              # SQLite 기반 2계층 캐시
│   │   ├── lawConfig.js             # 설정 및 상수
│   │   ├── lawErrors.js             # 에러 핸들러 및 시크릿 마스킹
│   │   ├── lawDiff.js               # 조문 Diff 비교기
│   │   └── tools/                   # 19대 법령 도구 모음
│   └── export/                      # 공공서식 보고서 생성 엔진 (HWPX/DOCX/PDF)
├── public/                          # 프론트엔드 워크벤치 UI
│   ├── index.html
│   ├── css/ (main.css, workbench.css, studio.css)
│   └── js/  (app.js, state.js, lawWorkbench.js, documentStudio.js, documentViewer.js)
├── test/                            # 테스트 스위트
├── package.json
├── run.bat / run.sh
└── README.md
```
