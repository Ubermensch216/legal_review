$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Wait-ForKey {
    Write-Host ''
    Read-Host '계속하려면 Enter 키를 누르세요' | Out-Null
}

function Test-OllamaEndpoint {
    param([string]$Endpoint)
    $probeUrl = ($Endpoint -replace 'localhost', '127.0.0.1').TrimEnd('/') + '/api/tags'
    try {
        $res = Invoke-WebRequest -UseBasicParsing -Uri $probeUrl -TimeoutSec 2 -ErrorAction Stop
        if ($res.StatusCode -eq 200) { return $true }
    } catch {}
    $ollamaCmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($ollamaCmd) {
        $prevHost = $env:OLLAMA_HOST
        try {
            $env:OLLAMA_HOST = $Endpoint
            & $ollamaCmd.Source list *> $null
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch {} finally {
            $env:OLLAMA_HOST = $prevHost
        }
    }
    return $false
}

try {
    Write-Host '============================================================================'
    Write-Host '  Legal Reviewer - AI 법령검토 솔루션 시작 (start.bat)'
    Write-Host '============================================================================'
    Write-Host ''

    # 1. 기본 실행 환경 점검
    foreach ($extraDir in @(
        'C:\Program Files\nodejs',
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama'),
        (Join-Path $env:ProgramFiles 'Ollama')
    )) {
        if ($extraDir -and (Test-Path $extraDir) -and ($env:PATH -notlike "*$extraDir*")) {
            $env:PATH = "$extraDir;$env:PATH"
        }
    }

    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Host '[ERROR] Node.js가 설치되어 있지 않습니다. 먼저 setup.bat 을 실행해 주세요.'
        Wait-ForKey
        exit 1
    }

    if (-not (Test-Path 'node_modules')) {
        Write-Host '[INFO] 필수 패키지(node_modules)가 없어 설치를 진행합니다...'
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npmCmd) {
            Write-Host '[ERROR] npm.cmd 를 찾을 수 없습니다. setup.bat 을 먼저 실행해 주세요.'
            Wait-ForKey
            exit 1
        }
        & $npmCmd.Source install
        if ($LASTEXITCODE -ne 0) {
            Write-Host '[ERROR] npm install 에 실패했습니다. setup.bat 을 먼저 실행해 주세요.'
            Wait-ForKey
            exit 1
        }
    }

    if (-not (Test-Path '.env')) {
        if (Test-Path '.env.example') {
            Copy-Item -Path '.env.example' -Destination '.env' -Force
            Write-Host '[INFO] .env 파일이 없어 .env.example을 복사해 기본 설정을 생성했습니다.'
            Write-Host '       공식 법령 조회를 위해 .env 파일에 LAW_OC 값을 입력해 주세요.'
        }
    }

    # 2. .env에서 PORT / LLM_PROVIDER / OLLAMA_URL 읽기
    $appPort = 3000
    $llmProv = 'ollama'
    $ollamaEndpoint = 'http://localhost:11434'
    if (Test-Path '.env') {
        foreach ($line in [System.IO.File]::ReadAllLines((Resolve-Path '.env').Path, [System.Text.Encoding]::UTF8)) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
            $idx = $trimmed.IndexOf('=')
            if ($idx -lt 1) { continue }
            $k = $trimmed.Substring(0, $idx).Trim()
            $v = $trimmed.Substring($idx + 1).Trim()
            if (-not $v) { continue }
            if ($k -ieq 'PORT') {
                $parsed = 0
                if ([int]::TryParse($v, [ref]$parsed)) { $appPort = $parsed }
            } elseif ($k -ieq 'LLM_PROVIDER') {
                $llmProv = $v
            } elseif ($k -ieq 'OLLAMA_URL') {
                $ollamaEndpoint = $v
            }
        }
    }

    # 3. 로컬 Ollama 엔진 확인 및 필요 시 자동 기동
    if ($llmProv -ieq 'ollama') {
        if (-not (Test-OllamaEndpoint -Endpoint $ollamaEndpoint)) {
            $ollamaCmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
            if ($ollamaCmd) {
                Write-Host '[INFO] Ollama 서비스가 꺼져 있어 백그라운드에서 시작합니다...'
                $ollamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
                if (Test-Path $ollamaApp) {
                    Start-Process -FilePath $ollamaApp | Out-Null
                } else {
                    Start-Process -FilePath $ollamaCmd.Source -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
                }
                $ready = $false
                for ($i = 1; $i -le 15; $i++) {
                    if (Test-OllamaEndpoint -Endpoint $ollamaEndpoint) {
                        $ready = $true
                        break
                    }
                    Start-Sleep -Seconds 2
                }
                if (-not $ready) {
                    Write-Host '[WARN] Ollama 응답 확인이 지연되고 있습니다. 서버는 계속 시작합니다.'
                }
            } else {
                Write-Host '[WARN] Ollama가 설치되어 있지 않습니다. 로컬 모델 사용 시 setup.bat 을 실행하세요.'
            }
        } else {
            Write-Host "[OK] Ollama 로컬 LLM 서비스 연결 확인: $ollamaEndpoint"
        }
    }

    # 4. 서버 준비 완료 시 기본 브라우저 자동 실행 (백그라운드 감시)
    Write-Host "[INFO] Legal Reviewer 서버를 시작합니다... (http://localhost:$appPort)"
    Write-Host '[INFO] 서버가 준비되면 기본 웹 브라우저가 자동으로 열립니다.'
    Write-Host '[INFO] 종료하려면 이 창에서 Ctrl+C를 누르거나 창을 닫으세요.'
    Write-Host ''

    $watchCmd = @"
`$basePort = $appPort;
for (`$try = 0; `$try -lt 40; `$try++) {
  foreach (`$p in @(`$basePort, `$basePort+1, `$basePort+2, `$basePort+3, `$basePort+4)) {
    try {
      `$res = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + `$p + '/health') -TimeoutSec 2;
      if (`$res.StatusCode -eq 200) { Start-Process ('http://localhost:' + `$p); exit 0 }
    } catch {}
  }
  Start-Sleep -Milliseconds 500;
}
"@
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-Command', $watchCmd) -WindowStyle Hidden | Out-Null

    & $nodeCmd.Source 'server/index.js'
    Write-Host ''
    Write-Host '[INFO] 서버가 종료되었습니다.'
    Wait-ForKey
    exit 0
} catch {
    Write-Host ''
    Write-Host "[ERROR] 서버 실행 중 오류가 발생했습니다: $($_.Exception.Message)"
    Wait-ForKey
    exit 1
}
