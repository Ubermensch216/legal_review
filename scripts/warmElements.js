// scripts/warmElements.js - 자주 쓰는 법령의 조문 요건 분해를 미리 해 두어 첫 검토 시간을 줄인다
//
// 조문의 요건 분해(S3)는 원문·모델·프롬프트 버전이 같으면 결과가 같아 조문별로 캐시된다(stageCache).
// 이 스크립트는 지정한 법령의 조문을 미리 분해해 캐시를 채운다. 실제 법령 API와 로컬 모델을 호출하며 조문 수에 비례해 오래 걸린다.
//
// 사용:
//   node scripts/warmElements.js "근로기준법" "개인정보 보호법"           # 법령별 상위 조문 30개까지
//   node scripts/warmElements.js --max=60 "근로기준법"
//   node scripts/warmElements.js --dry "근로기준법"                       # 모델 호출 없이 대상 조문 수만 확인
// 프롬프트 버전(prompts.js의 PROMPT_VERSION)이나 모델이 바뀌면 캐시가 새 키로 쌓이므로 다시 실행해야 한다.
import { ENV } from '../server/env.js';
import { buildWorkbenchContext } from '../server/law/lawWorkbench.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { decomposeArticles } from '../server/reasoning/stages/elements.js';
import { createLlmSession } from '../server/reasoning/llmGateway.js';
import { resolveBudget } from '../server/law/llmBudget.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const max = Number((args.find(a => a.startsWith('--max=')) || '--max=30').split('=')[1]) || 30;
const laws = args.filter(a => !a.startsWith('--'));
if (!laws.length) { console.error('법령명을 하나 이상 지정하십시오. 예: node scripts/warmElements.js "근로기준법"'); process.exit(1); }

const model = ENV.OLLAMA_MODEL;
for (const law of laws) {
  const context = await buildWorkbenchContext({ query: `${law} 조문`, preset: 'compliance', targetLaw: law, documentText: '' });
  const registry = buildEvidenceRegistry(context);
  const articleIds = registry.ids(e => e.kind === 'ARTICLE' && e.official).slice(0, max);
  console.log(`${law}: 대상 조문 ${articleIds.length}개 (기준 법령 ${context.meta?.primaryLawName || '확인 못함'})`);
  if (dry || !articleIds.length) continue;
  const budget = resolveBudget('ollama', { model, outputTokens: 2048 });
  const started = Date.now();
  const result = await decomposeArticles({ articleIds, registry, provider: 'ollama', config: { model, think: false, budget }, session: createLlmSession() });
  const sources = [...result.byArticle.values()].map(v => v.source);
  const count = source => sources.filter(s => s === source).length;
  console.log(`  완료 ${Math.round((Date.now() - started) / 1000)}초 · 이미 캐시 ${count('CACHE')} · 새로 분해 ${count('LLM')} · 미검증 ${count('SKELETON') + count('PARTIAL')}`);
  for (const warning of result.warnings.slice(0, 3)) console.log(`  주의: ${warning}`);
}
