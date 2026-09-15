param(
    [int]$Port = 4783,
    [switch]$PrivateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Find-Tailscale {
    $command = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $known = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $known) { return $known }
    return $null
}

$tailscale = Find-Tailscale
if (-not $tailscale) {
    throw 'Tailscale is not installed. Install Tailscale on this PC and phone, sign both into the same tailnet, then run this script again.'
}

$statusJson = & $tailscale status --json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $statusJson) {
    throw 'Tailscale is installed but not signed in. Open Tailscale, sign in, then run this script again.'
}

$status = $statusJson | ConvertFrom-Json
if ($status.BackendState -ne 'Running') {
    throw 'Tailscale is not connected. Connect it, then run this script again.'
}

if ($PrivateOnly) {
    & $tailscale serve --bg --yes $Port
    if ($LASTEXITCODE -ne 0) { throw "tailscale serve failed with exit code $LASTEXITCODE" }
    $remoteMode = 'tailnet only'
} else {
    # Keep the normal OpenDraw URL usable on restrictive networks that block
    # Tailscale client traffic. Funnel terminates ordinary public HTTPS at the
    # same *.ts.net hostname and proxies only to this loopback OpenDraw port.
    # OpenDraw's own per-device bearer still protects every private API.
    & $tailscale funnel --bg --yes $Port
    if ($LASTEXITCODE -eq 0) {
        $remoteMode = 'public HTTPS fallback enabled'
    } else {
        Write-Warning "Tailscale Funnel could not be enabled (exit code $LASTEXITCODE). Falling back to private Tailscale Serve only."
        & $tailscale serve --bg --yes $Port
        if ($LASTEXITCODE -ne 0) { throw "tailscale serve failed with exit code $LASTEXITCODE" }
        $remoteMode = 'tailnet only (Funnel unavailable)'
    }
}

$status = (& $tailscale status --json) | ConvertFrom-Json
$dnsName = [string]$status.Self.DNSName
if ($dnsName) {
    $dnsName = $dnsName.TrimEnd('.')
    Write-Host "Remote OpenDraw URL: https://$dnsName/" -ForegroundColor Green
    Write-Host "Remote access mode: $remoteMode" -ForegroundColor Cyan
} else {
    Write-Host "Tailscale remote access is active ($remoteMode). Run `tailscale serve status` to see the HTTPS URL." -ForegroundColor Green
}
