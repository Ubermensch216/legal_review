// server/reasoning/evidenceRegistry.js - 근거 등록부 (단계형 파이프라인 S0, LLM 호출 없음)
//
// 수집한 공식 근거와 첨부문서 조항에 결정적인 ID를 붙인다. 이후 단계의 모델은 법령명·조문을
// 글로 쓰지 않고 이 ID만 반환한다. 그러면
//   1) 출력 토큰이 준다(인용 문장을 다시 쓰지 않는다),
//   2) 등록부에 없는 ID는 코드가 거부하므로 존재하지 않는 인용이 원천적으로 들어올 수 없다,
//   3) 원문 확장·시점 효력·공식 여부 판단을 코드가 한 곳에서 한다.
//
// ID 체계
//   A3        법령 조문 (법 → 시행령 → 시행규칙 순, 중복 제거)
//   A3.2      제2항           A3.2.1   제2항 제1호          A3.2x / A3.2.1x  그 단위의 단서(다만, …)
//   O1…       자치법규 조문 (단위 체계는 A와 같다)
//   R1.4      행정규칙 1번의 제4조
//   P2        판례             P2.h1  판시사항 [1]     P2.y1  판결요지 [1]
//   Q1        법령해석례       Q1.a   회답             Q1.r   이유
//   D4        첨부문서 조항     D4.2   긴 조항의 둘째 조각
//   K1        승인된 외부 참고 지식(비공식)
import { createHash } from 'node:crypto';
import { articleText, inForceAt, isOfficial, normalizedLawName, sameLaw, today, unitNumber } from '../law/evidence.js';
import { extractArticleReferences, isCitationReference, normalizeArticleNo } from '../law/lawArticleRef.js';
import { chunkLegalDocument } from '../parsers/legalDocChunker.js';

// 항·호 번호 통일은 인용 검증기와 같은 규칙을 쓴다.
export { unitNumber };

/** "…다만, …" 형태를 원칙과 단서로 나눈다. 단서가 없으면 null. */
export function splitProviso(text) {
  const match = /^([\s\S]*?)\s*(다만[,，]\s*[\s\S]*)$/.exec(String(text || ''));
  return match && match[1].trim() ? { principle: match[1].trim(), proviso: match[2].trim() } : null;
}

/** 판결요지·판시사항의 [1] [2] 번호 단위로 명제를 나눈다. 번호가 없으면 통째로 하나다. */
export function splitNumberedPropositions(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const parts = value.split(/(?=\[\d{1,2}\])/).map(s => s.trim()).filter(Boolean);
  const numbered = parts.filter(p => /^\[\d{1,2}\]/.test(p));
  if (numbered.length < 2) return [{ no: 1, text: value }];
  return numbered.map(p => ({ no: Number(p.match(/^\[(\d{1,2})\]/)[1]), text: p.replace(/^\[\d{1,2}\]\s*/, '').trim() }));
}

/** '15의2' → '제15조의2', '20' → '제20조' */
export const formatArticleNo = value => {
  const [main, branch] = String(value || '').replace(/[^\d의]/g, '').split('의');
  return `제${main}조${branch ? `의${branch}` : ''}`;
};

/** 조회 결과와 등록부 항목을 잇는 키. 공식 일련번호가 없으면 사건·안건번호를 쓴다. */
export const authorityKey = (target, item) => `${target}:${item?.id || item?.caseNo || item?.itemNo || item?.title || ''}`;

