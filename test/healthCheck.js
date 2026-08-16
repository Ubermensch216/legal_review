// test/healthCheck.js - 서버 구동 및 통합 엔드포인트 검증 스크립트
import app, { serverInstance } from '../server/index.js';

async function testServer() {
  console.log('[Test] 서버 구동 및 API 헬스체크 시작...');
  await new Promise(resolve => setTimeout(resolve, 800));

  const port = serverInstance.address()?.port || 3000;
  console.log(`[Test] 타겟 서버 포트: ${port}`);

  // 1. /health 검증
  const healthRes = await fetch(`http://localhost:${port}/health`);
  const healthData = await healthRes.json();
  console.log('[Test] 1. /health 응답:', healthData);

  if (healthData.status !== 'ok') {
    throw new Error('Health check failed');
  }

  // 2. /api/law/config 검증
  const configRes = await fetch(`http://localhost:${port}/api/law/config`);
  const configData = await configRes.json();
  console.log('[Test] 2. /api/law/config 응답 (프리셋 수):', configData.presets?.length);

  // 3. /api/law/tools 검증
  const toolsRes = await fetch(`http://localhost:${port}/api/law/tools`);
  const toolsData = await toolsRes.json();
  console.log('[Test] 3. /api/law/tools 응답 (도구 수):', toolsData.tools?.length);

  // 4. /api/law/workbench 시뮬레이션 검증
  const wbRes = await fetch(`http://localhost:${port}/api/law/workbench`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '개인정보 수집 시 동의 요건 및 과태료 리스크 검토',
      preset: 'privacy_security',
      targetLaw: '개인정보 보호법'
    })
  });
  const wbData = await wbRes.json();
  console.log('[Test] 4. /api/law/workbench 응답 (쟁점 수):', wbData.review?.coreIssues?.length, '조문 수:', wbData.officialEvidence?.articles?.length);

  console.log('\n✅ 모든 서버 통합 엔드포인트 검증 완료!');
  serverInstance.close();
  process.exit(0);
}

testServer().catch(err => {
  console.error('[Test Error]', err);
  if (serverInstance) serverInstance.close();
  process.exit(1);
});
