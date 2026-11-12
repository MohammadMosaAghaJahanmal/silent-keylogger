# Read-only post-reboot check. Run after restarting Windows and signing in,
# before manually running PDF.exe or PDF-Setup.exe.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$baselinePath = "$root\build\signin-baseline.json"
if (-not (Test-Path -LiteralPath $baselinePath)) { throw 'No baseline. Complete Verify.ps1 -LeaveInstalled first.' }
$baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
if ($boot.Ticks -le [long]$baseline.BootUtcTicks) {
    throw 'Windows has not restarted since the baseline was recorded.'
}
$exe = Join-Path $env:LOCALAPPDATA 'Programs\PDF\PDF.exe'
$resident = @(Get-Process -Name PDF -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
if ($resident.Count -ne 1) { throw "Expected one automatically started PDF instance; found $($resident.Count)." }
if ($resident[0].StartTime.ToUniversalTime() -lt $boot) { throw 'PDF predates this boot.' }
$command = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name PDF).PDF
if ($command -ne $baseline.Command) { throw 'Run command changed.' }
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $baseline.ExeHash) { throw 'Executable changed.' }
if ((Get-Item -LiteralPath $exe).CreationTimeUtc.Ticks -ne [long]$baseline.CreationUtcTicks) { throw 'Executable was replaced since the baseline.' }
if (Get-Process -Name PDF-Setup -ErrorAction SilentlyContinue) { throw 'Setup is running.' }
$registration = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF'
if ($registration.DisplayName -ne 'PDF') { throw 'Installed Apps registration is missing.' }
Write-Host "PASS: PDF started after a real Windows restart, with one resident process and the original installed executable. PID $($resident[0].Id)."
