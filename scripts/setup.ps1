param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$NonInteractive = $false
if ($ExtraArgs) {
    foreach ($arg in $ExtraArgs) {
        if ($arg -ieq '--yes' -or $arg -ieq '-y') {
            $NonInteractive = $true
        }
    }
}

function Wait-IfInteractive {
    if (-not $NonInteractive) {
        Write-Host ''
        Read-Host '계속하려면 Enter 키를 누르세요' | Out-Null
    }
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($machinePath) { $parts += $machinePath }
    if ($userPath) { $parts += $userPath }
    if ($parts.Count -gt 0) {
        $env:PATH = ($parts -join ';')
    }
    foreach ($extraDir in @(
        'C:\Program Files\nodejs',
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama'),
        (Join-Path $env:ProgramFiles 'Ollama')
    )) {
        if ($extraDir -and (Test-Path $extraDir) -and ($env:PATH -notlike "*$extraDir*")) {
            $env:PATH = "$extraDir;$env:PATH"
        }
    }
}

function Test-Node22 {
    Refresh-ProcessPath
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) {
        return $false
    }
    try {
        $verText = (& $cmd.Source -p "parseInt(process.versions.node.split('.')[0], 10)" 2>$null | Out-String).Trim()
        $major = 0
        if ([int]::TryParse($verText, [ref]$major) -and $major -ge 22) {
            return $true
        }
    } catch {}
    return $false
}

function Find-Ollama {
    Refresh-ProcessPath
    $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
        (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
    )) {
        if ($candidate -and (Test-Path $candidate)) {
            $dir = Split-Path -Parent $candidate
            if ($env:PATH -notlike "*$dir*") {
                $env:PATH = "$dir;$env:PATH"
            }
            return $candidate
        }
    }
    return $null
}

function Test-OllamaRunning {
    try {
        $res = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 -ErrorAction Stop
        if ($res.StatusCode -eq 200) { return $true }
    } catch {}
    $ollamaExe = Find-Ollama
    if ($ollamaExe) {
        try {
            & $ollamaExe list *> $null
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch {}
    }
    return $false
}

function Ensure-OllamaRunning {
    if (Test-OllamaRunning) {
        Write-Host '  [OK] Ollama 서버가 이미 실행 중입니다.'
        return $true
    }
    Write-Host '  [INFO] Ollama 백그라운드 서비스를 시작하는 중...'
    $ollamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
    if (Test-Path $ollamaApp) {
        Start-Process -FilePath $ollamaApp | Out-Null
    } else {
        $ollamaExe = Find-Ollama
        if (-not $ollamaExe) { return $false }
        Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
    }
    for ($i = 1; $i -le 20; $i++) {
        if (Test-OllamaRunning) {
            Write-Host '  [OK] Ollama 서버가 준비되었습니다.'
            return $true
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Install-NodeOfficial {
    Write-Host '  [INFO] 공식 사이트(nodejs.org)에서 Node.js 22 LTS 설치 파일을 다운로드합니다...'
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 30
        $rel = $releases | Where-Object { $_.version -match '^v22\.' } | Select-Object -First 1
        if (-not $rel) {
            throw 'Node.js v22 릴리스 정보를 찾을 수 없습니다.'
        }
        $ver = $rel.version
        if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
            $arch = 'arm64'
        } elseif ([Environment]::Is64BitOperatingSystem) {
            $arch = 'x64'
        } else {
            $arch = 'x86'
        }
        $url = "https://nodejs.org/dist/$ver/node-$ver-$arch.msi"
        $msi = Join-Path $env:TEMP "node-$ver-$arch.msi"
        Write-Host "  [INFO] 다운로드 중: $url"
        Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing -TimeoutSec 300
        Write-Host '  [INFO] Node.js 설치 프로그램을 실행합니다... (관리자 권한 확인 창이 뜨면 허용해 주세요)'
        $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/passive', '/norestart') -Wait -PassThru
        if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
            throw "Node.js MSI 설치가 실패했습니다 (종료 코드: $($proc.ExitCode))."
        }
    } finally {
        $ProgressPreference = $prevProgress
    }
}

function Install-OllamaOfficial {
    Write-Host '  [INFO] Ollama 공식 설치 프로그램을 다운로드합니다...'
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        $exe = Join-Path $env:TEMP 'OllamaSetup.exe'
        Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $exe -UseBasicParsing -TimeoutSec 600
        Write-Host '  [INFO] Ollama를 설치하는 중입니다...'
        $proc = Start-Process -FilePath $exe -ArgumentList @('/VERYSILENT', '/NORESTART') -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            throw "Ollama 설치 프로그램이 실패했습니다 (종료 코드: $($proc.ExitCode))."
        }
    } finally {
        $ProgressPreference = $prevProgress
    }
}

