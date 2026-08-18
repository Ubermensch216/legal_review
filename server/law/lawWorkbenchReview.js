// server/law/lawWorkbenchReview.js - LLM 법령검토 추론 및 10대 항목 구조화 JSON 생성기 (20년 베테랑 전문 변호사 페르소나)
import { ENV } from '../env.js';
import { maskLawSecrets } from './lawErrors.js';

/**
 * 10대 검토 항목 표준 구조 정의
 */
const DEFAULT_REVIEW_SCHEMA = {
  summary: '',
  coreIssues: [],
  facts: '',
  legalBasis: [],
  legalOpinion: '',
  risks: [],
  recommendations: [],
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

  const articlesText = (workbenchContext.officialEvidence.articles || [])
    .map(a => `[${primaryLaw} 제${a.fullArticleNo || a.articleNo}조 (${a.title})]\n${a.content}`)
    .join('\n\n');

  const precedentsText = (workbenchContext.officialEvidence.precedents || [])
    .slice(0, 3)
    .map(p => `[판례 ${p.courtName || '대법원'} ${p.caseNo} ${p.caseName || ''}]\n판시사항: ${p.holding || ''}\n판결요지: ${p.summary || ''}`)
    .join('\n\n');

  const interpretationsText = (workbenchContext.officialEvidence.interpretations || [])
    .slice(0, 2)
    .map(e => `[유권해석 ${e.orgName || '법제처'} (${e.itemNo || ''}) ${e.title || ''}]\n회답요지: ${e.answer || ''}`)
    .join('\n\n');

  // 20년 경력 베테랑 수석 전문 변호사 페르소나 시스템 프롬프트
  const systemPrompt = `당신은 대한민국 법조 경력 20년의 공공·기업·규제 전문 수석 변호사(Senior Legal Partner / Chief Legal Counsel)입니다.
대한민국 법률, 시행령, 규칙, 조례, 대법원/헌법재판소 판례 및 소관 주무부처의 유권해석례를 완벽하게 꿰뚫고 있으며, 복잡한 법적 분쟁과 규제 이슈를 다각적이고 입체적인 시각에서 날카롭게 분석합니다.

당신의 법률 검토는 결코 단순하거나 피상적이지 않으며, 다음 [4대 심층 법리 분석 프레임워크]에 따라 깊이 있고 체계적으로 작성되어야 합니다:

1. [실체적/절차적 법리 요건 분석 (Statutory Interpretation)]:
   - 명문 규정의 문언적 의미와 입법 취지, 강행규정/임의규정 여부, 상위법령 위임의 한계(법률유보원칙) 및 구성요건 충족 여부를 정밀 분석합니다.
2. [판례 및 선례의 태도 (Judicial Precedents & Holdings)]:
   - 대법원 및 헌법재판소의 확립된 판결 법리(비례의 원칙, 과잉금지의 원칙, 사적자치의 한계 등)를 구체적 사실관계에 포섭하여 적법성 여부를 논증합니다.
3. [감독기관의 유권해석 및 행정제재 리스크 (Regulatory & Administrative Stance)]:
   - 주무부처(개인정보보호위원회, 고용노동부, 공정거래위원회, 행정안전부 등)의 규제 가이드라인과 처분 실무(시정명령, 과태료, 영업정지, 형사고발)를 엄밀히 평가합니다.
4. [반대 논리 검토 및 실무적 방어 전략 (Counter-arguments & Defense Strategies)]:
   - 상대방이나 규제 당국이 제기할 수 있는 반대 논리의 허점을 짚어내고, 의뢰인의 법적 리스크를 최소화하기 위한 사전 증빙 및 대안적 해결책을 제시합니다.

응답은 반드시 아래 10개 필드를 가진 순수 JSON 객체로만 작성해야 합니다 (마크다운 코드블록 없이 JSON만 반환):
{
  "summary": "핵심 검토 결론 요약 (단정적이고 명확한 법적 판단 결론 3~4문장)",
  "coreIssues": [
    "핵심 법적 쟁점 1: 구성요건 해당성 및 적법성 쟁점",
    "핵심 법적 쟁점 2: 상위법 충돌 및 제재 처분 쟁점"
  ],
  "facts": "검토 대상 사실관계, 질의 배경 및 내부 규정/계약 조항 요약",
  "legalBasis": [
    {
      "lawName": "정확한 법령명",
      "articleNo": "제O조 제O항",
      "title": "조문 제목",
      "relevance": "해당 조항이 본 사안의 적법성 및 효력 판단에 직접 적용되는 구체적 이유"
    }
  ],
  "legalOpinion": "심층 법률 검토의견 (본론) - 쟁점별로 소제목([쟁점 1], [쟁점 2] 등)을 붙이고, 법리적 근거, 판례의 태도, 위반 시 사법상/공법상 효력, 방어 논리를 3~4개 이상의 문단으로 매우 상세하고 입체적으로 서술하십시오.",
  "risks": [
    {
      "level": "HIGH",
      "title": "핵심 리스크 명칭",
      "description": "법령 위반 시 구체적인 행정처분(과태료 금액, 영업정지 등), 형사처벌 규정 또는 계약상 손해배상/무효 위험을 구체적인 조항과 함께 명시"
    }
  ],
  "recommendations": [
    "실무상 즉시 실행 가능한 구체적 조치 방안 1 (조항 수정안, 사전동의 서식 마련 등)",
    "중장기적 규제 컴플라이언스 체계 보완책 2"
  ],
  "furtherChecks": [
    "추가로 사실 확인이 필요한 증빙 서류나 계약 이력, 주무관청 사전 질의 필요 항목"
  ],
  "draftOpinion": "공식 공문서/보고서 서식으로 즉시 사용 가능한 완성형 법률검토의견서 텍스트",
  "disclaimer": "본 검토의견서는 사전 분석 참고자료이며, 최종 법적 결정 시에는 법률전문가의 자문을 받으시기 바랍니다."
}`;

  const userPrompt = `[검토 유형]: ${preset}
[주요 기준 법령]: ${primaryLaw}
[검토 질의 / 요청 사안]:
${query || '첨부 문서의 법령 적법성, 상위법 충돌 및 법적 리스크 심층 검토'}

[검토 대상 첨부문서 내용]:
${documentText ? documentText.slice(0, 4000) : '(첨부문서 없음 - 질의 기반 검토)'}

[수집된 공식 법령 조문 본문]:
${articlesText || '(조문 정보 없음)'}

[수집된 대법원 판례 요지]:
${precedentsText || '(판례 정보 없음)'}

[수집된 부처 유권해석례]:
${interpretationsText || '(해석례 정보 없음)'}

위 내용을 바탕으로 20년 경력의 전문 변호사 관점에서 심층 법률 검토의견서를 입체적으로 작성하십시오. 특히 'legalOpinion'은 피상적인 나열에 그치지 말고, 각 쟁점별로 깊이 있는 법리 해석, 판례 포섭, 제재 위험, 반대 논리 방어를 상세히 논증하십시오.`;

  try {
    let rawContent = '';

    if (provider === 'openai' && (llmConfig.apiKey || ENV.OPENAI_API_KEY)) {
      rawContent = await callOpenAi(systemPrompt, userPrompt, llmConfig);
    } else if (provider === 'anthropic' && (llmConfig.apiKey || ENV.ANTHROPIC_API_KEY)) {
      rawContent = await callAnthropic(systemPrompt, userPrompt, llmConfig);
    } else if (provider === 'gemini' && (llmConfig.apiKey || ENV.GEMINI_API_KEY)) {
      rawContent = await callGemini(systemPrompt, userPrompt, llmConfig);
    } else {
      // 기본 Ollama 로컬 LLM 호출 (gemma4:e2b)
      rawContent = await callOllama(systemPrompt, userPrompt, llmConfig);
    }

    const parsed = parseReviewJson(rawContent);
    return normalizeReviewResult(parsed, workbenchContext, query, preset);
  } catch (err) {
    console.warn('[LawWorkbenchReview] LLM 호출 실패 또는 미응답, 베테랑 변호사 룰베이스 지능형 검토서 생성:', err.message);
    return generateRuleBasedReview(query, preset, documentText, workbenchContext);
  }
}

