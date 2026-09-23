// server/reasoning/embeddings.js - 로컬 임베딩(bge-m3)으로 의미 유사도를 잰다
//
// 판례·조항 후보의 정렬 특징 중 하나일 뿐이다. 유사도가 높다고 법적으로 유사한 사안이라는 뜻은
// 아니며, 유추·구별 판정은 S4에서 결정적 사실 비교로 한다. 임베딩을 쓸 수 없으면 null을 돌려주고
// 호출부는 문자열 특징만으로 정렬한다(사유는 warning으로 남긴다).
import { createHash } from 'node:crypto';
import { ENV } from '../env.js';

const cache = new Map();
const CACHE_LIMIT = 4000;
const key = (model, text) => `${model}|${createHash('sha256').update(text).digest('hex')}`;

export const embeddingModel = () => process.env.OLLAMA_EMBED_MODEL || 'bge-m3';

/** 테스트와 운영 재설정용. */
export function clearEmbeddingCache() { cache.clear(); }

/**
 * 여러 문장을 한 번에 임베딩한다. 이미 계산한 문장은 다시 보내지 않는다.
 * @returns {Promise<{ vectors: (number[]|null)[], warning: string|null }>}
 */
export async function embedTexts(texts, { url = ENV.OLLAMA_URL, model = embeddingModel(), timeoutMs = 60000 } = {}) {
  const values = texts.map(t => String(t || '').slice(0, 2000));
  const missing = [...new Set(values.filter(v => v && !cache.has(key(model, v))))];
  if (missing.length) {
    try {
      const response = await fetch(`${url}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ model, input: missing, keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m' }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { embeddings } = await response.json();
      if (!Array.isArray(embeddings) || embeddings.length !== missing.length) throw new Error('응답 형식 불일치');
      if (cache.size + missing.length > CACHE_LIMIT) cache.clear();
      missing.forEach((text, i) => cache.set(key(model, text), embeddings[i]));
    } catch (err) {
      return { vectors: values.map(() => null), warning: `임베딩 모델(${model})을 사용할 수 없어 문자열 일치로만 정렬했습니다: ${err.message}` };
    }
  }
  return { vectors: values.map(v => (v ? cache.get(key(model, v)) : null) || null), warning: null };
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : null;
}
