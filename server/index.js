// server/index.js - Legal Review Standalone 메인 서버 진입점
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENV } from './env.js';
import { createRateLimitMiddleware } from './rateLimit.js';
import lawApiRouter from './law/lawApi.js';
import { maskLawSecrets } from './law/lawErrors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const app = express();

// 1. 기본 미들웨어
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 2. 요청 Rate Limiter (IP당 1분 120회)
app.use(createRateLimitMiddleware(120, 60000));

// 3. 정적 파일 서빙 (프론트엔드 UI)
app.use(express.static(path.join(projectRoot, 'public')));

// 4. API 라우터 마운트
app.use('/api/law', lawApiRouter);

// 5. 헬스 체크 엔드포인트
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Legal Reviewer Standalone',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// 6. SPA Fallback (index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'index.html'));
});

// 7. 전역 에러 핸들링 미들웨어
app.use((err, req, res, next) => {
  console.error('[ServerError]', maskLawSecrets(err.stack || err.message));
  res.status(err.statusCode || 500).json({
    ok: false,
    error: 'Internal Server Error',
    message: maskLawSecrets(err.message || '서버 오류가 발생했습니다.')
  });
});

// 서버 시작
const server = app.listen(ENV.PORT, ENV.HOST, () => {
  console.log(`\n======================================================`);
  console.log(`⚖️  Legal Reviewer Standalone Server Running!`);
  console.log(`   - Web URL:     http://localhost:${ENV.PORT}`);
  console.log(`   - Environment: Node.js ${process.version}`);
  console.log(`   - LLM Engine:  ${ENV.LLM_PROVIDER.toUpperCase()}`);
  console.log(`======================================================\n`);
});

export default app;
