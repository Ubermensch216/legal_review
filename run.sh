#!/usr/bin/env bash
echo "========================================================"
echo "  Legal Reviewer - AI 법령검토 솔루션 시작"
echo "========================================================"

if [ ! -d "node_modules" ]; then
  echo "[INFO] 필수 패키지 설치 중..."
  npm install
fi

echo "[INFO] 서버를 시작합니다... (http://localhost:3000)"
node server/index.js
