// server/reasoning/stages/elements.js - S3 조문 요건 분해 (캐시 우선, 미스일 때만 LLM)
//
// 조문의 적용 요건은 사건과 무관하다. 조문 원문 해시를 키로 캐시해 두면 같은 조문을 다시 만나는
// 검토에서는 이 단계의 LLM 호출이 0회가 된다. 모델이 실패해도 코드가 항·호·단서로 나눈
// 골격 요건으로 대체하므로 이후 단계가 멈추지 않는다.
import { runStage } from '../stageRunner.js';
import { PROMPT_VERSION, REASONING_SYSTEM } from '../prompts.js';
import { getStageCache, stageCacheKey } from '../stageCache.js';

const ARTICLE_KINDS = new Set(['ARTICLE', 'ORDINANCE_ARTICLE']);
const BATCH = 4;           // 한 호출에 싣는 조문 수 (출력 약 250토큰/조문)
const MAX_ELEMENTS = 8;    // 조문당 요건 상한
const MAX_ISSUE_ELEMENTS = 10;

export const elementsSchema = {
  type: 'object', additionalProperties: false, required: ['articles'],
  properties: { articles: { type: 'array', maxItems: BATCH, items: { type: 'object', additionalProperties: false,
    required: ['articleId', 'elements', 'burden'],
    properties: { articleId: { type: 'string', maxLength: 12 }, burden: { type: 'string', maxLength: 120 },
      elements: { type: 'array', minItems: 1, maxItems: MAX_ELEMENTS, items: { type: 'object', additionalProperties: false,
        required: ['text', 'mandatory', 'isException', 'sourceIds'],
        properties: { text: { type: 'string', maxLength: 160 }, mandatory: { type: 'boolean' }, isException: { type: 'boolean' },
          sourceIds: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } } } } } } } } }
};

const TASK = articlesText => `[과제: 조문 요건 분해]
아래 조문 각각을, 그 조문이 적용되기 위한 요건과 예외로 나눈다. 이 사건의 사실에 맞추지 말고 조문 문언 자체의 요건만 쓴다.
- text: 요건 한 가지를 한 문장으로(160자 이내). 여러 요건을 한 문장에 묶지 않는다.
- mandatory: 모두 충족해야 하는 요건이면 true, 여러 경우 중 하나(열거된 호 등)면 false.
- isException: "다만" 단서나 적용 제외 사유이면 true.
- sourceIds: 그 요건이 나온 하위 ID(예: A1.2, A1.2x). 조문 밖의 ID는 쓰지 않는다.
- burden: 누가 무엇을 입증·소명해야 하는지 조문에서 읽히면 쓰고, 없으면 빈 문자열.
${articlesText}
출력 JSON 형식: {"articles":[{"articleId":"A1","elements":[{"text":"","mandatory":true,"isException":false,"sourceIds":["A1.1"]}],"burden":""}]}`;

/** 조문의 하위 단위를 그대로 요건 골격으로 쓴다. LLM이 실패했을 때의 대체이자 비교 기준이다. */
export function skeletonElements(registry, articleId) {
  const units = registry.children(articleId).filter(u => u.kind === 'ARTICLE_UNIT' || u.kind === 'ARTICLE_PROVISO');
  const source = units.length ? units : [registry.get(articleId)];
  return source.slice(0, MAX_ELEMENTS).map((u, i) => ({ id: `${articleId}.E${i + 1}`, text: String(u.text).slice(0, 160),
    mandatory: !u.isException, isException: Boolean(u.isException), sourceIds: [u.id] }));
}

const articleHash = (registry, id) => [registry.get(id).textHash, ...registry.children(id).map(c => c.textHash)].join(':');

/**
 * 조문들을 요건으로 분해한다.
 * @returns {Promise<{ byArticle: Map<string, { elements: object[], burden: string, source: 'CACHE'|'LLM'|'SKELETON' }>, warnings: string[] }>}
 */
