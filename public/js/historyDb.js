// public/js/historyDb.js - 브라우저 IndexedDB 영구 저장소 모듈
const DB_NAME = 'LegalReviewDB';
const DB_VERSION = 1;
const STORE_NAME = 'review_history';

let dbInstance = null;

/**
 * IndexedDB 연결 및 영구 저장소(Persistent Storage) 권한 요청
 */
export async function getHistoryDb() {
  if (dbInstance) return dbInstance;

  // 브라우저 영구 보관 모드 요청 (브라우저 자동 캐시 삭제 방지)
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log(`[IndexedDB] Storage persisted status: ${isPersisted}`);
    } catch (e) {
      console.warn('[IndexedDB] Persistent storage request failed:', e);
    }
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('preset', 'preset', { unique: false });
        store.createIndex('query', 'query', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('[IndexedDB] Database open error:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * 검토 이력 저장 (IndexedDB 영구 보관)
 * @param {object} item - 저장할 검토 이력 객체
 */
export async function saveReviewToIndexedDB(item) {
  const db = await getHistoryDb();
  const id = item.id || `hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const createdAt = item.createdAt || item.created_at || new Date().toISOString();

  const record = {
    id,
    createdAt,
    preset: item.preset || item.data?.meta?.preset || 'compliance',
    query: item.query || item.data?.meta?.query || '법령 검토',
    targetLaw: item.targetLaw || item.data?.meta?.primaryLawName || '관련 법령',
    summary: item.summary || item.data?.review?.summary || '검토 완료',
    data: item.data || item
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);

    req.onsuccess = () => resolve(record);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * 전체 검토 이력 최신순 조회
 */
export async function getAllReviewsFromIndexedDB() {
  const db = await getHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('createdAt');
    const items = [];

    // 최신순(내림차순) 순회
    const req = index.openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        resolve(items);
      }
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * 특정 이력 단건 조회
 */
export async function getReviewByIdFromIndexedDB(id) {
  const db = await getHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * 특정 이력 삭제
 */
export async function deleteReviewFromIndexedDB(id) {
  const db = await getHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onsuccess = () => resolve(true);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * 전체 이력 초기화 (영구 삭제)
 */
export async function clearAllReviewsFromIndexedDB() {
  const db = await getHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();

    req.onsuccess = () => resolve(true);
    req.onerror = (e) => reject(e.target.error);
  });
}

export default {
  getHistoryDb,
  saveReviewToIndexedDB,
  getAllReviewsFromIndexedDB,
  getReviewByIdFromIndexedDB,
  deleteReviewFromIndexedDB,
  clearAllReviewsFromIndexedDB
};
