@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 > nul
cd /d "%~dp0"

set "NON_INTERACTIVE=0"
if /i "%~1"=="--yes" set "NON_INTERACTIVE=1"
if /i "%~1"=="-y" set "NON_INTERACTIVE=1"

echo ============================================================================
echo   Legal Reviewer - 신규 PC 환경 자동 설치 및 초기 세팅 (setup.bat)
echo ============================================================================
echo.
echo   이 스크립트는 다음 항목을 자동으로 확인하고 준비합니다:
echo     1. Node.js 22 LTS 이상 설치 확인 및 자동 설치
echo     2. 프로젝트 필수 패키지 설치 (npm install)
echo     3. 로컬 LLM 엔진 Ollama 설치 확인 및 자동 설치
echo     4. Ollama 서비스 실행 및 모델 다운로드 (gemma4:e2b, bge-m3)
echo     5. 데이터 디렉토리 및 .env 환경설정 파일 생성
echo.

REM ----------------------------------------------------------------------------
REM [1/5] Node.js 22+ 확인 및 설치
REM ----------------------------------------------------------------------------
echo [1/5] Node.js (v22 이상) 확인 중...
call :check_node
if !NODE_OK! EQU 0 (
    echo   [INFO] Node.js 22 이상이 필요합니다. 자동 설치를 진행합니다...
    where winget > nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        echo   [INFO] winget으로 Node.js LTS를 설치합니다...
        winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    ) else (
        echo   [INFO] winget을 찾을 수 없어 공식 설치 파일을 다운로드합니다...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
            "$ErrorActionPreference='Stop';" ^
            "$rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.version -match '^v22\.' } | Select-Object -First 1;" ^
            "$ver = $rel.version;" ^
            "$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' };" ^
            "$url = \"https://nodejs.org/dist/$ver/node-$ver-$arch.msi\";" ^
            "$msi = Join-Path $env:TEMP \"node-$ver-$arch.msi\";" ^
            "Invoke-WebRequest -Uri $url -OutFile $msi;" ^
            "Start-Process msiexec.exe -ArgumentList \"/i `\"$msi`\" /passive /norestart\" -Wait"
    )
    call :refresh_path
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
    call :check_node
    if !NODE_OK! EQU 0 (
        echo.
        echo   [ERROR] Node.js 22 이상 설치 확인에 실패했습니다.
        echo           https://nodejs.org 에서 Node.js 22 LTS 이상을 직접 설치한 뒤
        echo           새 터미널 창에서 setup.bat 을 다시 실행해 주세요.
        if "!NON_INTERACTIVE!"=="0" pause
        exit /b 1
    )
)
for /f "delims=" %%v in ('node -v') do echo   [OK] Node.js %%v 확인 완료
echo.

REM ----------------------------------------------------------------------------
REM [2/5] npm 의존성 패키지 설치
REM ----------------------------------------------------------------------------
echo [2/5] 프로젝트 필수 패키지(npm) 설치 확인 중...
if exist "node_modules" (
    call npm install
) else if exist "package-lock.json" (
    call npm ci
) else (
    call npm install
)
if !ERRORLEVEL! NEQ 0 (
    echo   [ERROR] npm 패키지 설치 중 오류가 발생했습니다. 네트워크 상태를 확인해 주세요.
    if "!NON_INTERACTIVE!"=="0" pause
    exit /b 1
)
echo   [OK] npm 패키지 설치 완료
echo.

REM ----------------------------------------------------------------------------
REM [3/5] Ollama 설치 확인 및 자동 설치
REM ----------------------------------------------------------------------------
echo [3/5] 로컬 LLM 엔진(Ollama) 확인 중...
call :find_ollama
if !OLLAMA_FOUND! EQU 0 (
    echo   [INFO] Ollama가 설치되어 있지 않습니다. 자동 설치를 진행합니다...
    where winget > nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        echo   [INFO] winget으로 Ollama를 설치합니다...
        winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
    )
    call :refresh_path
    call :find_ollama
    if !OLLAMA_FOUND! EQU 0 (
        echo   [INFO] Ollama 공식 설치 프로그램을 다운로드합니다...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
            "$ErrorActionPreference='Stop';" ^
            "$exe = Join-Path $env:TEMP 'OllamaSetup.exe';" ^
            "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $exe;" ^
            "Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART' -Wait"
        call :refresh_path
        call :find_ollama
    )
    if !OLLAMA_FOUND! EQU 0 (
        echo.
        echo   [ERROR] Ollama 자동 설치를 완료하지 못했습니다.
        echo           https://ollama.com/download 에서 직접 설치 후 setup.bat 을 다시 실행해 주세요.
        if "!NON_INTERACTIVE!"=="0" pause
        exit /b 1
    )
)
for /f "delims=" %%v in ('ollama --version 2^>nul') do echo   [OK] %%v 확인 완료
echo.

REM ----------------------------------------------------------------------------
REM [4/5] Ollama 서버 기동 및 필수 모델 다운로드 (gemma4:e2b, bge-m3)
REM ----------------------------------------------------------------------------
echo [4/5] Ollama 서비스 상태 확인 및 AI 모델 설치 중...
call :ensure_ollama_running
if !ERRORLEVEL! NEQ 0 (
    echo   [ERROR] Ollama 서버를 시작하지 못했습니다. Ollama 앱을 실행한 뒤 다시 시도해 주세요.
    if "!NON_INTERACTIVE!"=="0" pause
    exit /b 1
)

echo   [INFO] 기본 법령 추론 모델(gemma4:e2b)을 확인/다운로드합니다... (최초 1회 약 7GB)
ollama pull gemma4:e2b
if !ERRORLEVEL! NEQ 0 (
    echo   [ERROR] gemma4:e2b 모델 다운로드에 실패했습니다. 인터넷 연결을 확인해 주세요.
    if "!NON_INTERACTIVE!"=="0" pause
    exit /b 1
)
echo   [OK] gemma4:e2b 준비 완료

