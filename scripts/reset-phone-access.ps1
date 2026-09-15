param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot '.data\config.json'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if (-not (Test-Path -LiteralPath $configPath)) {
    throw 'OpenDraw has not been set up yet. Run scripts\setup.ps1 first.'
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$port = if ($null -ne $config.PSObject.Properties['port']) { [int]$config.port } else { 4783 }

if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } |
        Select-Object -First 1
    if ($listener) {
        throw "OpenDraw is still running on port $port. Stop it first, then rerun this script."
    }
}

$buffer = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($buffer)
} finally {
    $rng.Dispose()
}
$config.pairingSecret = [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$config.devices = @()

[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 6), $utf8NoBom)

Write-Host 'All paired phone/device tokens have been revoked.' -ForegroundColor Green
Write-Host 'A new pairing secret was generated. Start OpenDraw to display it locally.'
