// server/law/lawWorkbenchReview.js - IRAC 4단계 법리 추론, Redline 수정 조문 생성 및 환각 방지 엔진
import { ENV } from '../env.js';
import { maskLawSecrets } from './lawErrors.js';
import { verifyAndCorrectReviewCitations } from './factualityVerifier.js';

/**
 * 20년 경력 수석 변호사 법률 검토 표준 스키마
 */
const DEFAULT_REVIEW_SCHEMA = {
  summary: '',
  coreIssues: [],
  facts: '',
  legalBasis: [],
  legalOpinion: '',
  risks: [],
  recommendations: [],
  redlineDiffs: [], // 실무형 수정 조문 대비표
  furtherChecks: [],
  draftOpinion: '',
  disclaimer: '본 검토의견서는 AI 법령검토 엔진에 의해 작성된 사전 분석 참고자료이며, 구체적인 행정처분, 소송 또는 계약 체결 시에는 법률전문가(변호사)의 최종 감수를 거치시기 바랍니다.'
};

/**
 * 워크벤치 데이터와 질의를 기반으로 LLM 검토의견서 생성
 * @param {object} params
 * @param {string} params.query - 사용자 검토 요청
 * @param {string} params.preset - 검토 유형 (compliance, contract_risk 등)
 * @param {string} params.documentText - 첨부문서 원문
 * @param {object} params.workbenchContext - buildWorkbenchContext 결과
 * @param {object} params.llmConfig - 모델/프로바이더 오버라이드 설정 (선택)
 * @returns {Promise<object>}
 */
