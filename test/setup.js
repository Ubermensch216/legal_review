// Must be imported before any application module, including in direct test-file runs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'legal-review-test-'));
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.LAW_OC = '';
process.env.LAW_DEMO_MODE = 'false';
globalThis.fetch = async () => { throw new Error('Unit tests must inject fetch; network is disabled'); };

// 외부 제공자 어댑터는 가짜 응답으로 검증한다. 실제 전송이 아니므로 시험에서만 전송 게이트를 연다.
// 게이트 자체의 동작은 test/externalGate.test.js가 이 설정을 풀고 따로 확인한다.
const { setExternalTransmissionPolicyForTests } = await import('../server/reasoning/externalGate.js');
setExternalTransmissionPolicyForTests(() => true);
