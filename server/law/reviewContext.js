import { optimizeDocumentContext } from '../parsers/contextOptimizer.js';
import { articleText, isOfficial, today, sameLaw, normalizedLawName, inForceAt, historicalReviewNotice } from './evidence.js';

// 섹션별 입력 예산(문자 수). 토큰 예산(num_ctx)과는 별개로, 어떤 근거를 몇 자까지
// 프롬프트에 실을지 정한다. 여기서 넘친 항목은 수집 진단에만 집계한다.
// 판례·해석례는 한 건이 3,000자 안팎이라 기본값으로는 상위 1~2건만 실린다.
const DEFAULT_SECTION_BUDGETS = Object.freeze({
  document: 4500, articles: 9000, precedents: 5000, interpretations: 4000,
  ordinanceArticles: 4000, adminRules: 5000, keyProvisions: 3000, learningKnowledge: 2000
});

/**
 * 섹션별 문자 예산. LLM_SECTION_BUDGETS(JSON)로 항목별 덮어쓰기가 가능하다.
 * 예: LLM_SECTION_BUDGETS={"precedents":12000,"interpretations":9000}
 * 잘못된 값은 조용히 무시하지 않고 즉시 알린다. 예산이 조용히 되돌아가면
 * 근거가 왜 빠졌는지 추적할 수 없기 때문이다.
 * @returns {Record<string, number>}
 */
export function resolveSectionBudgets() {
  let overrides;
  try { overrides = JSON.parse(process.env.LLM_SECTION_BUDGETS || '{}'); }
  catch { throw new Error('LLM_SECTION_BUDGETS 값이 올바른 JSON이 아닙니다.'); }
  const merged = { ...DEFAULT_SECTION_BUDGETS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_SECTION_BUDGETS, key)) {
      throw new Error(`LLM_SECTION_BUDGETS에 알 수 없는 섹션 '${key}'이(가) 있습니다. ` +
        `사용 가능: ${Object.keys(DEFAULT_SECTION_BUDGETS).join(', ')}`);
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`LLM_SECTION_BUDGETS.${key}는 양의 정수여야 합니다.`);
    merged[key] = n;
  }
  return merged;
}

const LEARNING_SOURCE_LABEL = Object.freeze({ USER_APPROVED_EXTERNAL_AI: '외부 AI', USER_APPROVED_HUMAN_EXPERT: '외부 전문가(사람)' });

const groupBy = (items, key) => items.reduce((acc, item) => {
  (acc[key(item)] ||= []).push(item);
  return acc;
}, {});

