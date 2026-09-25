import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument } from '../server/parsers/index.js';
import { buildEvidenceRegistry } from '../server/reasoning/evidenceRegistry.js';
import { assessPrivacyRowCoverage } from '../server/reasoning/privacyCoverage.js';

test('개인정보 XLSX와 BOM CSV의 각 데이터 행을 독립 문서 출처로 보존한다', async () => {
  const files = ['04_개인정보_처리현황표.xlsx', '04_개인정보_수탁사목록.csv'];
  const parts = [];
  for (const name of files) {
    const parsed = await parseDocument(await readFile(new URL(`./docs/review-samples/${name}`, import.meta.url)), name);
    assert.equal(parsed.chunks.filter(chunk => /^행 \d+$/.test(chunk.articleNo)).length,
      name.endsWith('.xlsx') ? 7 : 5);
    parts.push(`[첨부문서: ${name}]\n${parsed.text}`);
  }
  const documentText = parts.join('\n\n');
  const registry = buildEvidenceRegistry({}, { documentText });
  const rows = assessPrivacyRowCoverage(registry);
  assert.equal(rows.length, 12);
  assert.ok(rows.some(row => row.label.includes('얼굴인식 출입관리')));
  assert.ok(rows.some(row => row.label.includes('OO데이터테크') && row.label.includes('회원 DB 운영·유지보수')));
  for (const row of rows) {
    assert.equal(documentText.slice(row.sourceSpan.start, row.sourceSpan.end), registry.get(row.documentId).text);
    assert.equal(row.status, 'UNREVIEWED');
  }
  const linked = rows[0].documentId;
  const evaluated = assessPrivacyRowCoverage(registry, [{ id: 'I1' }], [{ issueId: 'I1', documentIds: [linked], stageStatus: 'OK' }]);
  assert.equal(evaluated.find(row => row.documentId === linked).status, 'REVIEWED');
  assert.equal(evaluated.filter(row => row.status === 'UNREVIEWED').length, 11);
  const lowered = assessPrivacyRowCoverage(registry, [{ id: 'I1' }], [{ issueId: 'I1', documentIds: [linked], stageStatus: 'PARTIAL' }]);
  assert.equal(lowered.find(row => row.documentId === linked).status, 'INCOMPLETE');
});
