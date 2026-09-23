// server/reasoning/stageCache.js - 사건과 무관한 단계 결과의 재사용 캐시
//
// 조문의 요건 분해처럼 입력 원문이 같으면 결과가 사건마다 달라질 이유가 없는 산출물만 저장한다.
// 키에는 원문 해시·프롬프트 버전·모델이 들어가므로, 조문이 개정되거나 프롬프트·모델을 바꾸면
// 자동으로 새로 계산한다. 사건 사실·쟁점 판단은 여기에 저장하지 않는다.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ENV } from '../env.js';

export const stageCacheKey = (...parts) => createHash('sha256').update(parts.map(p => String(p ?? '')).join('\u0001')).digest('hex');

export function createStageCache(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reasoning_cache (
      key TEXT PRIMARY KEY, stage TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
  return {
    get(key) {
      const row = db.prepare('SELECT data FROM reasoning_cache WHERE key=?').get(key);
      return row ? JSON.parse(row.data) : null;
    },
    set(key, stage, data) {
      db.prepare('INSERT OR REPLACE INTO reasoning_cache VALUES (?,?,?,?)').run(key, stage, JSON.stringify(data), new Date().toISOString());
    },
    clear() { db.exec('DELETE FROM reasoning_cache'); },
    close() { db.close(); }
  };
}

let cache;
export const getStageCache = () => cache ||= createStageCache(path.join(ENV.CACHE_DIR, 'reasoning_cache.db'));
