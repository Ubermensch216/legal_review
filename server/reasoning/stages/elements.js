// server/reasoning/stages/elements.js - S3 조문 요건 분해 (캐시 우선, 미스일 때만 LLM)
//
// 조문의 적용 요건은 사건과 무관하다. 조문 원문 해시를 키로 캐시해 두면 같은 조문을 다시 만나는
// 검토에서는 이 단계의 LLM 호출이 0회가 된다. 모델이 실패해도 코드가 항·호·단서로 나눈
// 골격 요건으로 대체하므로 이후 단계가 멈추지 않는다.
import { runStage, StageError } from '../stageRunner.js';
import { PROMPT_VERSION, REASONING_SYSTEM } from '../prompts.js';
import { getStageCache, stageCacheKey } from '../stageCache.js';
import { contractSeedEvidenceIds } from '../contractReview.js';

const ARTICLE_KINDS = new Set(['ARTICLE', 'ORDINANCE_ARTICLE']);
const BATCH = 1;           // 조문 사이에 사건 전체 입력을 반복하지 않는다.
const UNIT_BATCH = 4;      // 긴 조문은 항·호·단서 묶음별로 분해한다.
const MAX_ELEMENTS = 8;    // 한 호출의 출력 상한. 조문 전체 결과의 상한은 아니다.
export const provenanceOnly = text => {
  const value = String(text || '').trim();
  return /출처를 확인하지 못한 자료|출처 확인 필요|공식 근거 확인 필요|자료 확인 필요|검토 미완료|검색 실패|원문 없음/.test(value)
    || (/출처/.test(value) && /확인/.test(value) && value.length < 100);
};

export const elementsSchema = {
  type: 'object', additionalProperties: false, required: ['articles'],
  properties: { articles: { type: 'array', maxItems: BATCH, items: { type: 'object', additionalProperties: false,
    required: ['articleId', 'elements', 'burden'],
    properties: { articleId: { type: 'string', maxLength: 12 }, burden: { type: 'string', maxLength: 120 },
      elements: { type: 'array', minItems: 1, maxItems: MAX_ELEMENTS, items: { type: 'object', additionalProperties: false,
        required: ['text', 'mandatory', 'isException', 'sourceIds'],
        properties: { text: { type: 'string', maxLength: 160 }, mandatory: { type: 'boolean' }, isException: { type: 'boolean' },
          logicGroup: { type: 'string', maxLength: 24 },
          operator: { type: 'string', enum: ['ALL_OF', 'ANY_OF', 'EXCEPTION', 'ALTERNATIVE'] },
          relevance: { type: 'string', enum: ['DECISIVE', 'SUPPORTING', 'BACKGROUND', 'UNASSESSED'] },
          sourceIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 16 } } } } } } } } }
};

const TASK = (articlesText, articleId, sourceIds) => `[과제: 조문 요건 분해]
아래 조문 각각을, 그 조문이 적용되기 위한 요건과 예외로 나눈다. 이 사건의 사실에 맞추지 말고 조문 문언 자체의 요건만 쓴다.
- text: 요건 한 가지를 한 문장으로(160자 이내). 여러 요건을 한 문장에 묶지 않는다.
- mandatory: 모두 충족해야 하는 요건이면 true, 여러 경우 중 하나(열거된 호 등)면 false.
- logicGroup/operator: A AND B AND (C OR D)라면 A·B는 ALL_OF, C·D는 같은 logicGroup의 ANY_OF로 나타낸다.
- isException: "다만" 단서나 적용 제외 사유이면 true.
- sourceIds: 반드시 이 호출에 제공된 원문 ID 중에서만 고른다: ${sourceIds.join(', ')}. 하위 단위가 없는 조문은 조문 ID 자체를 쓴다. 모든 요건에 출처 ID를 하나 이상 넣는다.
- burden: 누가 무엇을 입증·소명해야 하는지 조문에서 읽히면 쓰고, 없으면 빈 문자열.
${articlesText}
출력 JSON 형식: {"articles":[{"articleId":"${articleId}","elements":[{"text":"","mandatory":true,"isException":false,"sourceIds":["${sourceIds[0]}"]}],"burden":""}]}`;

/** 조문의 하위 단위를 그대로 요건 골격으로 쓴다. LLM이 실패했을 때의 대체이자 비교 기준이다. */
export function skeletonElements(registry, articleId) {
  const units = registry.children(articleId).filter(u => u.kind === 'ARTICLE_UNIT' || u.kind === 'ARTICLE_PROVISO');
  const source = units.length ? units : [registry.get(articleId)];
  return source.filter(u => !provenanceOnly(u.text)).slice(0, MAX_ELEMENTS).map((u, i) => ({ id: `${articleId}.E${i + 1}`, text: String(u.text).slice(0, 160),
    mandatory: false, isException: Boolean(u.isException), sourceIds: [u.id], fallback: true,
    relevance: 'UNASSESSED', blocksConclusion: false }));
}