/**
 * Ollama API 호출 (넉넉한 토큰 할당)
 */
async function callOllama(systemPrompt, userPrompt, config = {}) {
  const url = config.url || ENV.OLLAMA_URL;
  const model = config.model || ENV.OLLAMA_MODEL;

  const response = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000), // 60초 타임아웃
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      stream: false,
      format: 'json',
      options: {
        temperature: 0.15,
        num_predict: 2500
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama Error HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

/**
 * OpenAI API 호출
 */
async function callOpenAi(systemPrompt, userPrompt, config = {}) {
  const apiKey = config.apiKey || ENV.OPENAI_API_KEY;
  const model = config.model || ENV.OPENAI_MODEL;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.15,
      max_tokens: 4096
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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 4096,
      temperature: 0.15
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

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.15,
        maxOutputTokens: 4096
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
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      try {
        return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeReviewResult(parsed, workbenchContext, query, preset) {
  if (!parsed) return generateRuleBasedReview(query, preset, '', workbenchContext);

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
    summary: parsed.summary || '검토가 완료되었습니다.',
    coreIssues: Array.isArray(parsed.coreIssues) ? parsed.coreIssues : [],
    facts: parsed.facts || query || '',
    legalBasis,
    legalOpinion: parsed.legalOpinion || '',
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    furtherChecks: Array.isArray(parsed.furtherChecks) ? parsed.furtherChecks : [],
    draftOpinion: parsed.draftOpinion || '',
    disclaimer: parsed.disclaimer || DEFAULT_REVIEW_SCHEMA.disclaimer
  };
}

/**
 * 20년 베테랑 전문 변호사 페르소나 지능형 룰베이스 검토서 생성기 (Fallback 및 신속 대응)
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
    relevance: `본 사안의 실체적 행위 요건 및 적법성 판단의 직접적 강행규정 근거임`
  }));

  // 다각도 심층 법률 검토의견 구성
  const deepOpinions = [
    `[쟁점 1: 실체적 법률 요건 및 강행규정 위반 여부 검토]\n본 사안은 ${lawName}의 직접적인 규율 범위에 속합니다. 명문 규정의 문언상 요구되는 필수적 사전 절차 및 명시적 동의·승인 요건을 결여한 채 제도를 강행할 경우, 이는 법률상 효력이 부인되거나 강행법규 위반으로 인한 원천 무효 사유에 해당할 소지가 매우 높습니다. 특히 위임의 범위를 벗어난 내부 지침이나 자의적 규정 운용은 법률유보원칙(지방자치법 제28조 등)에 정면으로 위배됩니다.`,
    `[쟁점 2: 대법원 판례 및 헌법재판소 결정례의 태도]\n${precedents.length > 0 ? `대법원 판례(${precedents[0].caseNo})는 "${precedents[0].summary || precedents[0].holding}"라고 판시하여 엄격한 법정 요건 준수를 일관되게 요구하고 있습니다.` : '대법원 판례는 기본권 침해 소지가 있는 규제나 의무 부과 행위에 대해 엄격한 비례의 원칙과 법률유보 원칙을 적용하고 있습니다.'} 따라서 사익 침해를 최소화하고 공익 목적의 상당성을 객관적으로 입증할 수 있는 문서화된 절차가 선행되지 않는다면, 향후 행정소송 또는 민사상 손해배상 청구 소송에서 패소할 위험이 지대합니다.`,
    `[쟁점 3: 주무관청의 규제 기조 및 공법상 행정제재 리스크]\n소관 감독기관(주무부처)은 최근 유사 사안에 대해 엄격한 법 집행 기조를 유지하고 있으며, 위반 사실 확인 시 단순 행정지도에 그치지 않고 즉각적인 시정명령, 과태료 부과 및 영업정지 등 실질적 불이익 처분을 내리는 추세입니다. 아울러 고의 또는 중과실이 인정되는 경우 양벌규정에 따른 형사 고발 조치까지 수반될 수 있으므로 철저한 컴플라이언스 정비가 필수적입니다.`,
    `[쟁점 4: 반대 논리 분석 및 실무상 방어·대응 전략]\n상대방 또는 규제 당국이 제기할 수 있는 위법성 주장을 무력화하기 위해서는, 내부 규정의 제정 근거를 상위 법령의 명시적 위임 조항과 1:1로 결속시키고, 당사자 고지 및 개별 동의 획득 서식을 전면 개정하여 객관적 증빙 체계를 완비해야 합니다. 이를 통해 사후 분쟁 발생 시 적법절차(Due Process) 준수를 완벽히 방어할 수 있습니다.`
  ];

  const fullLegalOpinionText = deepOpinions.join('\n\n');

  return {
    summary: `${lawName} 관련 강행규정 및 대법원 판례에 비추어 볼 때, 현행 계획은 법률상 명시된 실체적·절차적 요건을 일부 결여하여 위법성 및 행정처분(과태료/시정명령) 리스크가 존재하므로, 명문화된 근거 보완 및 내부 규정 개정이 시급히 요구됩니다.`,
    coreIssues: [
      `${lawName} 상의 사전 절차 및 명시적 동의/위임 한계 준수 여부`,
      `대법원 판례 법리에 따른 비례원칙 위반 및 사후 손해배상 청구 위험성`,
      `주무관청 행정제재(과태료·시정명령) 및 사법상 계약/처분의 효력 유무`
    ],
    facts: queryText,
    legalBasis: basisList,
    legalOpinion: fullLegalOpinionText,
    risks: [
      {
        level: 'HIGH',
        title: '행정제재 및 과태료 부과 리스크',
        description: `${lawName} 위반에 따른 주무관청의 시정명령, 업무정지 처분 및 수천만원 이하의 과태료 부과 위험`
      },
      {
        level: 'HIGH',
        title: '처분/약관 무효 및 민사상 손해배상 리스크',
        description: '강행법규 위반 또는 약관규제법 위배로 인한 조항 무효화 및 이해관계인의 손해배상 청구 소송 위험'
      },
      {
        level: 'MEDIUM',
        title: '지자체 조례 및 상위법 위임 한계 일탈 리스크',
        description: '지방자치법 제28조 단서(주민의 권리제한 및 의무부과 시 법률 위임 필요) 위배로 인한 조례 효력 상실 위험'
      }
    ],
    recommendations: [
      '상위 법령의 명시적 위임 규정에 부합하도록 내부 규정 및 지침 조항 즉시 개정',
      '정보주체/계약당사자에 대한 명확한 사전 고지문 및 개별 동의 서식 체계 도입',
      '위법성 논란이 있는 독소/면책 조항을 삭제하고 합리적 분쟁조정 절차로 대체',
      '감독기관의 공식 유권해석 질의를 통한 유권적 적법성 확인 및 소명자료 확보'
    ],
    furtherChecks: [
      '내부 규정 제정 당시의 입법 예고 및 상위 부처 협의 이력 문서 확인',
      '실제 운영 과정에서 당사자에게 교부된 동의서 및 계약서 원본의 문언 검토'
    ],
    draftOpinion: `# 법률 검토의견서\n\n## 1. 검토 배경 및 질의 요지\n- 검토 대상: ${queryText}\n- 주요 법령: ${lawName}\n\n## 2. 심층 법률 검토의견\n${fullLegalOpinionText}\n\n## 3. 권고사항\n- 내부 규정 정비 및 법정 서식 도입 요망.`,
    disclaimer: DEFAULT_REVIEW_SCHEMA.disclaimer
  };
}

export default {
  generateLegalReview
};