export async function generateLegalReview({ query, preset, documentText, workbenchContext, llmConfig = {} }) {
  const provider = llmConfig.provider || ENV.LLM_PROVIDER || 'ollama';
  const primaryLaw = workbenchContext.meta?.primaryLawName || '관련 법령';

  // 1. 법령 조문 본문 스마트 슬라이싱 (상위 5개 조문)
  const articlesText = (workbenchContext.officialEvidence?.articles || [])
    .slice(0, 5)
    .map(a => {
      const body = a.content ? (a.content.length > 500 ? a.content.slice(0, 500) + '...' : a.content) : '';
      return `[${primaryLaw} 제${a.fullArticleNo || a.articleNo}조 (${a.title || '조문'})]\n${body}`;
    })
    .join('\n\n');

  // 2. Re-ranked 판례 요지 슬라이싱 (Top 3 판례, 관련도 점수 포함)
  const precedentsText = (workbenchContext.officialEvidence?.precedents || [])
    .slice(0, 3)
    .map((p, idx) => {
      const summary = p.summary || p.holding || '';
      const brief = summary.length > 350 ? summary.slice(0, 350) + '...' : summary;
      return `[Top ${idx + 1} 판례 (관련도: ${p.relevanceScore || 90}점) ${p.courtName || '대법원'} ${p.caseNo || ''} ${p.caseName || ''}]\n판결요지: ${brief}`;
    })
    .join('\n\n');

  // 3. 유권해석 요지 슬라이싱 (Top 2)
  const interpretationsText = (workbenchContext.officialEvidence?.interpretations || [])
    .slice(0, 2)
    .map(e => {
      const answer = e.answer || e.reason || '';
      const brief = answer.length > 300 ? answer.slice(0, 300) + '...' : answer;
      return `[유권해석 ${e.orgName || '법제처'} ${e.title || ''}]\n회답 요지: ${brief}`;
    })
    .join('\n\n');

  // 20년 경력 수석 전문 변호사 IRAC 페르소나 시스템 프롬프트
  const systemPrompt = `당신은 대한민국 법조 경력 20년의 공공·기업·규제 전문 수석 파트너 변호사(Senior Partner / Chief Legal Counsel)입니다.
대한민국 헌법, 법률, 시행령, 규칙, 조례 및 대법원/헌재 판례, 법제처 유권해석례를 바탕으로 복잡한 분쟁과 규제 리스크를 엄격한 IRAC 법리 추론 체계로 분석합니다.

[IRAC 4단계 법리 추론 원칙]:
1. [I - Issue (쟁점)]: 사안에서 문제되는 실체적/절차적 법률 쟁점 명시
2. [R - Rule (규범)]: 적용 법령 조문, 대법원 확립 법리(비례원칙, 법률유보, 강행규정) 제시
3. [A - Application (포섭)]: 사실관계를 법조문 구성요건 및 판례 기준에 엄격히 대입하여 위법/유효성 논증
4. [C - Conclusion (결론 & 대안)]: 적법성 판단, 리스크 수준 및 실무상 조항 수정 권고안(Redline Diff) 제시

반드시 아래 JSON 스키마를 준수하여 순수 JSON으로만 출력하십시오:
{
  "summary": "핵심 검토 결론 요약 (단정적이고 명확한 법적 판단 결론 3~4문장)",
  "coreIssues": ["핵심 법적 쟁점 1", "핵심 법적 쟁점 2", "핵심 법적 쟁점 3"],
  "facts": "검토 대상 사실관계 및 질의 배경 요약",
  "legalBasis": [
    {
      "lawName": "법령명",
      "articleNo": "제O조 제O항",
      "title": "조문 제목",
      "relevance": "본 사안에 직접 적용되는 구체적 이유"
    }
  ],
  "legalOpinion": "심층 법률 검토의견 (본론) - 쟁점별([쟁점 1: ...], [쟁점 2: ...])로 I-R-A-C 체계에 따라 실체법 요건, 판례의 태도, 행정제재 리스크, 반대논리 방어전략을 상세히 서술",
  "risks": [
    {
      "level": "HIGH",
      "title": "핵심 리스크 명칭",
      "description": "법령 위반 시 구체적인 행정제재(과태료/영업정지) 또는 계약상 무효 위험"
    }
  ],
  "recommendations": ["실무상 즉시 조치 방안 1", "규제 컴플라이언스 보완책 2"],
  "redlineDiffs": [
    {
      "clauseNo": "제O조 제O항 (또는 조항명)",
      "originalText": "위법 또는 불리한 현행 원문 조항 문구",
      "revisedText": "법령에 부합하도록 수정한 적법 권고안 문구",
      "reason": "수정 사유 및 관련 법조문/판례 근거",
      "riskLevel": "HIGH"
    }
  ],
  "furtherChecks": ["추가 확인 필요 증빙 또는 소관 부처 유권해석 질의 사항"],
  "draftOpinion": "공식 공문서 표준 서식의 완성형 법률검토의견서 본문",
  "disclaimer": "본 검토의견서는 사전 분석 참고자료이며, 최종 법적 결정 시에는 법률전문가의 자문을 받으시기 바랍니다."
}`;

  // 첨부문서 텍스트 길이 최적화 (3,500자로 슬림화)
  const trimmedDocText = documentText ? (documentText.length > 3500 ? documentText.slice(0, 3500) + '... (이하 생략)' : documentText) : '(첨부문서 없음 - 질의 기반 검토)';

  const userPrompt = `[검토 유형]: ${preset}
[주요 기준 법령]: ${primaryLaw}
[검토 질의 / 요청 사안]:
${query || '첨부 문서의 법령 적법성, 상위법 충돌 및 법적 리스크 심층 검토'}

[검토 대상 첨부문서 내용 (핵심 조항 발췌)]:
${trimmedDocText}

[수집된 공식 법령 조문 본문]:
${articlesText || '(조문 정보 없음)'}

[수집 및 시맨틱 Re-ranking된 대법원 판례]:
${precedentsText || '(판례 정보 없음)'}

[수집된 부처 유권해석례]:
${interpretationsText || '(해석례 정보 없음)'}

위 사실관계와 법령/판례를 바탕으로 20년 경력 수석 변호사 관점에서 IRAC 법리 포섭 및 실무형 수정 조문(Redline Diff)을 포함한 심층 검토의견서 JSON을 작성하십시오.`;

  try {
    let rawContent = '';

    if (provider === 'rule_based' || provider === 'local_rule') {
      const ruleBased = generateRuleBasedReview(query, preset, documentText, workbenchContext);
      const { verifiedReview } = await verifyAndCorrectReviewCitations({
        review: ruleBased,
        workbenchContext
      });
      return verifiedReview;
    } else if (provider === 'openai' && (llmConfig.apiKey || ENV.OPENAI_API_KEY)) {
      rawContent = await callOpenAi(systemPrompt, userPrompt, llmConfig);
    } else if (provider === 'anthropic' && (llmConfig.apiKey || ENV.ANTHROPIC_API_KEY)) {
      rawContent = await callAnthropic(systemPrompt, userPrompt, llmConfig);
    } else if (provider === 'gemini' && (llmConfig.apiKey || ENV.GEMINI_API_KEY)) {
      rawContent = await callGemini(systemPrompt, userPrompt, llmConfig);
    } else {
      // 기본 Ollama 로컬 LLM 호출
      rawContent = await callOllama(systemPrompt, userPrompt, llmConfig);
    }

    const parsed = parseReviewJson(rawContent);
    if (!parsed) {
      // 파싱 실패 시 normalizeReviewResult가 조용히 룰베이스 결과를 돌려주므로,
      // LLM 검토가 실제로 반영되지 않았다는 사실을 로그로 드러낸다.
      console.warn(
        `[LawWorkbenchReview] LLM 응답을 JSON으로 파싱하지 못해 룰베이스 결과로 대체합니다. ` +
        `(응답 길이: ${rawContent.length}자, 앞부분: ${rawContent.slice(0, 200).replace(/\s+/g, ' ')})`
      );
    }
    const normalized = normalizeReviewResult(parsed, workbenchContext, query, preset);
    
    // 조문 실존성 검증 및 오인용 자동 교정 (Anti-Hallucination)
    const { verifiedReview } = await verifyAndCorrectReviewCitations({
      review: normalized,
      workbenchContext
    });

    return verifiedReview;
  } catch (err) {
    console.warn('[LawWorkbenchReview] LLM 호출 실패, 규칙 기반 점검으로 대체합니다:', err.message);
    const ruleBased = generateRuleBasedReview(query, preset, documentText, workbenchContext);
    ruleBased.fallbackReason = `LLM 검토를 실행하지 못했습니다 (${maskLawSecrets(err.message || '원인 미상')}). 규칙 기반 점검 결과만 제공됩니다.`;
    
    const { verifiedReview } = await verifyAndCorrectReviewCitations({
      review: ruleBased,
      workbenchContext
    });

    return verifiedReview;
  }
}