const articleHash = (registry, id) => [registry.get(id).textHash, ...registry.children(id).map(c => c.textHash)].join(':');
const FORMAT_VERSION = 'unit-batches-v2';
export const ELEMENT_SCHEMA_VERSION = 'v4-source-ids';

const splitText = text => {
  const middle = Math.floor(text.length / 2);
  const marks = [...text.matchAll(/[.。;；\n]\s*/g)].map(m => m.index + m[0].length)
    .filter(i => i > text.length / 3 && i < text.length * 2 / 3);
  const cut = marks.length ? marks.reduce((best, i) => Math.abs(i - middle) < Math.abs(best - middle) ? i : best) : middle;
  return [text.slice(0, cut), text.slice(cut)];
};

function fragmentsFor(registry, id) {
  const children = registry.children(id).filter(u => u.kind === 'ARTICLE_UNIT' || u.kind === 'ARTICLE_PROVISO');
  return (children.length ? children : [registry.get(id)]).filter(Boolean)
    .map(u => ({ id: u.id, text: String(u.text || ''), isException: Boolean(u.isException) }));
}

function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/** 한 조문의 일부 원문만 모델에 싣고, 예산 초과 때 해당 묶음만 다시 나눈다. */
async function decomposeGroup({ id, fragments, registry, provider, config, session, warnings }) {
  if (fragments.every(f => !f.text.trim())) {
    warnings.push(`조문 ${id}에 분해할 원문이 없어 미검증으로 남겼습니다.`);
    return { elements: [], burden: '', partial: true };
  }
  const own = new Set(fragments.map(f => f.id));
  const sourceIds = [...own];
  const header = registry.get(id);
  const articlesText = `[${id}] ${header.label}${header.title ? `(${header.title})` : ''}\n`
    + fragments.map(f => `  [${f.id}] ${f.isException ? '(단서) ' : ''}${f.text}`).join('\n');
  try {
    const args = { stage: 's3', provider, system: REASONING_SYSTEM,
      prefix: `[검토 기준일] ${registry.asOf}`, task: TASK(articlesText, id, sourceIds), schema: elementsSchema,
      config: { ...config, think: false }, session };
    const extract = value => {
      const answer = value.articles.find(a => String(a.articleId).match(/[AO]\d+/)?.[0] === id);
      if (!answer?.elements?.length) throw new StageError('s3', `${id} 응답에 요건이 없습니다.`);
      const elements = answer.elements.map(e => ({ text: String(e.text).trim(), mandatory: e.mandatory,
        logicGroup: e.logicGroup || '', operator: e.operator || (e.isException ? 'EXCEPTION' : e.mandatory ? 'ALL_OF' : 'ANY_OF'),
        relevance: 'UNASSESSED',
        isException: e.isException, sourceIds: e.sourceIds.filter(s => own.has(s)) }))
        .filter(e => e.text && e.sourceIds.length && !provenanceOnly(e.text));
      return { answer, elements };
    };
    let { answer, elements } = extract((await runStage(args)).value);
    if (!elements.length) {
      const retryTask = `${args.task}\n\n[직전 응답의 출처 ID 오류]\n유효한 출처 ID가 없었습니다. sourceIds에는 ${sourceIds.join(', ')} 중 실제 원문에 대응하는 ID를 넣어 다시 출력하십시오.`;
      ({ answer, elements } = extract((await runStage({ ...args, task: retryTask })).value));
    }
    if (!elements.length) throw new StageError('s3', `${id} 응답에 유효한 출처 ID가 없습니다.`);
    const covered = new Set(elements.flatMap(e => e.sourceIds));
    const missing = fragments.filter(f => f.text.trim() && !covered.has(f.id));
    if (missing.length) {
      warnings.push(`조문 ${id}의 원문 단위 ${missing.map(f => f.id).join(', ')}가 요건 응답에서 누락되어 골격 요건으로 보충했습니다.`);
        elements.push(...missing.filter(f => !provenanceOnly(f.text)).map(f => ({ text: f.text.slice(0, 160), mandatory: !f.isException,
        isException: f.isException, sourceIds: [f.id], fallback: true,
        relevance: 'UNASSESSED', blocksConclusion: false })));
    }
    return { elements, burden: String(answer.burden || '').trim(), partial: Boolean(missing.length) };
  } catch (err) {
    if (err instanceof StageError && (err.budgetExceeded || err.cause?.truncated)) {
      if (fragments.length > 1) {
        const middle = Math.ceil(fragments.length / 2);
        const left = await decomposeGroup({ id, fragments: fragments.slice(0, middle), registry, provider, config, session, warnings });
        const right = await decomposeGroup({ id, fragments: fragments.slice(middle), registry, provider, config, session, warnings });
        return { elements: [...left.elements, ...right.elements], burden: left.burden || right.burden,
          partial: left.partial || right.partial };
      }
      if (fragments[0].text.length > 400) {
        const [leftText, rightText] = splitText(fragments[0].text);
        const left = await decomposeGroup({ id, fragments: [{ ...fragments[0], text: leftText }], registry, provider, config, session, warnings });
        const right = await decomposeGroup({ id, fragments: [{ ...fragments[0], text: rightText }], registry, provider, config, session, warnings });
        return { elements: [...left.elements, ...right.elements], burden: left.burden || right.burden,
          partial: left.partial || right.partial };
      }
    }
    warnings.push(`조문 요건 분해 실패(${id}: ${fragments.map(f => f.id).join(', ')}) — 골격 요건으로 대체: ${err.message}`);
    return { elements: fragments.filter(f => !provenanceOnly(f.text)).map(f => ({ text: f.text.slice(0, 160), mandatory: !f.isException,
      isException: f.isException, sourceIds: [f.id], fallback: true,
      relevance: 'UNASSESSED', blocksConclusion: false })), burden: '', partial: true };
  }
}

