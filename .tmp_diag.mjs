import './server/env.js';
import fs from 'fs';
import { createRequire } from 'module';
import { buildWorkbenchContext } from './server/law/lawWorkbench.js';
import { buildReviewInput } from './server/law/reviewContext.js';
import { resolveBudget, createTokenCounter } from './server/law/llmBudget.js';
const pdf = createRequire(import.meta.url)('pdf-parse');
const documentText = (await pdf(fs.readFileSync('./test/docs/test_mobility_ordinance.pdf'))).text;
const query = 'OO시 개인형 이동장치 규제 조례안 검토요청서';
const ctx = await buildWorkbenchContext({ query, preset: 'compliance', documentText });
const input = buildReviewInput(ctx, documentText, query);
console.log('문서 원문 길이:', documentText.length, '자');
console.log('document.omittedCount :', input.document.omittedCount);
console.log('document.truncatedCount:', input.document.truncatedCount);
console.log('omittedEvidence       :', input.omittedEvidence, '건  <-- "근거 N건 제외"');
console.log('--- 섹션별 실제 길이 / 기본 예산(자) ---');
for (const [k, text, cap] of [['articles', input.articlesText, 9000], ['precedents', input.precedentsText, 5000],
  ['interpretations', input.interpretationsText, 4000], ['ordinanceArticles', input.ordinanceArticlesText, 4000],
  ['adminRules', input.adminRuleText, 5000], ['keyProvisions', input.keyProvisionsText, 3000],
  ['document', input.document.optimizedText, 4500]]) console.log(`  ${k.padEnd(18)} ${String(text.length).padStart(6)} / ${cap}`);
const budget = resolveBudget('ollama', { model: process.env.OLLAMA_MODEL });
const counter = createTokenCounter('ollama', { model: process.env.OLLAMA_MODEL });
console.log('--- 토큰 예산 ---');
console.log('contextTokens(num_ctx):', budget.contextTokens, '| outputTokens(num_predict):', budget.outputTokens, '| inputLimit:', budget.inputLimit);
console.log('현재 입력 추정 토큰:', counter.estimate('', JSON.stringify(input)).tokens, '(shrinkToFit 발동 여부 참고용)');
console.log('후보 수: 조문', (ctx.officialEvidence.articles||[]).length, '판례', (ctx.officialEvidence.precedents||[]).length,
  '해석례', (ctx.officialEvidence.interpretations||[]).length, '행정규칙', (ctx.officialEvidence.adminRules||[]).length);
