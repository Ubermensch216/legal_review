import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// .env 로드
dotenv.config();

const cacheDir = process.env.CACHE_DIR || path.join(process.cwd(), 'data', 'cache');
const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');

// 필수 디렉토리 확인 및 생성
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

export const ENV = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',

  // API Keys
  LAW_OC: process.env.LAW_OC || '',
  DECISIONS_API_KEY: process.env.DECISIONS_API_KEY || '',
  HUNZAE_API_KEY: process.env.HUNZAE_API_KEY || '',

  // LLM Config
  LLM_PROVIDER: (process.env.LLM_PROVIDER || 'ollama').toLowerCase(),
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen2.5:14b',

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o',

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Paths
  CACHE_DIR: cacheDir,
  UPLOAD_DIR: uploadDir,
};

export default ENV;