/**
 * 조문들을 요건으로 분해한다.
 * @returns {Promise<{ byArticle: Map<string, { elements: object[], burden: string, source: 'CACHE'|'LLM'|'PARTIAL'|'SKELETON' }>, warnings: string[] }>}
 */
export async function decomposeArticles({ articleIds, registry, prefix, provider, config, session, cache = getStageCache() }) {
  const result = new Map();
  const warnings = [];
  const misses = [];
  const keyOf = id => stageCacheKey('elements', PROMPT_VERSION, ELEMENT_SCHEMA_VERSION, FORMAT_VERSION, provider, config.model || '', articleHash(registry, id));
  for (const id of [...new Set(articleIds)]) {
    const entry = registry.get(id);
    if (!entry || !ARTICLE_KINDS.has(entry.kind)) continue;
    const cached = cache?.get(keyOf(id));
    if (cached?.elements?.length && cached.elements.every(e => !provenanceOnly(e.text)))
      result.set(id, { ...cached, source: 'CACHE' });
    else {
      if (cached) warnings.push(`조문 ${id}의 오래되거나 잘못된 요건 캐시를 무효화했습니다.`);
      misses.push(id);
    }
  }

  for (const id of misses) {
    const fragments = fragmentsFor(registry, id);
    const parts = [];
    for (const group of chunk(fragments, UNIT_BATCH)) {
      parts.push(await decomposeGroup({ id, fragments: group, registry, provider, config, session, warnings }));
    }
    const elements = parts.flatMap(p => p.elements).map((e, n) => ({ ...e, id: `${id}.E${n + 1}` }));
    const value = { elements, burden: parts.map(p => p.burden).filter(Boolean).join(' / ') };
    const source = parts.some(p => p.partial) ? (parts.every(p => p.elements.every(e => e.fallback)) ? 'SKELETON' : 'PARTIAL') : 'LLM';
    if (source === 'LLM') cache?.set(keyOf(id), 's3', value);
    result.set(id, { ...value, source });
  }
  return { byArticle: result, warnings };
}

/**
 * 쟁점에 필요한 요건만 고른다. 쟁점이 하위 단위(A1.2)를 가리켰으면 그 단위와 그 단서에서 나온 요건만,
 * 조문 전체(A1)를 가리켰으면 조문의 요건 전부를 싣는다.
 */
export function selectIssueElements(issue, decomposed, registry) {
  const allowedArticles = new Set(issue.contractKinds?.length
    ? contractSeedEvidenceIds(issue.contractKinds, registry) : []);
  const referenced = issue.evidenceIds.map(id => registry.get(id)).filter(entry => entry
    && (!allowedArticles.size || allowedArticles.has(entry.parentId || entry.id)));
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
  const seen = new Set();
  return selected.filter(element => {
    const key = String(element.text || '').replace(/\s+/g, '').replace(/[.,，。]/g, '');
    if (!key || provenanceOnly(element.text) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
