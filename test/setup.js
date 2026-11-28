// Must be imported before any application module, including in direct test-file runs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'legal-review-test-'));
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.LAW_OC = '';
process.env.LAW_DEMO_MODE = 'false';
// 사용자 .env의 모델 예산 조정(LLM_MODEL_BUDGETS 등)이 단위 시험의 분할 임계치를 바꾸지 않게 한다.
// dotenv는 이미 있는 키를 덮어쓰지 않으므로 빈 값으로 고정하면 기본 예산으로 시험한다.
process.env.LLM_MODEL_BUDGETS = '';
process.env.LLM_SECTION_BUDGETS = '';
process.env.REVIEW_SKILLS = process.env.REVIEW_SKILLS_TEST || 'off';
globalThis.fetch = async () => { throw new Error('Unit tests must inject fetch; network is disabled'); };

// 외부 제공자 어댑터는 가짜 응답으로 검증한다. 실제 전송이 아니므로 시험에서만 전송 게이트를 연다.
// 게이트 자체의 동작은 test/externalGate.test.js가 이 설정을 풀고 따로 확인한다.
const { setExternalTransmissionPolicyForTests } = await import('../server/reasoning/externalGate.js');
setExternalTransmissionPolicyForTests(() => true);