echo   [INFO] 판례·해석례 의미 검색용 임베딩 모델(bge-m3)을 확인/다운로드합니다... (약 1.2GB)
ollama pull bge-m3
if !ERRORLEVEL! NEQ 0 (
    echo   [ERROR] bge-m3 모델 다운로드에 실패했습니다. 인터넷 연결을 확인해 주세요.
    if "!NON_INTERACTIVE!"=="0" pause
    exit /b 1
)
echo   [OK] bge-m3 준비 완료
echo.

REM ----------------------------------------------------------------------------
REM [5/5] 데이터 디렉토리 및 .env 환경설정 초기화
REM ----------------------------------------------------------------------------
echo [5/5] 데이터 디렉토리 및 .env 환경설정 준비 중...
if not exist "data\cache" mkdir "data\cache"
if not exist "data\uploads" mkdir "data\uploads"

if not exist ".env" (
    if exist ".env.example" (
        copy /y ".env.example" ".env" > nul
        echo   [OK] .env.example을 기반으로 .env 파일을 생성했습니다.
    ) else (
        echo   [WARN] .env.example 파일이 없어 기본 .env를 생성합니다.
        (
            echo PORT=3000
            echo HOST=127.0.0.1
            echo LAW_OC=
            echo LLM_PROVIDER=ollama
            echo OLLAMA_URL=http://localhost:11434
            echo OLLAMA_MODEL=gemma4:e2b
            echo OLLAMA_EMBED_MODEL=bge-m3
            echo LLM_TIMEOUT=900000
            echo SERVER_REQUEST_TIMEOUT=1200000
        ) > ".env"
    )

    if "!NON_INTERACTIVE!"=="0" (
        echo.
        echo   --------------------------------------------------------------------------
        echo   [선택] 국가법령정보센터 API 키(LAW_OC^) 설정
        echo   공식 법령·판례를 실시간 조회하려면 open.law.go.kr 에서 발급받은
        echo   OC(이메일 ID 앞부분 또는 신청 ID^)가 필요합니다.
        echo   지금 입력하지 않고 Enter를 누르면 나중에 .env 파일에서 직접 입력할 수 있습니다.
        echo   --------------------------------------------------------------------------
        set "USER_LAW_OC="
        set /p "USER_LAW_OC=  LAW_OC 입력 (건너뛰려면 Enter): "
        if not "!USER_LAW_OC!"=="" (
            powershell -NoProfile -ExecutionPolicy Bypass -Command ^
                "$p = '.env';" ^
                "$c = Get-Content $p -Raw -Encoding UTF8;" ^
                "$c = $c -replace '(?m)^LAW_OC=.*$', ('LAW_OC=' + $env:USER_LAW_OC);" ^
                "[System.IO.File]::WriteAllText((Resolve-Path $p), $c, (New-Object System.Text.UTF8Encoding $false))"
            echo   [OK] LAW_OC 값을 .env에 저장했습니다.
        ) else (
            echo   [INFO] LAW_OC 설정을 건너뛰었습니다. 추후 .env 파일의 LAW_OC= 항목에 입력해 주세요.
        )
    )
) else (
    echo   [OK] 기존 .env 파일이 이미 존재합니다. 기존 설정을 유지합니다.
)

echo.
echo ============================================================================
echo   모든 환경 세팅이 완료되었습니다.
echo   이제 start.bat 을 실행하면 서버와 웹 화면이 자동으로 시작됩니다.
echo ============================================================================
echo.
if "!NON_INTERACTIVE!"=="0" pause
exit /b 0

REM ============================================================================
REM 보조 서브루틴
REM ============================================================================
:check_node
set "NODE_OK=0"
where node > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
)
where node > nul 2>&1
if %ERRORLEVEL% NEQ 0 exit /b 0
for /f "delims=" %%m in ('node -p "parseInt(process.versions.node.split('.')[0], 10)" 2^>nul') do set "NODE_MAJOR=%%m"
if defined NODE_MAJOR if !NODE_MAJOR! GEQ 22 set "NODE_OK=1"
exit /b 0

:find_ollama
set "OLLAMA_FOUND=0"
where ollama > nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set "OLLAMA_FOUND=1"
    exit /b 0
)
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
    set "OLLAMA_FOUND=1"
    exit /b 0
)
if exist "%ProgramFiles%\Ollama\ollama.exe" (
    set "PATH=%ProgramFiles%\Ollama;%PATH%"
    set "OLLAMA_FOUND=1"
    exit /b 0
)
exit /b 0

:refresh_path
for /f "delims=" %%p in ('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"') do set "PATH=%%p"
exit /b 0

:probe_ollama
curl.exe -s -f --max-time 2 http://127.0.0.1:11434/api/tags > nul 2>&1
if %ERRORLEVEL% EQU 0 exit /b 0
ollama list > nul 2>&1
exit /b %ERRORLEVEL%

:ensure_ollama_running
call :probe_ollama
if %ERRORLEVEL% EQU 0 (
    echo   [OK] Ollama 서버가 이미 실행 중입니다.
    exit /b 0
)
echo   [INFO] Ollama 백그라운드 서비스를 시작하는 중...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
    start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
) else (
    start "" /B ollama serve > nul 2>&1
)
for /L %%i in (1,1,20) do (
    call :probe_ollama
    if !ERRORLEVEL! EQU 0 (
        echo   [OK] Ollama 서버가 준비되었습니다.
        exit /b 0
    )
    ping -n 2 127.0.0.1 > nul
)
exit /b 1