try {
    Write-Host '============================================================================'
    Write-Host '  Legal Reviewer - 신규 PC 환경 자동 설치 및 초기 세팅 (setup.bat)'
    Write-Host '============================================================================'
    Write-Host ''
    Write-Host '  이 스크립트는 다음 항목을 자동으로 확인하고 준비합니다:'
    Write-Host '    1. Node.js 22 LTS 이상 설치 확인 및 자동 설치'
    Write-Host '    2. 프로젝트 필수 패키지 설치 (npm install)'
    Write-Host '    3. 로컬 LLM 엔진 Ollama 설치 확인 및 자동 설치'
    Write-Host '    4. Ollama 서비스 실행 및 모델 다운로드 (gemma4:e2b, bge-m3)'
    Write-Host '    5. 데이터 디렉토리 및 .env 환경설정 파일 생성'
    Write-Host ''

    $wingetFailed = $false

    # --------------------------------------------------------------------------
    # [1/5] Node.js 22+ 확인 및 설치
    # --------------------------------------------------------------------------
    Write-Host '[1/5] Node.js (v22 이상) 확인 중...'
    if (-not (Test-Node22)) {
        Write-Host '  [INFO] Node.js 22 이상이 필요합니다. 자동 설치를 진행합니다...'
        $wingetCmd = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($wingetCmd) {
            Write-Host '  [INFO] winget으로 Node.js LTS 설치를 시도합니다...'
            & $wingetCmd.Source install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) {
                $wingetFailed = $true
                Write-Host "  [WARN] winget 설치에 실패했습니다 (종료 코드: $LASTEXITCODE). 공식 설치 파일로 자동 전환합니다..."
            }
        }
        if (-not (Test-Node22)) {
            Install-NodeOfficial
        }
        if (-not (Test-Node22)) {
            Write-Host ''
            Write-Host '  [ERROR] Node.js 22 이상 설치 확인에 실패했습니다.'
            Write-Host '          https://nodejs.org 에서 Node.js 22 LTS 이상을 직접 설치한 뒤'
            Write-Host '          새 터미널 창에서 setup.bat 을 다시 실행해 주세요.'
            Wait-IfInteractive
            exit 1
        }
    }
    $nodeVer = (& node.exe -v 2>$null | Out-String).Trim()
    Write-Host "  [OK] Node.js $nodeVer 확인 완료"
    Write-Host ''

    # --------------------------------------------------------------------------
    # [2/5] npm 의존성 패키지 설치
    # --------------------------------------------------------------------------
    Write-Host '[2/5] 프로젝트 필수 패키지(npm) 설치 확인 중...'
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        throw 'npm.cmd 를 찾을 수 없습니다. Node.js 설치 상태를 확인해 주세요.'
    }
    if (Test-Path 'node_modules') {
        & $npmCmd.Source install
    } elseif (Test-Path 'package-lock.json') {
        & $npmCmd.Source ci
    } else {
        & $npmCmd.Source install
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  [ERROR] npm 패키지 설치 중 오류가 발생했습니다. 네트워크 상태를 확인해 주세요.'
        Wait-IfInteractive
        exit 1
    }
    Write-Host '  [OK] npm 패키지 설치 완료'
    Write-Host ''

    # --------------------------------------------------------------------------
    # [3/5] Ollama 설치 확인 및 자동 설치
    # --------------------------------------------------------------------------
    Write-Host '[3/5] 로컬 LLM 엔진(Ollama) 확인 중...'
    $ollamaExe = Find-Ollama
    if (-not $ollamaExe) {
        Write-Host '  [INFO] Ollama가 설치되어 있지 않습니다. 자동 설치를 진행합니다...'
        $wingetCmd = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($wingetCmd -and (-not $wingetFailed)) {
            Write-Host '  [INFO] winget으로 Ollama 설치를 시도합니다...'
            & $wingetCmd.Source install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  [WARN] winget 설치에 실패했습니다 (종료 코드: $LASTEXITCODE). 공식 설치 파일로 자동 전환합니다..."
            }
            $ollamaExe = Find-Ollama
        }
        if (-not $ollamaExe) {
            Install-OllamaOfficial
            $ollamaExe = Find-Ollama
        }
        if (-not $ollamaExe) {
            Write-Host ''
            Write-Host '  [ERROR] Ollama 자동 설치를 완료하지 못했습니다.'
            Write-Host '          https://ollama.com/download 에서 직접 설치 후 setup.bat 을 다시 실행해 주세요.'
            Wait-IfInteractive
            exit 1
        }
    }
    $ollamaVer = (& $ollamaExe --version 2>$null | Out-String).Trim()
    if (-not $ollamaVer) { $ollamaVer = 'Ollama' }
    Write-Host "  [OK] $ollamaVer 확인 완료"
    Write-Host ''

    # --------------------------------------------------------------------------
    # [4/5] Ollama 서버 기동 및 필수 모델 다운로드 (gemma4:e2b, bge-m3)
    # --------------------------------------------------------------------------
    Write-Host '[4/5] Ollama 서비스 상태 확인 및 AI 모델 설치 중...'
    if (-not (Ensure-OllamaRunning)) {
        Write-Host '  [ERROR] Ollama 서버를 시작하지 못했습니다. Ollama 앱을 실행한 뒤 다시 시도해 주세요.'
        Wait-IfInteractive
        exit 1
    }

    Write-Host '  [INFO] 기본 법령 추론 모델(gemma4:e2b)을 확인/다운로드합니다... (최초 1회 약 7GB)'
    & $ollamaExe pull gemma4:e2b
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  [ERROR] gemma4:e2b 모델 다운로드에 실패했습니다. 인터넷 연결을 확인해 주세요.'
        Wait-IfInteractive
        exit 1
    }
    Write-Host '  [OK] gemma4:e2b 준비 완료'

    Write-Host '  [INFO] 판례·해석례 의미 검색용 임베딩 모델(bge-m3)을 확인/다운로드합니다... (약 1.2GB)'
    & $ollamaExe pull bge-m3
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  [ERROR] bge-m3 모델 다운로드에 실패했습니다. 인터넷 연결을 확인해 주세요.'
        Wait-IfInteractive
        exit 1
    }
    Write-Host '  [OK] bge-m3 준비 완료'
    Write-Host ''

    # --------------------------------------------------------------------------
    # [5/5] 데이터 디렉토리 및 .env 환경설정 초기화
    # --------------------------------------------------------------------------
    Write-Host '[5/5] 데이터 디렉토리 및 .env 환경설정 준비 중...'
    New-Item -ItemType Directory -Force -Path 'data\cache' | Out-Null
    New-Item -ItemType Directory -Force -Path 'data\uploads' | Out-Null

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    if (-not (Test-Path '.env')) {
        if (Test-Path '.env.example') {
            Copy-Item -Path '.env.example' -Destination '.env' -Force
            Write-Host '  [OK] .env.example을 기반으로 .env 파일을 생성했습니다.'
        } else {
            Write-Host '  [WARN] .env.example 파일이 없어 기본 .env를 생성합니다.'
            $defaultEnv = @(
                'PORT=3000'
                'HOST=127.0.0.1'
                'LAW_OC='
                'LLM_PROVIDER=ollama'
                'OLLAMA_URL=http://localhost:11434'
                'OLLAMA_MODEL=gemma4:e2b'
                'OLLAMA_EMBED_MODEL=bge-m3'
                'LLM_TIMEOUT=900000'
                'SERVER_REQUEST_TIMEOUT=1200000'
            ) -join "`r`n"
            [System.IO.File]::WriteAllText((Join-Path $ProjectRoot '.env'), $defaultEnv + "`r`n", $utf8NoBom)
        }

        if (-not $NonInteractive) {
            Write-Host ''
            Write-Host '  --------------------------------------------------------------------------'
            Write-Host '  [선택] 국가법령정보센터 API 키(LAW_OC) 설정'
            Write-Host '  공식 법령·판례를 실시간 조회하려면 open.law.go.kr 에서 발급받은'
            Write-Host '  OC(이메일 ID 앞부분 또는 신청 ID)가 필요합니다.'
            Write-Host '  지금 입력하지 않고 Enter를 누르면 나중에 .env 파일에서 직접 입력할 수 있습니다.'
            Write-Host '  --------------------------------------------------------------------------'
            $userLawOc = (Read-Host '  LAW_OC 입력 (건너뛰려면 Enter)').Trim()
            if ($userLawOc) {
                $envPath = (Resolve-Path '.env').Path
                $envContent = [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::UTF8)
                $envContent = [regex]::Replace($envContent, '(?m)^LAW_OC=.*$', ('LAW_OC=' + $userLawOc))
                [System.IO.File]::WriteAllText($envPath, $envContent, $utf8NoBom)
                Write-Host '  [OK] LAW_OC 값을 .env에 저장했습니다.'
            } else {
                Write-Host '  [INFO] LAW_OC 설정을 건너뛰었습니다. 추후 .env 파일의 LAW_OC= 항목에 입력해 주세요.'
            }
        }
    } else {
        Write-Host '  [OK] 기존 .env 파일이 이미 존재합니다. 기존 설정을 유지합니다.'
    }

    Write-Host ''
    Write-Host '============================================================================'
    Write-Host '  모든 환경 세팅이 완료되었습니다.'
    Write-Host '  이제 start.bat 을 실행하면 서버와 웹 화면이 자동으로 시작됩니다.'
    Write-Host '============================================================================'
    Wait-IfInteractive
    exit 0
} catch {
    Write-Host ''
    Write-Host "  [ERROR] 설치 중 예기치 않은 오류가 발생했습니다: $($_.Exception.Message)"
    Wait-IfInteractive
    exit 1
}
