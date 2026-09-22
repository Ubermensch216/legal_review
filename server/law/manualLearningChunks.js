import { learningInputRoom } from './manualLearningLocal.js';

// 긴 외부 답변을 로컬 AI가 나눠 읽게 한다.
// 소형 모델에 긴 한국어 법률문을 한 번에 물리는 것보다, 예산 안에서 여러 번 나눠 묻는 쪽이 누락이 적다.

export const MAX_CHUNKS = 12;

/**
 * 문단 경계로 자르고 앞 청크의 꼬리를 물린다.
 * 한국어 법률 답변은 "…할 수 있다. 근거: 공유재산법 제20조"처럼 근거가 주장 뒤에 온다.
 * 고정 글자수로 자르면 근거만 떨어져 나온 청크가 생기고, 그 인용은 주장 없이 존재 검증만
 * 통과해 '검증됨'처럼 보인다. 누락보다 나쁘므로 문단 단위로만 자른다.
 */
export function splitAnswer(text, fits, { overlap = 2, maxChunks = MAX_CHUNKS } = {}) {
  const blocks = String(text || '').split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) return [];

  const chunks = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    chunks.push(current.join('\n\n'));
    // 겹치는 꼬리 문단을 다음 청크의 머리로 넘겨, 경계에 걸친 주장과 근거를 함께 보게 한다.
    current = current.slice(-overlap);
  };

  for (const block of blocks) {
    // 한 문단 자체가 예산을 넘으면 문장 경계에서만 더 쪼갠다.
    const pieces = fits(block) ? [block] : splitLongBlock(block, fits);
    for (const piece of pieces) {
      const next = [...current, piece];
      if (current.length && !fits(next.join('\n\n'))) {
        flush();
        current = [...current, piece];
        // 겹친 꼬리까지 더해 여전히 넘치면 겹치기를 포기한다. 넘치는 청크를 만들지는 않는다.
        if (!fits(current.join('\n\n'))) current = [piece];
      } else {
        current = next;
      }
    }
    if (chunks.length >= maxChunks) break;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks.slice(0, maxChunks);
}

function splitLongBlock(block, fits) {
  const sentences = block.split(/(?<=[.。?!])\s+/).filter(Boolean);
  const pieces = [];
  let buffer = '';
  for (const sentence of sentences) {
    const next = buffer ? `${buffer} ${sentence}` : sentence;
    if (buffer && !fits(next)) { pieces.push(buffer); buffer = sentence; } else { buffer = next; }
  }
  if (buffer) pieces.push(buffer);
  // 한 문장이 그래도 넘치면 그대로 둔다. 잘라내면 문장이 왜곡되고, 예산 검사는 호출 직전에 다시 한다.
  return pieces.length ? pieces : [block];
}

/** 시스템 프롬프트와 고정 자료를 뺀 나머지가 예산에 들어가는지 재는 함수를 만든다. */
export const chunkFitter = (system, fixed, task) =>
  body => learningInputRoom(system, JSON.stringify({ ...fixed, chunk: body }), task).overTokens <= 0;

/** 조각들을 합친다. 모델이 새 주장을 만들 자리를 주지 않기 위해 병합은 코드에서 한다. */
export function mergeFragments(fragments, { maxItems = 12, maxKeywords = 10 } = {}) {
  const pick = key => {
    const seen = new Map();
    for (const fragment of fragments) {
      for (const value of Array.isArray(fragment?.[key]) ? fragment[key] : []) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text && !seen.has(text)) seen.set(text, text);
      }
    }
    return [...seen.values()];
  };
  const citations = new Map();
  for (const fragment of fragments) {
    for (const citation of Array.isArray(fragment?.citations) ? fragment.citations : []) {
      const lawName = typeof citation?.lawName === 'string' ? citation.lawName.trim() : '';
      const articleNo = typeof citation?.articleNo === 'string' ? citation.articleNo.trim() : '';
      if (lawName && articleNo) citations.set(`${lawName}|${articleNo}`, { lawName, articleNo });
    }
  }
  const answered = new Set();
  for (const fragment of fragments) {
    for (const no of Array.isArray(fragment?.answeredQuestions) ? fragment.answeredQuestions : []) answered.add(Number(no));
  }
  return {
    conditions: pick('conditions').slice(0, maxItems),
    exceptions: pick('exceptions').slice(0, maxItems),
    principles: pick('principles').slice(0, maxItems),
    checklist: pick('checklist').slice(0, maxItems),
    keywords: pick('keywords').slice(0, maxKeywords),
    citations: [...citations.values()].slice(0, 15),
    answeredQuestions: [...answered].filter(Number.isSafeInteger).sort((a, b) => a - b)
  };
}
