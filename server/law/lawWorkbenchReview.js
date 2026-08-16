// server/law/lawWorkbenchReview.js - LLM 법령검토 추론 및 10대 항목 구조화 JSON 생성기
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
  disclaimer: '본 검토 의견서는 참고용이며, 구체적인 분쟁 또는 처분에 대해서는 법률전문가(변호사)의 최종 자문을 권장합니다.'
};

/**
 * 워크벤치 데이터와 질의를 기반으로 LLM 검토의견서 생성
 * @param {object} params
 * @param {string} params.query - 사용자 검토 요청
 * @param {string} params.preset - 검토 유형 (compliance, labor_hr 등)
 * @param {string} params.documentText - 첨부문서 원문
 * @param {object} params.workbenchContext - buildWorkbenchContext 결과
 * @param {object} params.llmConfig - 모델/프로바이더 오버라이드 설정 (선택)
 * @returns {Promise<object>}
 */
export async function generateLegalReview({ query, preset, documentText, workbenchContext, llmConfig = {} }) {
  const provider = llmConfig.provider || ENV.LLM_PROVIDER || 'ollama';
  const articlesText = (workbenchContext.officialEvidence.articles || [])
    .map(a => `[${workbenchContext.meta.primaryLawName || '관련법령'} 제${a.fullArticleNo}조 (${a.title})]\n${a.content}`)
    .join('\n\n');

  const precedentsText = (workbenchContext.officialEvidence.precedents || [])
    .slice(0, 3)
    .map(p => `[판례 ${p.caseNo} ${p.caseName}]\n판시사항: ${p.holding}\n판결요지: ${p.summary}`)
    .join('\n\n');

  const systemPrompt = `당신은 대한민국 최고 수준의 공공/기업 전문 법률 검토 AI 자문관입니다.
제공된 공식 법령 조문, 판례, 첨부문서 내용을 철저히 근거로 삼아 신뢰성 높고 정밀한 법률 검토의견서를 작성하십시오.

반드시 다음 10개 키를 포함하는 순수 JSON 형식으로만 응답해야 합니다. 마크다운 코드 블록(\`\`\`json)이나 다른 설명 없이 JSON만 출력하십시오:
{
  "summary": "검토 결론 요약 (3줄 이내 핵심 정리)",
  "coreIssues": ["핵심 법적 쟁점 1", "핵심 법적 쟁점 2"],
  "facts": "검토 대상 사실관계 및 질의 배경 요약",
  "legalBasis": [
    { "lawName": "법령명", "articleNo": "조문번호", "title": "조문제목", "relevance": "본 사안과의 관련성 설명" }
  ],
  "legalOpinion": "법률 검토 의견 본문 (쟁점별 심층 분석 및 법리 적용)",
  "risks": [
    { "level": "HIGH/MEDIUM/LOW", "title": "리스크명", "description": "위반 시 과태료, 처분, 형사책임 또는 계약 무효 리스크" }
  ],
  "recommendations": ["구체적인 보완 조치 및 권고사항 1", "보완사항 2"],
  "furtherChecks": ["추가로 확인이 필요한 사실관계 또는 입증자료"],
  "draftOpinion": "공식 공문서/보고서 서식으로 즉시 사용 가능한 완성형 법률검토의견서 마크다운 텍스트",
  "disclaimer": "법적 효력 한계 및 면책 고지문"
}`;

  const userPrompt = `[검토 유형]: ${preset}
[검토 질의 / 요청사항]:
${query || '첨부 문서의 법령 적법성 및 리스크 검토'}

[첨부 문서 내용]:
${documentText ? documentText.slice(0, 3000) : '(첨부문서 없음)'}

[수집된 공식 법령 조문]:
${articlesText || '(조문 정보 없음)'}

[수집된 판례 및 해석례]:
${precedentsText || '(판례 정보 없음)'}
`;

  try {
    let rawContent = '';

    if (provider === 'openai' && (llmConfig.apiKey || ENV.OPENAI_API_KEY)) {
      rawContent = await callOpenAi(systemPrompt, userPrompt, llmConfig);
    } else if (provider === 'anthropic' && (llmConfig.apiKey || ENV.ANTHROPIC_API_KEY)) {
      rawContent = await callAnthropic(systemPrompt, userPrompt, llmConfig);
    } else if (provider === 'gemini' && (llmConfig.apiKey || ENV.GEMINI_API_KEY)) {
      rawContent = await callGemini(systemPrompt, userPrompt, llmConfig);
    } else {
      // 기본 Ollama 호출 (실패 시 스마트 폴백)
      rawContent = await callOllama(systemPrompt, userPrompt, llmConfig);
    }

    const parsed = parseReviewJson(rawContent);
    return normalizeReviewResult(parsed, workbenchContext, query);
  } catch (err) {
    console.warn('[LawWorkbenchReview] LLM 호출 실패 또는 미응답, 규칙 기반 휴리스틱 검토서 생성:', err.message);
    return generateRuleBasedReview(query, preset, documentText, workbenchContext);
  }
}

