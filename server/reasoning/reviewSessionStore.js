// server/reasoning/reviewSessionStore.js - 외부 재검토를 위해 최근 검토의 중간 산출물을 메모리에 잠시 보관한다
//
// 디스크에는 쓰지 않는다(원문이 들어 있다). 서버를 다시 시작하거나 시간이 지나면 사라지고,
// 그러면 외부 재검토 제안은 "검토 세션이 만료되었습니다. 검토를 다시 실행하십시오"로 안내한다.
import { randomUUID } from 'node:crypto';

const TTL_MS = 3 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const store = new Map();

export function rememberReview(context) {
  const now = Date.now();
  for (const [id, entry] of store) if (entry.expires < now) store.delete(id);
  while (store.size >= MAX_SESSIONS) store.delete(store.keys().next().value);
  const id = randomUUID();
  store.set(id, { context, expires: now + TTL_MS });
  return id;
}

export function recallReview(id) {
  const entry = store.get(String(id));
  if (!entry || entry.expires < Date.now()) { store.delete(String(id)); return null; }
  return entry.context;
}

export const forgetReviews = () => store.clear();
