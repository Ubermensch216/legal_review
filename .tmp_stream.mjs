import './server/env.js';
import fs from 'fs';
// callOllama는 비공개이므로 소스에서 함수만 떼어내 같은 조건으로 돌린다.
const src = fs.readFileSync('server/law/lawWorkbenchReview.js', 'utf8');
const start = src.indexOf('async function callOllama');
const end = src.indexOf('\n}\n', src.indexOf('return { content, tokenUsage'));
const body = src.slice(start, end + 2);
const mod = `import { ENV } from './server/env.js';
import { readTokenUsage } from './server/law/llmBudget.js';
export ${body}`;
fs.writeFileSync('.tmp_callOllama.mjs', mod);
const { callOllama } = await import('./.tmp_callOllama.mjs');

const budget = { contextTokens: 16384, outputTokens: 8192 };
const t = Date.now();
const res = await callOllama(
  'You are a JSON generator. Output only JSON.',
  'Produce a JSON object {"items":[...]} whose "items" array contains 900 distinct short sentences about Korean administrative law. Do not stop early.',
  { budget }
);
const secs = (Date.now() - t) / 1000;
console.log('elapsed:', secs.toFixed(1), 's');
console.log('content chars:', res.content.length);
console.log('tokenUsage:', JSON.stringify(res.tokenUsage));
console.log(secs > 300 ? 'PASS: 300초 초과 생성이 fetch failed 없이 완료됨' : 'NOTE: 300초 미만으로 끝나 한도 초과는 재현 안 됨');
