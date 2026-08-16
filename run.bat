@echo off
chcp 65001 > nul
echo ========================================================
echo   Legal Reviewer - AI 법령검토 솔루션 시작
echo ========================================================
echo.

if not exist node_modules (
  echo [INFO] 필수 패키지 설치 중...
  call npm install
)

echo [INFO] 서버를 시작합니다... (http://localhost:3000)
node server/index.js
pause
