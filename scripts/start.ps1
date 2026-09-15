param([switch]$Remote)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot '.data\config.json'

& (Join-Path $PSScriptRoot 'setup.ps1') -SkipNpm
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

$env:OPENDRAW_HOST = '127.0.0.1'
$env:OPENDRAW_PORT = [string]$config.port
$env:OPENDRAW_CONTROL_SECRET = [string]$config.controlSecret

function Get-OpenDrawHealth([int]$Port) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        if ($response.StatusCode -ne 200) { return $null }
        $body = $response.Content | ConvertFrom-Json
        if ($body.ok -eq $true -and [string]$body.app -eq 'opendraw') { return $body }
    } catch {
        return $null
    }
    return $null
}

function Get-ListeningProcessId([int]$Port) {
    try {
        $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($listener) { return [int]$listener.OwningProcess }
    } catch {
        return $null
    }
    return $null
}

function Get-ProcessStartTicks([int]$ProcessId) {
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return [long]$process.StartTime.ToUniversalTime().Ticks
    } catch {
        return $null
    }
}

function Test-SameProcess([int]$ProcessId, [long]$StartTicks) {
    $currentTicks = Get-ProcessStartTicks -ProcessId $ProcessId
    return $null -ne $currentTicks -and $currentTicks -eq $StartTicks
}

function Request-OpenDrawRestart([int]$Port, [string]$ControlSecret) {
    if ([string]::IsNullOrWhiteSpace($ControlSecret)) { return $false }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/api/internal/restart" -Headers @{ 'X-OpenDraw-Control' = $ControlSecret } -ContentType 'application/json' -Body '{}' -TimeoutSec 2
        return $response.StatusCode -eq 202
    } catch {
        return $false
    }
}

$existingHealth = Get-OpenDrawHealth -Port ([int]$config.port)
if ($existingHealth) {
    $existingPid = Get-ListeningProcessId -Port ([int]$config.port)
    if (-not $existingPid) {
        throw "OpenDraw answered health checks on port $($config.port), but its listener process could not be identified safely."
    }
    $existingStartTicks = Get-ProcessStartTicks -ProcessId $existingPid
    if ($null -eq $existingStartTicks) {
        throw "OpenDraw listener process $existingPid disappeared before restart ownership could be established."
    }

    Write-Host ''
    Write-Host "OpenDraw is already running on http://127.0.0.1:$($config.port)/" -ForegroundColor Yellow
    Write-Host "Restarting the existing private OpenDraw service (PID $existingPid)..."

    $restartRequested = Request-OpenDrawRestart -Port ([int]$config.port) -ControlSecret ([string]$config.controlSecret)
    if (-not $restartRequested) {
        # Compatibility path for an already-running OpenDraw version that predates the
        # authenticated internal restart endpoint.
        $signalScript = Join-Path $PSScriptRoot 'signal-console.ps1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $signalScript -TargetPid $existingPid
    }

    $restartDeadline = [DateTime]::UtcNow.AddSeconds(6)
    do {
        Start-Sleep -Milliseconds 200
        $stillListening = Get-ListeningProcessId -Port ([int]$config.port)
        $oldProcessAlive = Test-SameProcess -ProcessId $existingPid -StartTicks $existingStartTicks
    } while (($stillListening -or $oldProcessAlive) -and [DateTime]::UtcNow -lt $restartDeadline)

    if ($stillListening -or $oldProcessAlive) {
        # The user explicitly started the launcher again, which means they requested a
        # full restart. Before the compatibility fallback, re-verify that the exact PID
        # is still the same process. If it still owns the port, also require a healthy
        # OpenDraw response before terminating the tree.
        if (-not (Test-SameProcess -ProcessId $existingPid -StartTicks $existingStartTicks)) {
            throw 'OpenDraw restart ownership changed while waiting for the old process. Refusing to terminate an unverified process.'
        }
        if ($stillListening) {
            $verifiedHealth = Get-OpenDrawHealth -Port ([int]$config.port)
            $verifiedPid = Get-ListeningProcessId -Port ([int]$config.port)
            if (-not $verifiedHealth -or $verifiedPid -ne $existingPid) {
                throw "OpenDraw restart ownership changed while waiting for port $($config.port). Refusing to terminate an unverified process."
            }
        }

        Write-Host 'Graceful restart was unavailable. Restarting the verified old OpenDraw process tree...' -ForegroundColor Yellow
        & taskkill.exe /PID $existingPid /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not terminate the verified old OpenDraw process tree (PID $existingPid)."
        }

        $forceDeadline = [DateTime]::UtcNow.AddSeconds(6)
        do {
            Start-Sleep -Milliseconds 200
            $stillListening = Get-ListeningProcessId -Port ([int]$config.port)
            $oldProcessAlive = Test-SameProcess -ProcessId $existingPid -StartTicks $existingStartTicks
        } while (($stillListening -or $oldProcessAlive) -and [DateTime]::UtcNow -lt $forceDeadline)

        if ($stillListening -or $oldProcessAlive) {
            throw "The verified old OpenDraw process tree did not fully exit before the restart deadline."
        }
    }

    Write-Host 'Existing OpenDraw service stopped cleanly. Starting a fresh instance...' -ForegroundColor Green
}

$portOwner = Get-ListeningProcessId -Port ([int]$config.port)
if ($portOwner) {
    throw "Port $($config.port) is already in use by process $portOwner, but it is not a healthy OpenDraw service. Stop that process or choose another OpenDraw port before starting."
}

if ($Remote) {
    & (Join-Path $PSScriptRoot 'remote.ps1') -Port ([int]$config.port)
}

Write-Host ''
Write-Host 'OpenDraw phone pairing secret:' -ForegroundColor Cyan
Write-Host $config.pairingSecret
Write-Host ''
Write-Host "Local UI: http://127.0.0.1:$($config.port)/"
Write-Host 'OpenDraw will launch Chat On Steroids through a private process-owned companion pipe.'
Write-Host 'If COS is already open, fully Quit it from the tray once; OpenDraw will then launch and own the private companion connection.' -ForegroundColor Yellow
Write-Host 'Keep this terminal open while using OpenDraw.'
Write-Host ''

Push-Location $projectRoot
try {
    npm start
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