/**
 * Ollama API 호출
 */
async function callOllama(systemPrompt, userPrompt, config = {}) {
  const url = config.url || ENV.OLLAMA_URL;
  const model = config.model || ENV.OLLAMA_MODEL;

  const response = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_predict: 2048 }
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
      temperature: 0.2
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
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2
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
    // 중괄호 영역만 추출 시도
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

/**
 * 결과 정규화
 */
function normalizeReviewResult(parsed, workbenchContext, query) {
  if (!parsed) return generateRuleBasedReview(query, 'compliance', '', workbenchContext);

  return {
    summary: parsed.summary || '검토가 완료되었습니다.',
    coreIssues: Array.isArray(parsed.coreIssues) ? parsed.coreIssues : [],
    facts: parsed.facts || query || '',
    legalBasis: Array.isArray(parsed.legalBasis) ? parsed.legalBasis : [],
    legalOpinion: parsed.legalOpinion || '',
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    furtherChecks: Array.isArray(parsed.furtherChecks) ? parsed.furtherChecks : [],
    draftOpinion: parsed.draftOpinion || '',
    disclaimer: parsed.disclaimer || DEFAULT_REVIEW_SCHEMA.disclaimer
  };
}

/**
 * LLM 미연결 시 Rule-based 지능형 검토서 폴백 생성기
 */
function generateRuleBasedReview(query, preset, documentText, context) {
  const lawName = context.meta?.primaryLawName || '관련 법령';
  const articles = context.officialEvidence?.articles || [];
  const precedents = context.officialEvidence?.precedents || [];

  const basisList = articles.map(a => ({
    lawName,
    articleNo: `제${a.fullArticleNo}조`,
    title: a.title,
    relevance: `본 사안의 행위 요건 및 적법성 판단의 직접적 근거 조항임`
  }));

  const draftMarkdown = `# [법률 검토의견서] ${query || '요청 사안에 관한 법적 검토'}

## 1. 검토 배경 및 질의 요지
- **검토 대상**: ${query || '제출된 문서 및 운영 계획의 법령 적합성'}
- **주요 법령**: **${lawName}**

---

## 2. 관련 법령 및 조문 근거
${articles.map(a => `### ■ ${lawName} 제${a.fullArticleNo}조 (${a.title})\n> ${a.content.replace(/\n/g, '\n> ')}`).join('\n\n')}

---

## 3. 법률적 쟁점 및 검토 의견
1. **적법 요건 충족 여부**:
   ${lawName}의 명문 규정에 비추어 볼 때, 법정 요건을 엄격히 준수하여 사전 절차를 이행하여야 합니다.
2. **판례 및 선례의 태도**:
   ${precedents.length > 0 ? `대법원 판례(${precedents[0].caseNo})에 따르면, "${precedents[0].summary}"라고 판시하고 있어 주의가 필요합니다.` : '유사 판례 및 행정해석례의 기준을 준용하여 법적 안정성을 확보해야 합니다.'}

---

## 4. 리스크 분석 및 권고사항
- **주요 리스크**: 관련 절차 미이행 시 행정처분(시정명령, 과태료 부과) 또는 효력 분쟁 가능성 존재.
- **개선 권고**: 내부 지침 정비 및 명시적 동의·사전통지 요건 보완 필요.
`;

  return {
    summary: `${lawName} 관련 규정을 검토한 결과, 명시된 법정 요건 준수 및 증빙 절차 마련이 필요합니다.`,
    coreIssues: [
      `${lawName} 상의 사전 절차 및 동의/인가 요건 충족 여부`,
      `관련 규정 미준수 시 행정처분 및 손해배상 발생 위험성`
    ],
    facts: query || '검토 대상 사안 및 관련 첨부 문서 내용',
    legalBasis: basisList,
    legalOpinion: `본 사안은 ${lawName}의 적용 대상으로서, 법률에 명시된 절차적·실체적 요건을 충실히 구비해야 합니다. 특히 관련 판례 및 행정청의 처분 기준에 부합하도록 명문화된 근거를 확보하는 것이 타당합니다.`,
    risks: [
      { level: 'HIGH', title: '행정 제재 리스크', description: '법령상 의무 불이행 시 과태료 또는 시정명령 처분 가능성' },
      { level: 'MEDIUM', title: '분쟁 발생 리스크', description: '이해관계인 또는 정보주체의 이의제기 및 손해배상 청구 위험' }
    ],
    recommendations: [
      '관련 조항에 따른 표준 절차 및 서식 구비',
      '사전 고지 및 명시적 증빙 기록 보관 체계 강화'
    ],
    furtherChecks: [
      '구체적인 사실관계 입증 서류 및 내부 규정 전문 확인'
    ],
    draftOpinion: draftMarkdown,
    disclaimer: DEFAULT_REVIEW_SCHEMA.disclaimer
  };
}

export default {
  generateLegalReview
};
