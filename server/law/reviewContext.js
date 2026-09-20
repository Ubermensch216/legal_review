import { optimizeDocumentContext } from '../parsers/contextOptimizer.js';
import { articleText, isOfficial, today } from './evidence.js';

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
  const cascading = ['decree', 'rule'].flatMap(kind => {
    const law = evidence.cascadingHierarchy?.[kind];
    return isOfficial(law) ? (law.articles || []).map(a => ({ ...a, lawName: law.lawName, source: law.source })) : [];
  });
  const articlesText = pack([...articles, ...cascading], a => `[${a.lawName || context.meta?.primaryLawName} ${a.fullArticleNo || a.articleNo} (${a.title || ''})]\n${articleText(a)}`, budgets.articles ?? 9000);
  const precedentsText = pack((evidence.precedents || []).filter(p => isOfficial(p) && p.contentStatus === 'FULL_TEXT' && (p.summary || p.holding || p.content)), p =>
    `[판례 관련도: ${Number.isFinite(p.relevanceScore) ? p.relevanceScore : '미측정'}점 ${p.courtName || ''} ${p.caseNo || ''} ${p.caseName || ''}]\n${p.holding || ''}\n${p.summary || p.content || ''}`, budgets.precedents ?? 5000);
  const interpretationsText = pack((evidence.interpretations || []).filter(e => isOfficial(e) && e.contentStatus === 'FULL_TEXT' && (e.answer || e.reason)), e =>
    `[유권해석 ${e.orgName || ''} ${e.title || ''}]\n${e.answer || ''}\n${e.reason || ''}`, budgets.interpretations ?? 4000);
  if (omittedEvidence) warnings.push(`입력 예산 때문에 근거 ${omittedEvidence}건을 제외했습니다. 제외한 자료에 관한 판단은 보류하십시오.`);
  if (document.omittedCount || document.truncatedCount) warnings.push('첨부문서는 부분 발췌입니다. 문서 전체를 검토했다고 표현하지 마십시오.');
  return { document, articlesText, precedentsText, interpretationsText, warnings, omittedEvidence };
}
