// 일회성 검증: 옮기기 전 contractReview.js의 규칙과 contract.json이 같은 결과를 내는지 비교한다.
// 사용: node scripts/checkContractMigration.mjs <옛 contractReview.js 사본 경로>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from '../server/parsers/index.js';
import { chunkLegalDocument } from '../server/parsers/legalDocChunker.js';

const oldPath = path.resolve(process.argv[2]);
const old = await import(pathToFileURL(oldPath).href);
const neu = await import('../server/reasoning/contractReview.js');
const samples = 'test/docs/review-samples';
const texts = [];
for (const f of fs.readdirSync(samples).filter(f => !f.endsWith('.md'))) {
  const parsed = await parseDocument(fs.readFileSync(path.join(samples, f)), f);
  texts.push(parsed.text, ...chunkLegalDocument(parsed.text).map(c => String(c.content || '')));
}
texts.push('을은 과업이 추가되더라도 증액 없이 수행한다.', '지체상금의 상한을 두지 아니한다.', '전속관할 법원은 서울중앙지방법원으로 한다.',
  '분쟁조정 신청을 포기한다.', '잔금은 검수 완료 후 90일 이내 지급', 'Background IP는 각자에게 존속한다.', '기존 모듈은 갑에게 귀속하며 재사용하지 못한다. 저작권');
const registryOf = text => ({ list: () => chunkLegalDocument(text).map((c, i) => ({ id: `D${i + 1}`, kind: 'DOCUMENT', text: String(c.content || ''), sourceSpan: null })) });
let diffs = 0;
for (const text of texts) {
  const a = JSON.stringify(old.buildContractInventory(registryOf(text), ''));
  const b = JSON.stringify(neu.buildContractInventory(registryOf(text), ''));
  if (a !== b) { diffs++; console.log('인벤토리 차이:', text.slice(0, 60)); }
  if (JSON.stringify(old.detectContractLawSeeds(text)) !== JSON.stringify(neu.detectContractLawSeeds(text))) { diffs++; console.log('씨앗 차이:', text.slice(0, 60)); }
}
console.log(`비교 ${texts.length}건, 차이 ${diffs}건`);
process.exitCode = diffs ? 1 : 0;
