// server/law/lawHistoryDb.js - 법령 검토 이력 관리 SQLite 모듈
import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { ENV } from '../env.js';

let db = null;
let isDbReady = false;

// SQLite DB 초기화
function initDatabase() {
  try {
    const dbPath = path.join(ENV.CACHE_DIR, 'law_history.db');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new DatabaseSync(dbPath);
    
    // 이력 테이블 생성
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_history (
        id TEXT PRIMARY KEY,
        query TEXT,
        preset TEXT,
        target_law TEXT,
        document_name TEXT,
        summary TEXT,
        risk_count INTEGER DEFAULT 0,
        full_data TEXT,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_review_history_created ON review_history(created_at DESC);
    `);

    isDbReady = true;
  } catch (err) {
    console.warn('[LawHistoryDb] SQLite 초기화 실패:', err.message);
    isDbReady = false;
  }
}

// 초기화
initDatabase();

/**
 * 신규 검토 이력 저장
 * @param {object} param
 * @returns {string|null} 저장된 이력 ID
 */
export function saveHistoryItem({ query = '', preset = 'compliance', targetLaw = '', documentName = '', reviewData = {} }) {
  if (!isDbReady || !db) return null;

  const id = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = Date.now();
  
  // 요약 텍스트 정제
  let summary = '';
  if (reviewData?.review?.summary) {
    summary = String(reviewData.review.summary).replace(/^#+\s+/gm, '').replace(/[*_`]/g, '').trim();
    if (summary.length > 200) summary = summary.slice(0, 200) + '...';
  } else {
    summary = (query || documentName || '법령 검토 완료').slice(0, 150);
  }

  const riskCount = reviewData?.review?.risks?.length || 0;
  const fullDataStr = JSON.stringify(reviewData);

  try {
    const stmt = db.prepare(`
      INSERT INTO review_history (id, query, preset, target_law, document_name, summary, risk_count, full_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, query, preset, targetLaw, documentName, summary, riskCount, fullDataStr, now);
    return id;
  } catch (err) {
    console.error('[LawHistoryDb] saveHistoryItem 오류:', err.message);
    return null;
  }
}

/**
 * 검토 이력 목록 조회 (최신순)
 * @param {number} limit 
 * @param {number} offset 
 * @returns {Array<object>}
 */
export function getHistoryList(limit = 50, offset = 0) {
  if (!isDbReady || !db) return [];

  try {
    const stmt = db.prepare(`
      SELECT id, query, preset, target_law, document_name, summary, risk_count, created_at
      FROM review_history
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset);
    return rows.map(r => ({
      id: r.id,
      query: r.query,
      preset: r.preset,
      targetLaw: r.target_law,
      documentName: r.document_name,
      summary: r.summary,
      riskCount: r.risk_count,
      createdAt: new Date(r.created_at).toISOString(),
      timestamp: r.created_at
    }));
  } catch (err) {
    console.error('[LawHistoryDb] getHistoryList 오류:', err.message);
    return [];
  }
}

/**
 * 특정 검토 이력 상세 조회 (전체 데이터 포함)
 * @param {string} id 
 * @returns {object|null}
 */
export function getHistoryById(id) {
  if (!isDbReady || !db || !id) return null;

  try {
    const stmt = db.prepare(`
      SELECT id, query, preset, target_law, document_name, summary, risk_count, full_data, created_at
      FROM review_history
      WHERE id = ?
    `);
    const row = stmt.get(id);
    if (!row) return null;

    return {
      id: row.id,
      query: row.query,
      preset: row.preset,
      targetLaw: row.target_law,
      documentName: row.document_name,
      summary: row.summary,
      riskCount: row.risk_count,
      createdAt: new Date(row.created_at).toISOString(),
      timestamp: row.created_at,
      data: JSON.parse(row.full_data || '{}')
    };
  } catch (err) {
    console.error('[LawHistoryDb] getHistoryById 오류:', err.message);
    return null;
  }
}

/**
 * 특정 이력 삭제
 * @param {string} id 
 * @returns {boolean}
 */
export function deleteHistoryItem(id) {
  if (!isDbReady || !db || !id) return false;

  try {
    const stmt = db.prepare(`DELETE FROM review_history WHERE id = ?`);
    stmt.run(id);
    return true;
  } catch (err) {
    console.error('[LawHistoryDb] deleteHistoryItem 오류:', err.message);
    return false;
  }
}

/**
 * 전체 검토 이력 초기화
 */
export function clearAllHistory() {
  if (!isDbReady || !db) return false;

  try {
    db.exec(`DELETE FROM review_history`);
    return true;
  } catch (err) {
    console.error('[LawHistoryDb] clearAllHistory 오류:', err.message);
    return false;
  }
}

export default {
  saveHistoryItem,
  getHistoryList,
  getHistoryById,
  deleteHistoryItem,
  clearAllHistory
};