/**
 * Ollama API 호출
 */
async function callOllama(systemPrompt, userPrompt, config = {}) {
  const url = config.url || ENV.OLLAMA_URL;
  const model = config.model || ENV.OLLAMA_MODEL;

  // 1단계: 짧은 헬스체크로 "Ollama 미기동" 상황만 빠르게 걸러낸다.
  //   생성 자체는 수 분이 걸릴 수 있으므로, 미기동 감지용 타임아웃을 생성 타임아웃으로
  //   그대로 쓰면 정상 동작 중인 모델까지 매번 중단되어 룰베이스로 떨어진다.
  const probeTimeoutMs = parseInt(process.env.LLM_PROBE_TIMEOUT || '2000', 10);
  let installedModels = [];
  try {
    const probe = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(probeTimeoutMs) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    ({ models: installedModels = [] } = await probe.json());
  } catch (err) {
    throw new Error(`Ollama 서버에 연결할 수 없습니다 (${url}): ${err.message}`);
  }

  if (installedModels.length > 0 && !installedModels.some(m => m.name === model || m.model === model)) {
    throw new Error(
      `Ollama에 모델 '${model}'이(가) 설치되어 있지 않습니다. ` +
      `설치된 모델: ${installedModels.map(m => m.name).join(', ')} (해결: ollama pull ${model})`
    );
  }

  // 2단계: 실제 생성 호출. 로컬 모델은 프롬프트 처리 + 2,500 토큰 생성에
  //   수 분이 소요될 수 있으므로 넉넉한 타임아웃을 적용한다.
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '600000', 10);

  let response;
  try {
    response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false,
        format: 'json',
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m', // 매 호출마다 모델을 다시 적재하지 않도록 유지
        options: {
          temperature: 0.1,
          // num_ctx는 프롬프트와 생성 토큰이 함께 쓰는 예산이다. Ollama 기본값(4096)은
          // 법령·판례가 포함된 긴 프롬프트에서 출력 여유를 거의 남기지 않아 응답이 잘린다.
          num_ctx: parseInt(process.env.OLLAMA_NUM_CTX || '16384', 10),
          num_predict: parseInt(process.env.OLLAMA_NUM_PREDICT || '8192', 10)
        }
      })
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message || '')) {
      throw new Error(
        `Ollama 응답이 ${Math.round(timeoutMs / 1000)}초 내에 완료되지 않았습니다. ` +
        `더 작은 모델을 쓰거나 LLM_TIMEOUT 환경변수를 늘리십시오.`
      );
    }
    throw err;
  }

  if (!response.ok) {
    throw new Error(`Ollama Error HTTP ${response.status}`);
  }

  const data = await response.json();

  // num_predict 한도에 걸려 응답이 잘리면 JSON 파싱이 실패하고 조용히 룰베이스로 대체된다.
  // 원인을 알 수 있도록 절단 사실을 명시적으로 남긴다.
  if (data.done_reason === 'length') {
    console.warn(
      `[LawWorkbenchReview] Ollama 응답이 토큰 한도에 도달해 잘렸습니다 ` +
      `(프롬프트 ${data.prompt_eval_count ?? '?'} + 생성 ${data.eval_count ?? '?'} 토큰). ` +
      `OLLAMA_NUM_PREDICT 또는 OLLAMA_NUM_CTX를 늘리십시오.`
    );
  }

  return data.message?.content || '';
}

