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
