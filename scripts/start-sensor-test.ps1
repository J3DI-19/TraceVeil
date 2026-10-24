[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $repo '.runtime\esp32-live'
$python = Join-Path $repo 'backend\.venv\Scripts\python.exe'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
if (-not (Test-Path -LiteralPath $python)) { throw 'The prepared backend environment is missing.' }
function Test-LocalPort([int]$port) {
    $probe = [System.Net.Sockets.TcpClient]::new()
    try { $probe.Connect('127.0.0.1', $port); return $true }
    catch { return $false }
    finally { $probe.Dispose() }
}
if (-not (Test-LocalPort 8000)) {
    Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000') -WorkingDirectory (Join-Path $repo 'backend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'usb-backend.stdout.log') -RedirectStandardError (Join-Path $runtime 'usb-backend.stderr.log') | Out-Null
}
if (-not (Test-LocalPort 5173)) {
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/c','npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort') -WorkingDirectory (Join-Path $repo 'frontend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'usb-frontend.stdout.log') -RedirectStandardError (Join-Path $runtime 'usb-frontend.stderr.log') | Out-Null
}
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $status = Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/usb-sensor/status' -TimeoutSec 2
        if ($status.state) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw "USB setup service did not become ready. Check the logs in $runtime." }
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/live' }
Write-Output 'Open Live Monitor, connect the ESP32 data cable, then click Connect & start.'