export function buildReviewInput(context, documentText = '', query = '', budgets = {}) {
  const evidence = context.officialEvidence || {};
  const limits = resolveSectionBudgets();
  const maxDocument = budgets.document ?? limits.document;
  const cachedDocument = context.reviewContext?.document;
  const document = cachedDocument && cachedDocument.optimizedText.length <= maxDocument ? cachedDocument
    : optimizeDocumentContext({ documentText: documentText || cachedDocument?.optimizedText || '', query, maxChars: maxDocument });
  if (!documentText && cachedDocument && document !== cachedDocument) {
    document.omittedCount += cachedDocument.omittedCount || 0;
    document.truncatedCount += cachedDocument.truncatedCount || 0;
  }
  // 조문 효력은 워크벤치가 확정한 기준일로 판단한다. 지정이 없으면 오늘이다.
  const asOf = context.meta?.asOfDate || today();
  const warnings = [...(context.meta?.dataIntegrity?.warnings || [])];
  if (context.learningWarning) warnings.push(context.learningWarning);
  let learningKnowledgeText = '';
  const learningReferences = [];
  // 예산에 밀려 빠진 지식도 사유와 함께 남긴다. 조용히 빠지면 사용자는
  // "답변을 다 승인했는데 최종 검토에 반영되지 않았다"고만 느낀다.
  const learningExcluded = [...(context.learningExcluded || [])];
  for (const item of context.learningKnowledge || []) {
    // 사람 전문가 답변인지 외부 AI 답변인지 모델도 알 수 있게 한다. 어느 쪽도 공식 근거는 아니다.
    const text = JSON.stringify({ title: item.title, answerSource: LEARNING_SOURCE_LABEL[item.source] || '외부 AI', ...item.card });
    if (learningKnowledgeText.length + text.length + 2 > (budgets.learningKnowledge ?? limits.learningKnowledge)) {
      learningExcluded.push({ id: item.id, title: item.title, reason: 'BUDGET',
        message: '입력 예산이 부족해 이번 검토에는 싣지 못했습니다.', inCase: Boolean(item.inCase) });
      continue;
    }
    learningKnowledgeText += `${text}\n\n`;
    learningReferences.push({ id: item.id, title: item.title, source: item.source, inCase: Boolean(item.inCase) });
  }
  if (learningReferences.length) {
    const human = learningReferences.filter(r => r.source === 'USER_APPROVED_HUMAN_EXPERT').length;
    const breakdown = human ? ` (외부 AI ${learningReferences.length - human}건, 외부 전문가 ${human}건)` : '';
    warnings.push(`사용자 승인 외부 참고 지식 ${learningReferences.length}건${breakdown}을 입력에 포함했습니다. 공식 근거나 법리 검증을 대신하지 않습니다.`);
  }
  for (const [reason, items] of Object.entries(groupBy(learningExcluded, x => x.reason))) {
    warnings.push(`승인된 학습 지식 ${items.length}건을 이번 검토에 적용하지 않았습니다: ${items[0].message} (${reason})`);
  }
  // 과거·미래 시점 검토임을 LLM 프롬프트와 출력 보고서 양쪽에 남긴다.
  // 이 문장이 없으면 검토문이 현행 법령을 말하는지 그 시점 법령을 말하는지 구분되지 않는다.
  if (context.meta?.targetDate) {
    warnings.push(historicalReviewNotice(context.meta.targetDate));
  }
  let omittedEvidence = 0;
  const pack = (items, render, budget) => {
    let text = '';
    for (const item of items) {
      const part = render(item);
      if (part.length + text.length + 2 > budget) { omittedEvidence++; continue; }
      text += (text ? '\n\n' : '') + part;
    }
    return text;
  };
  const articles = (evidence.articles || []).filter(a => inForceAt(a, asOf) && (isOfficial(a) || (isOfficial(evidence.lawDetail) && !a.isMockData)));
  // 모법(act)이 빠져 있었다. 시행령을 기준으로 검토할 때 위임의 출발점인 법률 조문이
  // LLM 입력에 들어가지 않아, 법 → 영 → 조례로 이어지는 체계를 설명할 수 없었다.
  const cascading = ['act', 'decree', 'rule'].flatMap(kind => {
    const law = evidence.cascadingHierarchy?.[kind];
    return isOfficial(law) ? (law.articles || []).map(a => ({ ...a, lawName: law.lawName, source: law.source })) : [];
  });
  // 같은 조문이 수집 목록과 연쇄 체계에 중복으로 들어오면 예산만 소모하고,
  // 위임의 출발점인 모법 조문이 뒤로 밀려 잘려 나간다.
  // 법 → 영 → 규칙 순으로 싣고 중복은 제거한다.
  const actArticles = cascading.filter(a => sameLaw(a.lawName, evidence.cascadingHierarchy?.act?.lawName));
  const orderedArticles = [];
  const seenArticles = new Set();
  for (const article of [...actArticles, ...articles, ...cascading]) {
    const identity = `${normalizedLawName(article.lawName)}|${article.fullArticleNo || article.articleNo}`;
    if (seenArticles.has(identity)) continue;
    seenArticles.add(identity);
    orderedArticles.push(article);
  }
  const articlesText = pack(orderedArticles, a => `[${a.lawName || context.meta?.primaryLawName} ${a.fullArticleNo || a.articleNo} (${a.title || ''})]\n${articleText(a)}`, budgets.articles ?? limits.articles);
  const precedentsText = pack((evidence.precedents || []).filter(p => isOfficial(p) && p.contentStatus === 'FULL_TEXT' && (p.summary || p.holding || p.content)), p =>
    `[판례 관련도: ${Number.isFinite(p.relevanceScore) ? p.relevanceScore : '미측정'}점 ${p.courtName || ''} ${p.caseNo || ''} ${p.caseName || ''}]\n${p.holding || ''}\n${p.summary || p.content || ''}`, budgets.precedents ?? limits.precedents);
  const interpretationsText = pack((evidence.interpretations || []).filter(e => isOfficial(e) && e.contentStatus === 'FULL_TEXT' && (e.answer || e.reason)), e =>
    `[유권해석 ${e.orgName || ''} ${e.title || ''}]\n${e.answer || ''}\n${e.reason || ''}`, budgets.interpretations ?? limits.interpretations);
  // 자치법규(조례) 조문 — 지자체 사무에서는 조례가 직접 근거가 되는 경우가 많다.
  const ordinanceArticlesText = pack((evidence.ordinanceArticles || []).filter(a => isOfficial(a) && !a.isDeleted), a =>
    `[${a.lawName} 제${a.fullArticleNo}조 (${a.title || ''}) · ${a.orgName || ''}]\n${articleText(a)}`, budgets.ordinanceArticles ?? limits.ordinanceArticles);

  // 행정규칙(고시·훈령) 조문 및 별표 목록. 별표 본문은 첨부파일로만 제공되므로 링크를 함께 넘긴다.
  // 운영기준처럼 조문이 수십 개인 고시는 전문을 실으면 예산을 넘겨 통째로 탈락한다.
  // 사안 주제어에 걸리는 조문을 우선 싣고, 분량은 고시마다 따로 제한한다.
  const topicWords = (query || '').split(/\s+/).filter(w => w.length >= 2);
  const perRuleBudget = Math.max(800, Math.floor((budgets.adminRules ?? limits.adminRules) / 2));
  // 제명이 아니라 본문 내용으로 순위를 매긴다.
  // 제명만 보면 모법 이름을 길게 나열한 무관한 고시가 앞자리를 차지해,
  // 정작 산정 기준을 담은 고시가 예산에 밀려 탈락한다.
  const contentHits = detail => {
    const body = (detail.articles || []).map(a => a.content || '').join(' ');
    return topicWords.reduce((n, w) => n + (body.includes(w) ? 1 : 0), 0);
  };
  const rankedRuleDetails = (evidence.adminRuleDetails || [])
    .filter(d => isOfficial(d) && d.articles?.length)
    .sort((a, b) => contentHits(b) - contentHits(a));
  const adminRuleText = pack(rankedRuleDetails, d => {
    const scored = [...d.articles].sort((a, b) => {
      const hits = article => topicWords.reduce((n, w) => n + (String(article.content || '').includes(w) ? 1 : 0), 0);
      return hits(b) - hits(a);
    });
    let body = '';
    let dropped = 0;
    for (const a of scored) {
      const part = `제${a.fullArticleNo}조(${a.title || ''}) ${a.content}`;
      if (body.length + part.length + 1 > perRuleBudget) { dropped++; continue; }
      body += (body ? '\n' : '') + part;
    }
    const annexList = (d.annexes || []).map(x => `  - [별표 ${String(x.no).replace(/^0+/, '')}] ${x.title}${x.fileUrl ? ` (첨부: ${x.fileUrl})` : ''}`).join('\n');
    const note = dropped ? `\n(이 고시의 조문 ${dropped}개는 분량 제한으로 입력에 포함되지 않았습니다.)` : '';
    return `[행정규칙 ${d.name} · ${d.ruleType || ''} · ${d.ministry || ''}]\n${body}${note}${annexList ? `\n[별표 목록 — 본문은 첨부파일로만 제공됨]\n${annexList}` : ''}`;
  }, budgets.adminRules ?? limits.adminRules);

  // 원칙(본문) / 예외(단서) 구조를 기계적으로 분해해 따로 제시한다.
  // 소형 모델은 긴 조문 안에 묻힌 "다만 ~" 단서를 찾아내지 못해,
  // 예외 규정을 근거로 삼는 주장의 진짜 출처를 엉뚱한 법령으로 지목하는 일이 잦다.
  const citedNumbers = new Set((context.impactAndRevisions?.extractedReferences || [])
    .map(r => `${normalizedLawName(r.lawName)}|${r.fullArticleNo}`));
  const provisionEntries = [];
  for (const article of [...orderedArticles, ...(evidence.ordinanceArticles || [])]) {
    const identity = `${normalizedLawName(article.lawName)}|${article.fullArticleNo || article.articleNo}`;
    const units = [];
    for (const paragraph of article.paragraphs || []) {
      for (const unit of [paragraph, ...(paragraph.items || [])]) {
        const text = String(unit.content || '');
        const split = /^([\s\S]*?)(다만,[\s\S]*)$/.exec(text);
        if (!split) continue;
        // 항·호 번호는 '①'이나 '1.' 형태로 들어오므로 숫자만 추출해 표기를 통일한다.
        const digits = value => String(value || '').match(/\d+/)?.[0]
          || String(['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮'].indexOf(String(value || '').trim()) + 1 || '');
        const paragraphLabel = digits(paragraph.paragraphNo);
        const itemLabel = digits(unit.itemNo);
        const label = itemLabel ? `제${paragraphLabel}항 제${itemLabel}호` : `제${paragraphLabel}항`;
        units.push(`  ${label}\n    [원칙] ${split[1].trim()}\n    [예외·단서] ${split[2].trim()}`);
      }
    }
    const cited = citedNumbers.has(identity);
    // 단서가 없어도 신청서가 직접 인용한 조문은 선택지에 넣는다.
    // 원칙 규정만 있는 조문(예: 조례의 산출기준)에 기대는 주장도 있으므로,
    // 단서 있는 조문만 제시하면 그런 주장의 근거를 고를 수 없다.
    if (!units.length && !cited) continue;
    const body = units.length
      ? units.join('\n')
      : `  [원칙만 — 단서 없음] ${articleText(article).replace(/\s+/g, ' ').slice(0, 300)}`;
    provisionEntries.push({
      // 신청서가 직접 인용한 조문이 쟁점의 핵심인 경우가 대부분이므로 먼저 싣는다.
      cited,
      text: `[${article.lawName} 제${article.fullArticleNo || article.articleNo}조(${article.title || ''})]${cited ? ' ※신청서가 직접 인용' : ''}\n${body}`
    });
  }
  provisionEntries.sort((a, b) => Number(b.cited) - Number(a.cited));
  const keyProvisionsText = pack(provisionEntries, entry => entry.text, budgets.keyProvisions ?? limits.keyProvisions);

  // 여기까지는 수집·학습·시점에 관한 제한이다. 아래 두 문장은 이 단일 호출 프롬프트의 예산에만 해당하므로
  // 단계형 검토(자체 예산으로 근거를 싣는다)는 contextWarnings만 쓴다.
  const contextWarnings = [...warnings];
  // 분석은 실제 입력에 실린 근거만을 대상으로 한다. 제외 건수는 분석 상태를 낮추지 않는다.
  if (document.omittedCount || document.truncatedCount) warnings.push('첨부문서는 부분 발췌입니다. 문서 전체를 검토했다고 표현하지 마십시오.');
  return { document, articlesText, precedentsText, interpretationsText, ordinanceArticlesText, adminRuleText, keyProvisionsText,
    learningKnowledgeText, learningReferences, learningExcluded, warnings, contextWarnings, omittedEvidence,
    evidenceUsed: {
      articles: (articlesText.match(/^\[[^\]\n]+ \d+(?:의\d+)? \(/gm) || []).length,
      precedents: (precedentsText.match(/^\[판례 관련도:/gm) || []).length,
      interpretations: (interpretationsText.match(/^\[유권해석 /gm) || []).length,
      ordinances: (ordinanceArticlesText.match(/^\[[^\]\n]+ 제\d+(?:의\d+)?조 /gm) || []).length,
      adminRules: (adminRuleText.match(/^\[행정규칙 /gm) || []).length
    } };
}