export async function decomposeArticles({ articleIds, registry, prefix, provider, config, session, cache = getStageCache() }) {
  const result = new Map();
  const warnings = [];
  const misses = [];
  const keyOf = id => stageCacheKey('elements', PROMPT_VERSION, provider, config.model || '', articleHash(registry, id));
  for (const id of [...new Set(articleIds)]) {
    const entry = registry.get(id);
    if (!entry || !ARTICLE_KINDS.has(entry.kind)) continue;
    const cached = cache?.get(keyOf(id));
    if (cached) result.set(id, { ...cached, source: 'CACHE' });
    else misses.push(id);
  }

  for (let i = 0; i < misses.length; i += BATCH) {
    const batch = misses.slice(i, i + BATCH);
    let parsed = null; // 실패하면 null로 남는다
    try {
      const articlesText = registry.renderFull(batch).text;
      ({ value: parsed } = await runStage({ stage: 's3', provider, system: REASONING_SYSTEM, prefix, task: TASK(articlesText),
        schema: elementsSchema, config: { ...config, think: false }, session }));
    } catch (err) {
      // 아래에서 골격 요건으로 대체한다. 대체 사실은 결과에 남겨 요건 품질이 낮을 수 있음을 알린다.
      warnings.push(`조문 요건 분해 실패(${batch.join(', ')}) — 항·호 단위 골격 요건으로 대체: ${err.message}`);
    }

    // 모델이 articleId를 "A5 (근로기준법 제27조)"처럼 꾸며 쓰는 일이 있다(실측). ID만 뽑아 맞추고,
    // 그래도 안 맞으면 조문 수가 같을 때에 한해 순서대로 맞춘다.
    const answers = parsed?.articles || [];
    const idOf = value => String(value || '').match(/[AO]\d+/)?.[0] || '';
    const byOrder = answers.length === batch.length && !answers.some(a => batch.includes(idOf(a.articleId)));
    for (const [index, id] of batch.entries()) {
      const own = new Set([id, ...registry.children(id).map(c => c.id)]);
      const answer = answers.find(a => idOf(a.articleId) === id) || (byOrder ? answers[index] : null);
      if (parsed && !answer) warnings.push(`조문 요건 분해 응답에 ${id}가 없어 항·호 단위 골격 요건으로 대체했습니다.`);
      const elements = (answer?.elements || []).map(e => ({ ...e, text: String(e.text).trim(), sourceIds: e.sourceIds.filter(s => own.has(s)) }))
        .filter(e => e.text).slice(0, MAX_ELEMENTS)
        .map((e, n) => ({ id: `${id}.E${n + 1}`, text: e.text, mandatory: e.mandatory, isException: e.isException,
          sourceIds: e.sourceIds.length ? e.sourceIds : [id] }));
      if (!elements.length) {
        result.set(id, { elements: skeletonElements(registry, id), burden: '', source: 'SKELETON' });
        continue;
      }
      const value = { elements, burden: String(answer.burden || '').trim() };
      cache?.set(keyOf(id), 's3', value);
      result.set(id, { ...value, source: 'LLM' });
    }
  }
  return { byArticle: result, warnings };
}

/**
 * 쟁점에 필요한 요건만 고른다. 쟁점이 하위 단위(A1.2)를 가리켰으면 그 단위와 그 단서에서 나온 요건만,
 * 조문 전체(A1)를 가리켰으면 조문의 요건 전부를 싣는다.
 */
export function selectIssueElements(issue, decomposed, registry) {
  const referenced = issue.evidenceIds.map(id => registry.get(id)).filter(Boolean);
  const wanted = new Map();
  for (const entry of referenced) {
    const articleId = entry.parentId && ARTICLE_KINDS.has(registry.get(entry.parentId)?.kind) ? entry.parentId : entry.id;
    if (!decomposed.has(articleId)) continue;
    if (!wanted.has(articleId)) wanted.set(articleId, new Set());
    if (entry.id !== articleId) {
      wanted.get(articleId).add(entry.id);
      // 원칙 단위를 가리키면 그 단위의 단서도 함께 본다. 예외를 빼면 결론이 한쪽으로 기운다.
      const proviso = registry.get(`${entry.id.replace(/x$/, '')}x`);
      if (proviso) wanted.get(articleId).add(proviso.id);
    }
  }
  const selected = [];
  for (const [articleId, units] of wanted) {
    for (const element of decomposed.get(articleId).elements) {
      if (!units.size || element.sourceIds.some(s => units.has(s) || s === articleId)) selected.push(element);
    }
  }
  if (selected.length <= MAX_ISSUE_ELEMENTS) return selected;
  // 상한을 넘으면 예외 요건은 모두 남기고 나머지를 앞에서부터 채운다(원래 순서 유지).
  const exceptions = selected.filter(e => e.isException);
  const room = Math.max(0, MAX_ISSUE_ELEMENTS - exceptions.length);
  const keep = new Set([...exceptions, ...selected.filter(e => !e.isException).slice(0, room)]);
  return selected.filter(e => keep.has(e));
}
