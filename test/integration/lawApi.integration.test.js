import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';

dotenv.config();
const root = mkdtempSync(path.join(tmpdir(), 'legal-review-integration-'));
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.LAW_DEMO_MODE = 'false';
const { searchLaw, getLawDetail } = await import('../../server/law/lawApiClient.js');
const { searchPrecedents } = await import('../../server/law/decisionsApiClient.js');

test('공식 법령 목록과 시행일 본문 계약', { skip: !process.env.LAW_OC && 'LAW_OC 미설정: 실제 API 검증 미실행' }, async () => {
  const items = await searchLaw('개인정보 보호법', 1, 100);
  assert.equal(items.fetchStatus, undefined, items.unavailableReason);
  const match = items.find(l => l.lawName.replace(/\s+/g, '') === '개인정보보호법');
  assert.ok(match, '정확한 법령이 검색되어야 한다');
  const detail = await getLawDetail(match.lawId, match.lawSeq, { enforceDate: match.enforceDate });
  assert.equal(detail.source, 'OFFICIAL_API');
  assert.ok(detail.articles.length > 0);
});

test('공식 판례 목록과 본문 계약', { skip: !process.env.LAW_OC && 'LAW_OC 미설정: 실제 API 검증 미실행' }, async () => {
  const items = await searchPrecedents('손해배상', 1, 3);
  assert.equal(items.fetchStatus, undefined, items.unavailableReason);
  assert.ok(items.length > 0);
  assert.ok(items.some(p => p.contentStatus === 'FULL_TEXT'), '본문 권한/필드 계약을 확인해야 한다');
});
