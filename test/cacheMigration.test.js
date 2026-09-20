import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('가짜 사전 캐시만 제거하고 공식 본문의 동일 문자열은 보존한다', async () => {
  fs.mkdirSync(process.env.CACHE_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(process.env.CACHE_DIR, 'law_cache.db'));
  db.exec('CREATE TABLE law_cache (cache_key TEXT PRIMARY KEY, category TEXT, data TEXT, created_at INTEGER, expire_at INTEGER)');
  const insert = db.prepare('INSERT INTO law_cache VALUES (?, ?, ?, ?, ?)');
  const now = Date.now();
  insert.run('fake', 'search', JSON.stringify([{ lawId: 'PREWARM_민법' }]), now, now + 60000);
  insert.run('official', 'detail', JSON.stringify({ lawId: '1', content: 'PREWARM_라는 문자열이 있는 본문' }), now, now + 60000);
  insert.run('legacy', 'prewarm', '{}', now, now + 60000);
  db.close();
  const { getCache } = await import('../server/law/lawCache.js');
  assert.equal(await getCache('fake'), null);
  assert.equal(await getCache('legacy'), null);
  assert.equal((await getCache('official')).lawId, '1');
});
