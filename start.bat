@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 > nul
cd /d "%~dp0"

echo ============================================================================
echo   Legal Reviewer - AI 법령검토 솔루션 시작 (start.bat)
echo ============================================================================
echo.

REM 1. 기본 실행 환경 점검
where node > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
)
where node > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js가 설치되어 있지 않습니다. 먼저 setup.bat 을 실행해 주세요.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] 필수 패키지(node_modules^)가 없어 설치를 진행합니다...
    call npm install
    if !ERRORLEVEL! NEQ 0 (
        echo [ERROR] npm install 에 실패했습니다. setup.bat 을 먼저 실행해 주세요.
        pause
        exit /b 1
    )
)

if not exist ".env" (
    if exist ".env.example" (
        copy /y ".env.example" ".env" > nul
        echo [INFO] .env 파일이 없어 .env.example을 복사해 기본 설정을 생성했습니다.
        echo        공식 법령 조회를 위해 .env 파일에 LAW_OC 값을 입력해 주세요.
    )
)

REM 2. .env에서 PORT / LLM_PROVIDER / OLLAMA_URL 읽기
set "APP_PORT=3000"
set "LLM_PROV=ollama"
set "OLLAMA_ENDPOINT=http://localhost:11434"
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set "K=%%a"
        if not "!K:~0,1!"=="#" (
            if /i "!K!"=="PORT" if not "%%b"=="" set "APP_PORT=%%b"
            if /i "!K!"=="LLM_PROVIDER" if not "%%b"=="" set "LLM_PROV=%%b"
            if /i "!K!"=="OLLAMA_URL" if not "%%b"=="" set "OLLAMA_ENDPOINT=%%b"
        )
    )
)

REM 3. 로컬 Ollama 엔진 확인 및 필요 시 자동 기동
if /i "%LLM_PROV%"=="ollama" (
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
    call :probe_ollama
    if !ERRORLEVEL! NEQ 0 (
        where ollama > nul 2>&1
        if !ERRORLEVEL! EQU 0 (
            echo [INFO] Ollama 서비스가 꺼져 있어 백그라운드에서 시작합니다...
            if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
                start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
            ) else (
                start "" /B ollama serve > nul 2>&1
            )
            for /L %%i in (1,1,15) do (
                call :probe_ollama
                if !ERRORLEVEL! EQU 0 goto :ollama_ready
                ping -n 2 127.0.0.1 > nul
            )
            echo [WARN] Ollama 응답 확인이 지연되고 있습니다. 서버는 계속 시작합니다.
        ) else (
            echo [WARN] Ollama가 설치되어 있지 않습니다. 로컬 모델 사용 시 setup.bat 을 실행하세요.
        )
    ) else (
        echo [OK] Ollama 로컬 LLM 서비스 연결 확인: %OLLAMA_ENDPOINT%
    )
)
:ollama_ready

REM 4. 서버 준비 완료 시 기본 브라우저 자동 실행 (백그라운드 감시)
echo [INFO] Legal Reviewer 서버를 시작합니다... (http://localhost:%APP_PORT%)
echo [INFO] 서버가 준비되면 기본 웹 브라우저가 자동으로 열립니다.
echo [INFO] 종료하려면 이 창에서 Ctrl+C를 누르거나 창을 닫으세요.
echo.

start "" /B powershell -NoProfile -WindowStyle Hidden -Command ^
    "$basePort = %APP_PORT%;" ^
    "for ($try = 0; $try -lt 40; $try++) {" ^
    "  foreach ($p in @($basePort, $basePort+1, $basePort+2, $basePort+3, $basePort+4)) {" ^
    "    try {" ^
    "      $res = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $p + '/health') -TimeoutSec 2;" ^
    "      if ($res.StatusCode -eq 200) { Start-Process ('http://localhost:' + $p); exit 0 }" ^
    "    } catch {}" ^
    "  }" ^
    "  Start-Sleep -Milliseconds 500;" ^
    "}"

node server/index.js
echo.
echo [INFO] 서버가 종료되었습니다.
pause
exit /b 0

:probe_ollama
set "OLLAMA_PROBE_URL=%OLLAMA_ENDPOINT:localhost=127.0.0.1%"
curl.exe -s -f --max-time 2 "%OLLAMA_PROBE_URL%/api/tags" > nul 2>&1
if %ERRORLEVEL% EQU 0 exit /b 0
set "OLLAMA_HOST=%OLLAMA_ENDPOINT%"
ollama list > nul 2>&1
exit /b %ERRORLEVEL%