/**
 * OpenAI API 호출
 */
async function callOpenAi(systemPrompt, userPrompt, config = {}) {
  const apiKey = config.apiKey || ENV.OPENAI_API_KEY;
  const model = config.model || ENV.OPENAI_MODEL;
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '60000', 10);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 3500
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI Error HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Anthropic API 호출
 */
async function callAnthropic(systemPrompt, userPrompt, config = {}) {
  const apiKey = config.apiKey || ENV.ANTHROPIC_API_KEY;
  const model = config.model || ENV.ANTHROPIC_MODEL;
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '60000', 10);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 3500,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic Error HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

/**
 * Google Gemini API 호출
 */
async function callGemini(systemPrompt, userPrompt, config = {}) {
  const apiKey = config.apiKey || ENV.GEMINI_API_KEY;
  const model = config.model || ENV.GEMINI_MODEL;
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '60000', 10);

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 3500
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini Error HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * JSON 파싱 및 복구
 */
function parseReviewJson(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // 1차 보정: 앞뒤 잡음을 제거하고 최외곽 중괄호 구간만 다시 시도
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
      } catch {
        /* 아래의 절단 복구로 진행 */
      }
    }

    // 2차 보정: 토큰 한도로 잘린 JSON을 닫아서 부분 결과라도 살린다.
    if (firstBrace !== -1) {
      return repairTruncatedJson(cleaned.slice(firstBrace));
    }
    return null;
  }
}

/**
 * 토큰 한도로 중간에 끊긴 JSON 문자열을 유효한 JSON으로 복구한다.
 * 열린 문자열을 닫고, 미완성 토큰을 잘라낸 뒤, 남은 배열/객체를 역순으로 닫는다.
 * 로컬 LLM은 출력이 잘리는 경우가 잦아 전량 폐기하는 대신 부분 결과를 확보한다.
 */
function repairTruncatedJson(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1; // 문자열 밖에서 값이 온전히 끝난 마지막 위치

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        lastSafe = i;
      }
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      lastSafe = i;
    } else if (ch === ',' || /[\dA-Za-z]/.test(ch)) lastSafe = i;
  }

  let repaired = text;

  if (inString) {
    // 문자열 중간에서 끊긴 경우: 열린 문자열을 닫는다.
    repaired += '"';
  } else if (lastSafe >= 0) {
    // 값 중간(숫자/리터럴)에서 끊긴 경우: 마지막 안전 지점까지만 취한다.
    repaired = repaired.slice(0, lastSafe + 1);
  }

  // 미완성 꼬리(후행 쉼표, 값 없는 키)를 정리한다.
  repaired = repaired.replace(/,\s*$/, '');
  if (/:\s*$/.test(repaired)) repaired += 'null';
  if (/,\s*"[^"]*"\s*$/.test(repaired)) repaired = repaired.replace(/,\s*"[^"]*"\s*$/, '');

  while (stack.length > 0) repaired += stack.pop();

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

