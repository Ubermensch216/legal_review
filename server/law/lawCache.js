// server/law/lawCache.js - Node.js 22+ 내장 node:sqlite 기반 2계층 캐시
import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { ENV } from '../env.js';

const l1Cache = new Map(); // L1 In-Memory Fast Cache
let db = null;
let isDbReady = false;

// SQLite DB 초기화
function initDatabase() {
  try {
    const dbPath = path.join(ENV.CACHE_DIR, 'law_cache.db');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new DatabaseSync(dbPath);
    
    // WAL 모드 및 동시성 락 방지 설정
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`);

    // 테이블 생성 및 인덱스 최적화
    db.exec(`
      CREATE TABLE IF NOT EXISTS law_cache (
        cache_key TEXT PRIMARY KEY,
        category TEXT,
        data TEXT,
        created_at INTEGER,
        expire_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_law_cache_expire ON law_cache(expire_at);
      CREATE INDEX IF NOT EXISTS idx_law_cache_category ON law_cache(category);
    `);

    isDbReady = true;
    purgeExpired();
    // Remove only legacy synthetic records; official caches and review history are preserved.
    db.exec("DELETE FROM law_cache WHERE category = 'prewarm' OR data LIKE '%PREWARM_%'");
  } catch (err) {
    console.warn('[LawCache] SQLite 초기화 실패, L1 인메모리 캐시 모드로 동작합니다:', err.message);
    isDbReady = false;
  }
}

initDatabase();

/**
 * 캐시에서 데이터 조회 (L1 -> L2)
 * @param {string} key 
 * @returns {Promise<any|null>}
 */
export async function getCache(key) {
  if (!key) return null;
  const now = Date.now();

  // 1. L1 메모리 캐시 확인
  if (l1Cache.has(key)) {
    const item = l1Cache.get(key);
    if (item.expireAt > now) {
      return item.data;
    } else {
      l1Cache.delete(key);
    }
  }

  // 2. L2 SQLite 캐시 확인
  if (!isDbReady || !db) return null;

  try {
    const stmt = db.prepare('SELECT data, expire_at FROM law_cache WHERE cache_key = ?');
    const row = stmt.get(key);

    if (!row) return null;

    if (row.expire_at <= now) {
      const delStmt = db.prepare('DELETE FROM law_cache WHERE cache_key = ?');
      delStmt.run(key);
      return null;
    }

    const parsed = JSON.parse(row.data);
    l1Cache.set(key, { data: parsed, expireAt: row.expire_at });
    return parsed;
  } catch (err) {
    console.warn('[LawCache] getCache 오류:', err.message);
    return null;
  }
}

/**
 * 캐시에 데이터 저장 (L1 + L2)
 * @param {string} key 
 * @param {any} data 
 * @param {number} ttlMs - 수명 (ms)
 * @param {string} category 
 */
export async function setCache(key, data, ttlMs = 86400000, category = 'general') {
  if (!key || data === undefined) return;
  const now = Date.now();
  const expireAt = now + ttlMs;

  // 1. L1 캐시 저장
  l1Cache.set(key, { data, expireAt });

  // 2. L2 DB 저장
  if (!isDbReady || !db) return;

  try {
    const dataStr = JSON.stringify(data);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO law_cache (cache_key, category, data, created_at, expire_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(key, category, dataStr, now, expireAt);
  } catch (err) {
    console.warn('[LawCache] setCache 오류:', err.message);
  }
}

/**
 * 캐시에서 항목 삭제
 * @param {string} key 
 */
export async function deleteCache(key) {
  l1Cache.delete(key);
  if (!isDbReady || !db) return;

  try {
    const stmt = db.prepare('DELETE FROM law_cache WHERE cache_key = ?');
    stmt.run(key);
  } catch (err) {
    console.warn('[LawCache] deleteCache 오류:', err.message);
  }
}

/**
 * 만료된 캐시 청소
 */
export async function purgeExpired() {
  const now = Date.now();
  
  // L1 정리
  for (const [key, item] of l1Cache.entries()) {
    if (item.expireAt <= now) {
      l1Cache.delete(key);
    }
  }

  // L2 정리
  if (!isDbReady || !db) return;
  try {
    const stmt = db.prepare('DELETE FROM law_cache WHERE expire_at <= ?');
    stmt.run(now);
  } catch (err) {
    console.warn('[LawCache] purgeExpired 오류:', err.message);
  }
}

/**
 * 전체 캐시 초기화
 */
export async function clearAllCache() {
  l1Cache.clear();
  if (!isDbReady || !db) return;
  try {
    db.exec('DELETE FROM law_cache');
  } catch (err) {
    console.warn('[LawCache] clearAllCache 오류:', err.message);
  }
}

export default {
  getCache,
  setCache,
  deleteCache,
  purgeExpired,
  clearAllCache
};
