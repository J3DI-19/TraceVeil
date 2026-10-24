[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $repo '.runtime\esp32-live'
$python = Join-Path $repo 'backend\.venv\Scripts\python.exe'
$caddy = Join-Path $runtime 'caddy.exe'
$caddyConfig = Join-Path $runtime 'Caddyfile'
foreach ($required in @($python, $caddy, $caddyConfig)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing local setup file: $required" }
}

# Reuse running services. Never stop or replace another process on a port.
function Test-LocalPort([int]$port) {
    $connection = [System.Net.Sockets.TcpClient]::new()
    try { $connection.Connect('127.0.0.1', $port); return $true }
    catch { return $false }
    finally { $connection.Dispose() }
}

if (-not (Test-LocalPort 8000)) {
    Start-Process -FilePath $python -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000') -WorkingDirectory (Join-Path $repo 'backend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'backend.stdout.log') -RedirectStandardError (Join-Path $runtime 'backend.stderr.log') | Out-Null
}
if (-not (Test-LocalPort 5173)) {
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', 'npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort') -WorkingDirectory (Join-Path $repo 'frontend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'frontend.stdout.log') -RedirectStandardError (Join-Path $runtime 'frontend.stderr.log') | Out-Null
}

# The proxy binds only the Wi-Fi IP written during setup, not loopback.
$configText = Get-Content -LiteralPath $caddyConfig -Raw
$hostMatch = [regex]::Match($configText, 'https://([0-9.]+):8443')
if (-not $hostMatch.Success) { throw 'Cannot determine the configured HTTPS address.' }
$deviceHost = $hostMatch.Groups[1].Value
if (-not (Get-NetIPAddress -IPAddress $deviceHost -ErrorAction SilentlyContinue)) {
    throw "Laptop IP changed from $deviceHost. Reconfigure the certificate, firmware and firewall before capture."
}
$proxyProbe = [System.Net.Sockets.TcpClient]::new()
try { $proxyProbe.Connect($deviceHost, 8443); $proxyRunning = $true }
catch { $proxyRunning = $false }
finally { $proxyProbe.Dispose() }
if (-not $proxyRunning) {
    Start-Process -FilePath $caddy -ArgumentList @('run', '--config', ('"' + $caddyConfig + '"'), '--adapter', 'caddyfile') -WorkingDirectory $runtime -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'caddy.stdout.log') -RedirectStandardError (Join-Path $runtime 'caddy.stderr.log') | Out-Null
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/health' -TimeoutSec 2
        if ($health.status -eq 'ok') { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw "Backend did not become healthy. Check logs in $runtime" }
$capturePath = Join-Path $runtime 'capture.json'
if (Test-Path -LiteralPath $capturePath) {
    $capture = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
    Write-Output "Dashboard: http://127.0.0.1:5173/live?case=$($capture.case_id)"
} else {
    Write-Output 'Dashboard: http://127.0.0.1:5173/live'
}
Write-Output 'Services started/reused. This does not start a new capture session or verify device connectivity.'
