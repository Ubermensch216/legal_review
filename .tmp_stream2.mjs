import './server/env.js';
const { callOllama } = await import('./.tmp_callOllama.mjs');
const t = Date.now();
try {
  const res = await callOllama('You are a JSON generator. Output only JSON.',
    'Produce a JSON object {"items":[...]} with 900 distinct short sentences about Korean administrative law. Do not stop early.',
    { budget: { contextTokens: 16384, outputTokens: 8192 } });
  console.log('완료 content chars:', res.content.length, JSON.stringify(res.tokenUsage));
} catch (err) {
  console.log('error:', err.message, '| outputTokens:', err.tokenUsage?.outputTokens);
}
const secs = (Date.now() - t) / 1000;
console.log('elapsed:', secs.toFixed(1), 's');
console.log(secs > 300 ? 'PASS: 300초 헤더 타임아웃을 넘겨도 fetch failed 없음' : 'FAIL/NOTE: 300초 미만');
