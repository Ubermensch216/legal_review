import { optimizeDocumentContext } from '../parsers/contextOptimizer.js';
import { articleText, isOfficial, today, sameLaw, normalizedLawName } from './evidence.js';

export function buildReviewInput(context, documentText = '', query = '', budgets = {}) {
  const evidence = context.officialEvidence || {};
  const maxDocument = budgets.document ?? 4500;
  const cachedDocument = context.reviewContext?.document;
  const document = cachedDocument && cachedDocument.optimizedText.length <= maxDocument ? cachedDocument
    : optimizeDocumentContext({ documentText: documentText || cachedDocument?.optimizedText || '', query, maxChars: maxDocument });
  if (!documentText && cachedDocument && document !== cachedDocument) {
    document.omittedCount += cachedDocument.omittedCount || 0;
    document.truncatedCount += cachedDocument.truncatedCount || 0;
  }
  const warnings = [...(context.meta?.dataIntegrity?.warnings || [])];
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
  const articles = (evidence.articles || []).filter(a => !a.isDeleted && (!a.enforceDate || a.enforceDate <= today()) && (isOfficial(a) || (isOfficial(evidence.lawDetail) && !a.isMockData)));
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
  const articlesText = pack(orderedArticles, a => `[${a.lawName || context.meta?.primaryLawName} ${a.fullArticleNo || a.articleNo} (${a.title || ''})]\n${articleText(a)}`, budgets.articles ?? 9000);
  const precedentsText = pack((evidence.precedents || []).filter(p => isOfficial(p) && p.contentStatus === 'FULL_TEXT' && (p.summary || p.holding || p.content)), p =>
    `[판례 관련도: ${Number.isFinite(p.relevanceScore) ? p.relevanceScore : '미측정'}점 ${p.courtName || ''} ${p.caseNo || ''} ${p.caseName || ''}]\n${p.holding || ''}\n${p.summary || p.content || ''}`, budgets.precedents ?? 5000);
  const interpretationsText = pack((evidence.interpretations || []).filter(e => isOfficial(e) && e.contentStatus === 'FULL_TEXT' && (e.answer || e.reason)), e =>
    `[유권해석 ${e.orgName || ''} ${e.title || ''}]\n${e.answer || ''}\n${e.reason || ''}`, budgets.interpretations ?? 4000);
  // 자치법규(조례) 조문 — 지자체 사무에서는 조례가 직접 근거가 되는 경우가 많다.
  const ordinanceArticlesText = pack((evidence.ordinanceArticles || []).filter(a => isOfficial(a) && !a.isDeleted), a =>
    `[${a.lawName} 제${a.fullArticleNo}조 (${a.title || ''}) · ${a.orgName || ''}]\n${articleText(a)}`, budgets.ordinanceArticles ?? 4000);

  // 행정규칙(고시·훈령) 조문 및 별표 목록. 별표 본문은 첨부파일로만 제공되므로 링크를 함께 넘긴다.
  // 운영기준처럼 조문이 수십 개인 고시는 전문을 실으면 예산을 넘겨 통째로 탈락한다.
  // 사안 주제어에 걸리는 조문을 우선 싣고, 분량은 고시마다 따로 제한한다.
  const topicWords = (query || '').split(/\s+/).filter(w => w.length >= 2);
  const perRuleBudget = Math.max(800, Math.floor((budgets.adminRules ?? 5000) / 2));
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
    const note = dropped ? `\n(이 고시의 조문 ${dropped}개는 분량 제한으로 제외했습니다. 제외분에 관한 판단은 보류하십시오.)` : '';
    return `[행정규칙 ${d.name} · ${d.ruleType || ''} · ${d.ministry || ''}]\n${body}${note}${annexList ? `\n[별표 목록 — 본문은 첨부파일로만 제공됨]\n${annexList}` : ''}`;
  }, budgets.adminRules ?? 5000);

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
  const keyProvisionsText = pack(provisionEntries, entry => entry.text, budgets.keyProvisions ?? 3000);

  if (omittedEvidence) warnings.push(`입력 예산 때문에 근거 ${omittedEvidence}건을 제외했습니다. 제외한 자료에 관한 판단은 보류하십시오.`);
  if (document.omittedCount || document.truncatedCount) warnings.push('첨부문서는 부분 발췌입니다. 문서 전체를 검토했다고 표현하지 마십시오.');
  return { document, articlesText, precedentsText, interpretationsText, ordinanceArticlesText, adminRuleText, keyProvisionsText, warnings, omittedEvidence };
}
