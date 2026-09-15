param([switch]$SkipNpm)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot '.data'
$configPath = Join-Path $dataDir 'config.json'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function New-OpenDrawToken {
    $buffer = [byte[]]::new(32)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

if (Test-Path -LiteralPath $configPath) {
    $old = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $old.pairingSecret) {
        throw 'OpenDraw .data/config.json is missing its pairing secret. Move it aside and rerun setup.ps1 to create a fresh private config.'
    }
    $devices = @()
    if ($null -ne $old.PSObject.Properties['devices'] -and $null -ne $old.devices) {
        $devices = @($old.devices)
    }
    $config = [ordered]@{
        version = 2
        port = if ($null -ne $old.PSObject.Properties['port']) { [int]$old.port } else { 4783 }
        pairingSecret = [string]$old.pairingSecret
        controlSecret = if ($null -ne $old.PSObject.Properties['controlSecret'] -and $old.controlSecret) { [string]$old.controlSecret } else { New-OpenDrawToken }
        devices = [object[]]$devices
        createdAt = if ($null -ne $old.PSObject.Properties['createdAt']) { [string]$old.createdAt } else { [DateTimeOffset]::UtcNow.ToString('o') }
    }
} else {
    $config = [ordered]@{
        version = 2
        port = 4783
        pairingSecret = New-OpenDrawToken
        controlSecret = New-OpenDrawToken
        devices = [object[]]@()
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
}

Write-Utf8NoBom $configPath ($config | ConvertTo-Json -Depth 6)

if (-not $SkipNpm -and (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json'))) {
    Push-Location $projectRoot
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

Write-Host 'OpenDraw setup is ready.' -ForegroundColor Green
Write-Host "Phone web port: $($config.port)"
Write-Host 'COS companion transport: private process-owned pipe'