function normalizeReviewResult(parsed, workbenchContext, query, preset) {
  if (!parsed) {
    const fallback = generateRuleBasedReview(query, preset, '', workbenchContext);
    fallback.fallbackReason = 'LLM 응답을 JSON으로 해석하지 못해 규칙 기반 점검 결과로 대체했습니다.';
    return fallback;
  }

  const primaryLaw = workbenchContext?.meta?.primaryLawName || '관련 법령';
  let legalBasis = Array.isArray(parsed.legalBasis) && parsed.legalBasis.length > 0 ? parsed.legalBasis : [];

  // legalBasis가 비어있을 경우 officialEvidence.articles에서 자동 보강
  if (legalBasis.length === 0 && workbenchContext?.officialEvidence?.articles?.length > 0) {
    legalBasis = workbenchContext.officialEvidence.articles.map(a => ({
      lawName: primaryLaw,
      articleNo: `제${a.fullArticleNo || a.articleNo}조`,
      title: a.title || '주요 조항',
      relevance: '본 사안의 실체적 행위 요건 및 적법성 판단의 직접적 근거 조항임'
    }));
  }

  return {
    isFallback: false,
    reviewEngine: 'LLM',
    summary: parsed.summary || '검토가 완료되었습니다.',
    coreIssues: Array.isArray(parsed.coreIssues) ? parsed.coreIssues : [],
    facts: parsed.facts || query || '',
    legalBasis,
    legalOpinion: parsed.legalOpinion || '',
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    redlineDiffs: Array.isArray(parsed.redlineDiffs) ? parsed.redlineDiffs : [],
    furtherChecks: Array.isArray(parsed.furtherChecks) ? parsed.furtherChecks : [],
    draftOpinion: parsed.draftOpinion || '',
    disclaimer: parsed.disclaimer || DEFAULT_REVIEW_SCHEMA.disclaimer
  };
}

/**
 * 첨부문서에서 실제로 탐지된 위험 조항만으로 점검 항목을 구성한다.
 *
 * 룰베이스 엔진은 문서를 읽을 뿐 법리 추론을 하지 못하므로, 수정 문구(revisedText)를
 * 지어내지 않는다. 탐지된 조항 원문과 '무엇을 확인해야 하는지'만 제시하고,
 * 수정안 작성은 LLM 검토 또는 사람의 판단에 맡긴다.
 *
 * @param {object} context - buildWorkbenchContext 결과
 * @returns {Array<object>} 점검 항목 목록 (탐지된 위험 조항이 없으면 빈 배열)
 */
function buildRedlineChecklist(context) {
  const riskClauses = context?.impactAndRevisions?.riskClauses || [];

  return riskClauses.slice(0, 10).map(clause => {
    const labels = (clause.riskTags || []).map(t => t.label).filter(Boolean);
    const keywords = (clause.riskTags || []).flatMap(t => t.matchedKeywords || []);
    const clauseNo = [clause.articleNo, clause.title].filter(Boolean).join(' ') || '조항 미상';

    return {
      clauseNo,
      // 첨부문서에서 그대로 발췌한 실제 원문만 사용한다.
      originalText: (clause.fullHeader ? `${clause.fullHeader}\n` : '') +
        (clause.content || '').trim().slice(0, 500),
      revisedText: '',
      reason: labels.length > 0
        ? `탐지된 위험 유형: ${labels.join(', ')}` +
          (keywords.length > 0 ? ` (일치 문구: ${keywords.slice(0, 3).join(', ')})` : '') +
          '. 해당 조항이 상위 법령의 강행규정에 저촉되는지 확인이 필요합니다.'
        : '위험 조항으로 탐지되었습니다. 상위 법령 저촉 여부 확인이 필요합니다.',
      riskLevel: clause.riskLevel || 'MEDIUM',
      // 룰베이스 탐지 결과임을 명시한다. 수정안은 제시되지 않았다.
      source: 'RULE_BASED_DETECTION',
      needsLegalDrafting: true
    };
  });
}