const hash = text => createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
const oneLine = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 긴 문서 조항을 문단 경계에서 조각낸다. 사실의 출처를 좁게 가리키기 위해서다. */
function splitLongText(text, max = 900) {
  const value = String(text || '');
  if (value.length <= max) return [value];
  const pieces = [];
  let current = '';
  for (const block of value.split(/\n\s*\n|\n(?=\s*[-•·\d①-⑳])/)) {
    if (current && current.length + block.length + 1 > max) { pieces.push(current); current = ''; }
    if (block.length > max) {
      for (let i = 0; i < block.length; i += max) pieces.push(block.slice(i, i + max));
      continue;
    }
    current += (current ? '\n' : '') + block;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * 근거 등록부를 만든다.
 * @param {object} context buildWorkbenchContext 결과 (learningKnowledge가 있으면 K로 등록)
 * @param {object} [options]
 * @param {string} [options.documentText] 첨부문서 원문. 주면 전체 조항을 D로 등록한다.
 */
export function buildEvidenceRegistry(context = {}, { documentText = '' } = {}) {
  const evidence = context.officialEvidence || {};
  const asOf = context.meta?.asOfDate || today();
  const entries = new Map();
  const order = [];
  const add = entry => {
    const full = { official: false, inForce: true, parentId: null, ...entry, textHash: hash(entry.text) };
    entries.set(full.id, full);
    order.push(full.id);
    return full;
  };

  // ── 조문 (A, O) ──────────────────────────────────────────
  const addArticle = (prefix, index, article, official) => {
    const id = `${prefix}${index}`;
    const lawName = article.lawName || context.meta?.primaryLawName || '';
    const articleNo = article.fullArticleNo || article.articleNo;
    const label = `${lawName} ${formatArticleNo(articleNo)}`;
    const base = add({ id, kind: prefix === 'A' ? 'ARTICLE' : 'ORDINANCE_ARTICLE', lawName, articleNo: String(articleNo),
      title: article.title || '', label, text: articleText(article), official, inForce: inForceAt(article, asOf),
      enforceDate: article.enforceDate || null, orgName: article.orgName || null });
    const addUnit = (unitId, unitLabel, content) => {
      const split = splitProviso(content);
      add({ id: unitId, kind: 'ARTICLE_UNIT', parentId: id, lawName, articleNo: base.articleNo, label: unitLabel,
        text: split ? split.principle : String(content || ''), official, inForce: base.inForce });
      if (split) add({ id: `${unitId}x`, kind: 'ARTICLE_PROVISO', parentId: id, lawName, articleNo: base.articleNo,
        label: `${unitLabel} 단서`, text: split.proviso, official, inForce: base.inForce, isException: true });
    };
    for (const paragraph of article.paragraphs || []) {
      const p = unitNumber(paragraph.paragraphNo);
      if (!p) {
        // 항 번호 없이 바로 호가 시작되는 조문(예: "다음 각 호")도 원문 단위로 보존한다.
        // .0은 번호 없는 본문, .0.N은 본문에 직접 속한 제N호다.
        if ((paragraph.items || []).length) {
          const lead = [article.content, paragraph.content].filter(Boolean).join('\n');
          if (lead) addUnit(`${id}.0`, `${label} 본문`, lead);
          for (const item of paragraph.items) {
            const i = unitNumber(item.itemNo);
            if (i && item.content) addUnit(`${id}.0.${i}`, `${label} 제${i}호`, item.content);
          }
        }
        continue;
      }
      if (paragraph.content) addUnit(`${id}.${p}`, `${label} 제${p}항`, paragraph.content);
      for (const item of paragraph.items || []) {
        const i = unitNumber(item.itemNo);
        if (i && item.content) addUnit(`${id}.${p}.${i}`, `${label} 제${p}항 제${i}호`, item.content);
      }
    }
    // 항이 없는 조문은 본문 자체의 단서를 나눈다.
    if (!(article.paragraphs || []).length && splitProviso(article.content)) {
      const split = splitProviso(article.content);
      add({ id: `${id}x`, kind: 'ARTICLE_PROVISO', parentId: id, lawName, articleNo: base.articleNo, label: `${label} 단서`,
        text: split.proviso, official, inForce: base.inForce, isException: true });
    }
    return base;
  };

  // 법 → 수집 조문 → 연쇄(영·규칙) 순. 같은 조문은 한 번만 싣는다(reviewContext와 같은 순서).
  const cascading = ['act', 'decree', 'rule'].flatMap(kind => {
    const law = evidence.cascadingHierarchy?.[kind];
    return isOfficial(law) ? (law.articles || []).map(a => ({ ...a, lawName: law.lawName, source: law.source })) : [];
  });
  const actName = evidence.cascadingHierarchy?.act?.lawName;
  const collected = [...(evidence.articles || []), ...(evidence.supplementalArticles || [])]
    .filter(a => isOfficial(a) || (isOfficial(evidence.lawDetail) && !a.isMockData));
  const seen = new Set();
  let articleIndex = 0;
  for (const article of [...cascading.filter(a => sameLaw(a.lawName, actName)), ...collected, ...cascading]) {
    const identity = `${normalizedLawName(article.lawName)}|${article.fullArticleNo || article.articleNo}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    addArticle('A', ++articleIndex, article, true);
  }
  let ordinanceIndex = 0;
  for (const article of (evidence.ordinanceArticles || []).filter(a => isOfficial(a) && !a.isDeleted)) {
    addArticle('O', ++ordinanceIndex, article, true);
  }

  // ── 행정규칙 (R) ────────────────────────────────────────
  let ruleIndex = 0;
  for (const detail of (evidence.adminRuleDetails || []).filter(d => isOfficial(d) && d.articles?.length)) {
    const id = `R${++ruleIndex}`;
    add({ id, kind: 'ADMIN_RULE', label: detail.name, title: detail.ruleType || '', official: true,
      text: (detail.articles || []).map(a => `제${a.fullArticleNo}조(${a.title || ''}) ${a.content || ''}`).join('\n') });
    for (const article of detail.articles) {
      const no = String(article.fullArticleNo || '').replace(/[^\d의]/g, '');
      if (!no) continue;
      add({ id: `${id}.${no.replace('의', '_')}`, kind: 'ADMIN_RULE_ARTICLE', parentId: id, label: `${detail.name} 제${no}조`,
        title: article.title || '', text: String(article.content || ''), official: true });
    }
  }

  // ── 판례 (P) ────────────────────────────────────────────
  const articleIdByKey = new Map([...entries.values()].filter(e => e.kind === 'ARTICLE')
    .map(e => [`${normalizedLawName(e.lawName)}|${normalizeArticleNo(e.articleNo)}`, e.id]));
  let precedentIndex = 0;
  for (const p of (evidence.precedents || []).filter(p => isOfficial(p) && p.contentStatus === 'FULL_TEXT')) {
    const id = `P${++precedentIndex}`;
    // 참조조문 중 이번에 수집한 조문과 같은 것을 잇는다. 검색·정렬 특징일 뿐 근거 판단이 아니다.
    const referenceIds = [...new Set(extractArticleReferences(p.referencedArticles || '').filter(isCitationReference)
      .map(r => articleIdByKey.get(`${normalizedLawName(r.lawName)}|${normalizeArticleNo(r.fullArticleNo)}`)).filter(Boolean))];
    add({ id, kind: 'PRECEDENT', label: [p.courtName, p.judgeDate, p.caseNo].filter(Boolean).join(' '), title: p.caseName || '',
      text: [p.holding, p.summary].filter(Boolean).join('\n'), official: true, caseNo: p.caseNo || null, sourceKey: authorityKey('prec', p),
      referencedArticles: p.referencedArticles || '', referenceIds });
    for (const [field, tag] of [['holding', 'h'], ['summary', 'y']]) {
      for (const prop of splitNumberedPropositions(p[field])) {
        add({ id: `${id}.${tag}${prop.no}`, kind: tag === 'h' ? 'PRECEDENT_ISSUE' : 'PRECEDENT_HOLDING', parentId: id,
          label: `${p.caseNo || id} ${tag === 'h' ? '판시사항' : '판결요지'} [${prop.no}]`, text: prop.text, official: true });
      }
    }
  }

  // ── 법령해석례 (Q) ──────────────────────────────────────
  let interpretationIndex = 0;
  for (const q of (evidence.interpretations || []).filter(e => isOfficial(e) && e.contentStatus === 'FULL_TEXT')) {
    const id = `Q${++interpretationIndex}`;
    add({ id, kind: 'INTERPRETATION', label: [q.orgName, q.itemNo || q.caseNo, q.title].filter(Boolean).join(' '),
      title: q.title || '', text: [q.answer, q.reason].filter(Boolean).join('\n'), official: true, sourceKey: authorityKey('expc', q) });
    if (q.answer) add({ id: `${id}.a`, kind: 'INTERPRETATION_ANSWER', parentId: id, label: `${q.title || id} 회답`, text: q.answer, official: true });
    if (q.reason) add({ id: `${id}.r`, kind: 'INTERPRETATION_REASON', parentId: id, label: `${q.title || id} 이유`, text: q.reason, official: true });
  }

  // ── 첨부문서 (D) ────────────────────────────────────────
  // 원문을 주지 않으면 워크벤치가 선별한 조항만 등록한다(사실 출처 확인 범위도 그만큼 좁다).
  const chunks = documentText ? chunkLegalDocument(documentText) : (context.impactAndRevisions?.documentChunks || []);
  let documentIndex = 0;
  let documentCursor = 0;
  for (const chunk of chunks) {
    const text = String(chunk.content || chunk.excerpt || '').trim();
    if (!text) continue;
    const id = `D${++documentIndex}`;
    const label = chunk.articleNo && chunk.articleNo !== '전문' ? `첨부문서 ${chunk.articleNo}${chunk.title ? `(${chunk.title})` : ''}` : '첨부문서 서두';
    const offset = documentText ? documentText.indexOf(text, documentCursor) : -1;
    if (offset >= 0) documentCursor = offset + text.length;
    add({ id, kind: 'DOCUMENT', label, title: chunk.title || '', text, isRiskClause: Boolean(chunk.isRiskClause),
      partial: !documentText, sourceSpan: offset >= 0 ? { start: offset, end: offset + text.length } : null });
    const pieces = splitLongText(text);
    if (pieces.length > 1) pieces.forEach((piece, i) => add({ id: `${id}.${i + 1}`, kind: 'DOCUMENT_PART', parentId: id,
      label: `${label} 조각 ${i + 1}`, text: piece }));
  }

  // ── 승인된 외부 참고 지식 (K) — 공식 근거가 아니다 ─────────
  let knowledgeIndex = 0;
  for (const item of context.learningKnowledge || []) {
    // 질문별 답변이 있으면 카드와 함께 싣는다. 공백을 메우는 답은 카드 요약보다 답변 쪽에 있다.
    const body = item.answers?.length ? { ...(item.card || {}), answers: item.answers } : (item.card || {});
    add({ id: `K${++knowledgeIndex}`, kind: 'KNOWLEDGE', label: item.title, title: item.card?.issue || '',
      text: JSON.stringify(body), official: false, knowledgeId: item.id, source: item.source });
  }

  return createRegistryView(entries, order, asOf);
}

function createRegistryView(entries, order, asOf) {
  const childrenOf = new Map();
  for (const id of order) {
    const parent = entries.get(id).parentId;
    if (parent) (childrenOf.get(parent) || childrenOf.set(parent, []).get(parent)).push(id);
  }
  const normalizeId = value => String(value || '').trim().replace(/^\[|\]$/g, '');

  return {
    asOf,
    size: entries.size,
    get: id => entries.get(normalizeId(id)) || null,
    list: (predicate = () => true) => order.map(id => entries.get(id)).filter(predicate),
    ids: (predicate = () => true) => order.filter(id => predicate(entries.get(id))),
    children: id => (childrenOf.get(id) || []).map(child => entries.get(child)),

    /** 모델이 돌려준 ID를 확인한다. 등록부에 없는 ID는 조용히 버리지 않고 따로 돌려준다. */
    resolve(ids) {
      const found = [];
      const unknown = [];
      for (const raw of Array.isArray(ids) ? ids : []) {
        const entry = entries.get(normalizeId(raw));
        if (entry) { if (!found.includes(entry)) found.push(entry); } else unknown.push(String(raw));
      }
      return { found, unknown };
    },

    /** 모델용 한 줄 색인. 최상위 항목만 싣고 하위 단위 ID는 괄호로 나열한다. */
    renderIndex({ kinds, maxChars = Infinity, gist = 70 } = {}) {
      const lines = [];
      let used = 0;
      let omitted = 0;
      for (const id of order) {
        const entry = entries.get(id);
        if (entry.parentId || (kinds && !kinds.includes(entry.kind))) continue;
        const units = (childrenOf.get(id) || []);
        const flags = [entry.official ? '' : '비공식', entry.inForce ? '' : '기준일 효력 없음'].filter(Boolean).join('·');
        const line = `[${id}] ${entry.label}${entry.title ? `(${entry.title})` : ''}${flags ? ` <${flags}>` : ''} — ${oneLine(entry.text, gist)}`
          + (units.length ? ` {${units.join(', ')}}` : '');
        if (used + line.length + 1 > maxChars) { omitted++; continue; }
        lines.push(line);
        used += line.length + 1;
      }
      return { text: lines.join('\n'), omitted };
    },

    /**
     * 선택한 ID의 원문을 싣는다. 최상위 ID는 하위 단위를 구조째로, 하위 ID는 그 단위만 싣는다.
     * 예산을 넘는 항목은 잘라 싣지 않고 통째로 빼서 omitted에 남긴다(반쯤 잘린 조문은 단서를 잃는다).
     */
    renderFull(ids, { maxChars = Infinity } = {}) {
      const blocks = [];
      const included = [];
      const omitted = [];
      let used = 0;
      const { found, unknown } = this.resolve(ids);
      for (const entry of found) {
        const units = entry.parentId ? [] : (childrenOf.get(entry.id) || []).map(child => entries.get(child))
          .filter(u => u.kind !== 'DOCUMENT_PART');
        const flags = [entry.official ? '' : '비공식 — 공식 근거로 인용 금지', entry.inForce ? '' : `기준일(${asOf}) 효력 없음`].filter(Boolean).join(' · ');
        const body = units.length
          ? units.map(u => `  [${u.id}] ${u.isException ? '(단서) ' : ''}${u.text}`).join('\n')
          : entry.text;
        const block = `[${entry.id}] ${entry.label}${entry.title ? `(${entry.title})` : ''}${flags ? ` <${flags}>` : ''}\n${body}`;
        if (used + block.length + 2 > maxChars) { omitted.push(entry.id); continue; }
        blocks.push(block);
        included.push(entry.id);
        used += block.length + 2;
      }
      return { text: blocks.join('\n\n'), included, omitted, unknown };
    },

    /** 공식 근거 중 기준일에 효력이 있는 것만. 결론의 근거가 될 수 있는 ID 집합이다. */
    citableIds() {
      return order.filter(id => { const e = entries.get(id); return e.official && e.inForce; });
    },

    toJSON() {
      return order.map(id => {
        const { text, ...rest } = entries.get(id);
        // 화면에는 내부 ID 대신 조문명과 짧은 원문 첫머리를 보여준다.
        // 판례·계약문서 원문은 이 직렬화에 포함하지 않는다.
        const previewSource = text.replace(/^\s*제\s*\d+(?:의\d+)?조\s*(?:\([^)]*\))?\s*/, '').trim()
          || (childrenOf.get(id) || []).map(childId => entries.get(childId))
            .find(child => child?.kind?.endsWith('UNIT') && !child.isException)?.text || '';
        const preview = rest.official && /^(ARTICLE|ORDINANCE_ARTICLE)/.test(rest.kind)
          ? previewSource.replace(/\s+/g, ' ').trim()
          : '';
        return { ...rest, textChars: text.length,
          ...(preview ? { preview: `${preview.slice(0, 85)}${preview.length > 85 ? '…' : ''}` } : {}) };
      });
    }
  };
}
