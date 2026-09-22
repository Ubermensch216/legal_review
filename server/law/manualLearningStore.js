import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ENV } from '../env.js';

// Separate from disposable API caches. No raw answer or identity replacement dictionary is stored.
export function createLearningStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS manual_learning (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      parent_id TEXT, history_id TEXT NOT NULL, revision INTEGER NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS manual_learning_parent ON manual_learning(parent_id);
    CREATE INDEX IF NOT EXISTS manual_learning_history ON manual_learning(history_id);`);
  const hydrate = row => row ? { ...JSON.parse(row.data), id: row.id, kind: row.kind, state: row.state,
    parentId: row.parent_id, historyId: row.history_id, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
  const get = id => hydrate(db.prepare('SELECT * FROM manual_learning WHERE id=?').get(id));
  const list = (kind, state) => db.prepare(`SELECT * FROM manual_learning WHERE kind=? ${state ? 'AND state=?' : ''} ORDER BY updated_at DESC LIMIT 500`)
    .all(...(state ? [kind, state] : [kind])).map(hydrate);
  return {
    get, list,
    create(kind, historyId, data, parentId = null) {
      const id = randomUUID(); const now = new Date().toISOString();
      db.prepare('INSERT INTO manual_learning VALUES (?,?,?,?,?,1,?,?,?)')
        .run(id, kind, 'DRAFT', parentId, historyId, JSON.stringify(data), now, now);
      return get(id);
    },
    update(id, revision, state, data) {
      const result = db.prepare('UPDATE manual_learning SET state=?, data=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?')
        .run(state, JSON.stringify(data), new Date().toISOString(), id, revision);
      if (!result.changes) throw Object.assign(new Error('내용이 변경되었습니다. 다시 불러온 뒤 확인하십시오.'), { statusCode: 409 });
      return get(id);
    },
    delete(id) {
      db.prepare('DELETE FROM manual_learning WHERE id=? OR parent_id=?').run(id, id);
    },
    deleteHistory(historyId) { db.prepare('DELETE FROM manual_learning WHERE history_id=?').run(historyId); },
    clear() { db.exec('DELETE FROM manual_learning'); },
    close() { db.close(); }
  };
}

let store;
export const getLearningStore = () => store ||= createLearningStore(path.join(ENV.CACHE_DIR, 'manual_learning.db'));