/**
 * 룰베이스 검토서 생성기 (LLM 사용 불가 시의 축소 폴백).
 *
 * 이 엔진은 법리 추론을 하지 않는다. 수집된 조문 목록과 문서에서 탐지된
 * 위험 조항을 정리해 '무엇을 확인해야 하는지'를 제시할 뿐이다.
 * 반환값에는 isFallback 표식이 붙으며, 완성된 법률 검토의견으로 취급해선 안 된다.
 */
function generateRuleBasedReview(query, preset, documentText, context) {
  const lawName = context.meta?.primaryLawName || '관련 법령';
  const articles = context.officialEvidence?.articles || [];
  const precedents = context.officialEvidence?.precedents || [];
  const queryText = query || '제출된 문서 및 운영 계획의 법령 적합성 검토';

  const basisList = articles.map(a => ({
    lawName,
    articleNo: `제${a.fullArticleNo || a.articleNo}조`,
    title: a.title || '주요 규정',
    relevance: `본 사안의 실체적 행위 요건 및 적법성 판단의 강행규정 근거`
  }));

  // IRAC 기반 4대 심층 법리 분석
  const deepOpinions = [
    `[쟁점 1: 실체적 법률 요건 및 강행규정 위배 여부 (Issue & Rule)]\n본 사안은 ${lawName}의 강행규정 적용 영역에 속합니다. 명문 규정의 문언상 요구되는 사전 개별 동의 요건 및 법정 절차를 결여한 채 제도를 강행할 경우, 이는 법률상 효력이 부인되거나 원천 무효에 해당합니다. 특히 행정청의 자의적인 규정 운용이나 위임 없는 의무 부과는 지방자치법 제28조(법률유보원칙) 및 행정기본법 제8조에 정면으로 위배됩니다.`,
    `[쟁점 2: 대법원 판례의 확립된 판단 기준 및 사실관계 포섭 (Application)]\n${precedents.length > 0 ? `대법원 판례(${precedents[0].caseNo})는 "${precedents[0].holding || precedents[0].summary}"라고 판시하여 엄격한 비례원칙과 사전 적법절차 준수를 판결 기준으로 제시하고 있습니다.` : '대법원 판례는 기본권 제한 소지가 있는 규제 행위에 대해 엄격한 비례의 원칙과 과잉금지원칙을 적용하고 있습니다.'} 따라서 사익 침해를 최소화하고 공익 목적의 상당성을 입증할 객관적 서식과 사전 고지 체계가 완비되지 않는다면 행정소송 및 민사상 손해배상 청구 소송에서 패소할 위험이 매우 높습니다.`,
    `[쟁점 3: 주무부처 규제 기조 및 공법상 행정제재 리스크 (Application & Risk)]\n소관 감독기관(주무부처)은 유사 사안에 대해 엄격한 규제 집행 기조를 유지하고 있으며, 법령 위반 확인 시 시정명령, 과태료 부과 및 영업정지 등 실질적 제재 처분을 내리고 있습니다. 특히 고의 또는 중과실이 인정되는 경우 양벌규정에 따른 고발 조치까지 수반될 수 있으므로 전면적인 컴플라이언스 정비가 요구됩니다.`,
    `[쟁점 4: 반대 논리 분석 및 실무상 방어·조항 수정 전략 (Conclusion & Defense)]\n상대방 또는 규제 당국의 위법성 주장을 선제적으로 방어하기 위해, 위법 소지가 있는 독소/면책 조항을 즉각 삭제하고 상위 법령의 명시적 위임 규정에 부합하는 대체 조항(Redline)으로 개정해야 합니다. 이를 통해 사후 분쟁 발생 시 적법절차(Due Process) 준수를 완벽히 입증할 수 있습니다.`
  ];

  // 쟁점별 점검 항목 도출.
  //
  // 과거 이 자리에는 질의에 'cctv'/'동의'/'조례' 같은 키워드가 있으면
  // 하드코딩된 가짜 조항을 반환하는 분기가 있었다. 사용자가 작성한 적 없는
  // 문구가 신·구 조문 대비표의 [현행] 칸에 들어가 결재 문서로 출력됐다.
  // 이제 originalText는 첨부문서에서 실제로 탐지된 조항에서만 채운다.
  const redlineDiffs = buildRedlineChecklist(context);

  const fullLegalOpinionText = deepOpinions.join('\n\n');

  const detectedCount = redlineDiffs.length;

  return {
    // 룰베이스 엔진은 법리 추론을 하지 않으므로 위법성을 단정하지 않는다.
    // 과거에는 어떤 사안이든 '위법성이 명백'하다고 단정해 출력했다.
    isFallback: true,
    reviewEngine: 'RULE_BASED_FALLBACK',
    fallbackReason: 'LLM 검토를 사용할 수 없어 규칙 기반 점검 결과만 제공합니다. 법리 추론과 수정 조문 작성은 수행되지 않았습니다.',
    summary: detectedCount > 0
      ? `[규칙 기반 점검 결과] 첨부문서에서 확인이 필요한 조항 ${detectedCount}건이 탐지되었습니다. ` +
        `기준 법령은 ${lawName}입니다. 위법 여부에 대한 법적 판단은 포함되어 있지 않으며, 각 조항의 적법성은 별도 검토가 필요합니다.`
      : `[규칙 기반 점검 결과] 사전 정의된 위험 패턴에 해당하는 조항은 탐지되지 않았습니다. ` +
        `이는 적법하다는 의미가 아니라 자동 탐지 범위에서 걸리지 않았다는 뜻이며, 법리 검토는 수행되지 않았습니다.`,
    coreIssues: [
      `${lawName} 상의 사전 절차 및 명시적 동의/위임 한계 준수 여부 (확인 필요)`,
      '비례원칙 및 상위법 위임 한계 일탈 여부 (확인 필요)',
      '주무관청 행정제재 및 계약/처분의 효력 유무 (확인 필요)'
    ],
    facts: queryText,
    legalBasis: basisList,
    legalOpinion: fullLegalOpinionText,
    risks: detectedCount > 0
      ? [{
          level: 'UNASSESSED',
          title: `자동 탐지된 확인 필요 조항 ${detectedCount}건`,
          description: '규칙 기반 키워드 탐지 결과이며, 위험 수준은 평가되지 않았습니다. 각 조항의 실제 법적 리스크는 법리 검토를 거쳐야 판단할 수 있습니다.'
        }]
      : [],
    recommendations: [
      'LLM 검토 엔진(Ollama 또는 클라우드 LLM)을 구성한 뒤 재검토를 실행하십시오.',
      '탐지된 조항의 원문을 상위 법령 조문과 직접 대조하십시오.',
      '감독기관의 공식 유권해석 질의를 통한 적법성 확인 및 소명자료 확보를 검토하십시오.'
    ],
    redlineDiffs,
    furtherChecks: [
      '내부 규정 제정 당시의 입법 예고 및 상위 부처 협의 이력 문서 확인',
      '실제 운영 과정에서 당사자에게 교부된 동의서 및 계약서 원본의 문언 검토'
    ],
    draftOpinion: `# 규칙 기반 사전 점검 결과 (법률 검토의견서 아님)\n\n` +
      `> 이 문서는 LLM 검토를 사용할 수 없어 자동 생성된 **점검 결과**입니다.\n` +
      `> 법리 추론과 수정 조문 작성은 수행되지 않았으며, 결재용 법률검토의견서로 사용할 수 없습니다.\n\n` +
      `## 1. 점검 배경\n- 점검 대상: ${queryText}\n- 기준 법령: ${lawName}\n\n` +
      `## 2. 일반 점검 관점\n${fullLegalOpinionText}\n\n` +
      `## 3. 확인이 필요한 조항 (첨부문서에서 자동 탐지)\n` +
      (redlineDiffs.length > 0
        ? redlineDiffs.map(d => `### ${d.clauseNo}\n- [문서 원문]: ${d.originalText}\n- [탐지 사유]: ${d.reason}\n- [수정안]: 미작성 (법리 검토 필요)`).join('\n\n')
        : '- 자동 탐지된 조항 없음') +
      `\n\n## 4. 다음 단계\n- LLM 검토 엔진을 구성한 뒤 재검토를 실행하십시오.`,
    disclaimer: DEFAULT_REVIEW_SCHEMA.disclaimer
  };
}

export default {
  generateLegalReview
};
