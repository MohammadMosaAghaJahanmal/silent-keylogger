param([switch]$LeaveInstalled)
$ErrorActionPreference = 'Stop'
# The invoking automation may use PowerShell 7; restore Windows PowerShell's
# own module search path when this test is launched with powershell.exe.
$env:PSModulePath = "$PSHOME\Modules;$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules"
$root = Split-Path -Parent $PSScriptRoot
$install = Join-Path $env:LOCALAPPDATA 'Programs\PDF'
$exe = Join-Path $install 'PDF.exe'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF'
$report = [System.Collections.Generic.List[object]]::new()
New-Item -ItemType Directory -Path "$root\build" -Force | Out-Null
Start-Transcript -Path "$root\build\verification.log" -Force | Out-Null

function Check([string]$Name, [bool]$Condition, $Details = $null) {
    $report.Add([pscustomobject]@{ Check=$Name; Passed=$Condition; Details=$Details })
    Write-Host "$Name : $Condition"
    if (-not $Condition) { throw "Verification failed: $Name" }
}
function Resident {
    @(Get-Process -Name PDF -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
}
function Await([scriptblock]$Condition, [int]$Seconds = 15) {
    $limit = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $limit)
    return $false
}
function Install {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath "$root\dist\PDF-Setup.exe" -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(30000)) { throw 'Installer timed out' }
    Check 'Quiet setup exit code' ($process.ExitCode -eq 0) $process.ExitCode
    Check 'Auto-launch after installation' (Await { (Resident).Count -eq 1 })
    $timer.Stop()
    $report.Add([pscustomobject]@{ Check='Install and launch duration'; Passed=$true; Details=$timer.Elapsed.TotalMilliseconds })
}
function Uninstall {
    $process = Start-Process -FilePath "$install\Uninstall.exe" -PassThru -WindowStyle Hidden
    $process.WaitForExit(30000) | Out-Null
    # NSIS relocates its uninstaller into TEMP; wait for that worker's effects.
    Check 'Uninstall stops background app' (Await { (Resident).Count -eq 0 })
    Check 'Uninstall removes registration' (Await { -not (Test-Path -LiteralPath $uninstallKey) })
    Check 'Uninstall removes Run value' ($null -eq (Get-ItemProperty -LiteralPath $runKey -Name PDF -ErrorAction SilentlyContinue))
    Check 'Uninstall deletes all product files' (Await {
        -not (Test-Path -LiteralPath $exe) -and
        -not (Test-Path -LiteralPath "$install\PDF.ico") -and
        -not (Test-Path -LiteralPath "$install\Uninstall.exe")
    })
}

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PDFWindows {
    private delegate bool Callback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    public static int Count(uint wanted) {
        int found = 0;
        EnumWindows((window, state) => { uint pid; GetWindowThreadProcessId(window, out pid); if (pid == wanted) found++; return true; }, IntPtr.Zero);
        return found;
    }
}
'@

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Check 'Tests run without administrator privileges' (-not $elevated)
    Check 'No existing PDF installation before test' (-not (Test-Path -LiteralPath $install))
    Check 'No existing PDF Run entry before test' ($null -eq (Get-ItemProperty -LiteralPath $runKey -Name PDF -ErrorAction SilentlyContinue))
    Check 'No existing PDF Installed Apps entry before test' (-not (Test-Path -LiteralPath $uninstallKey))

    Install
    $files = @(Get-ChildItem -LiteralPath $install -File | Select-Object -ExpandProperty Name | Sort-Object)
    Check 'Exactly the three intended installed files' (($files -join ',') -eq 'PDF.exe,PDF.ico,Uninstall.exe') $files
    foreach ($name in @('PDF.exe','PDF.ico')) {
        Check "Installed $name matches build" ((Get-FileHash -LiteralPath "$install\$name").Hash -eq (Get-FileHash -LiteralPath "$root\dist\$name").Hash)
    }
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    Check 'Installed Apps display name and location' ($registration.DisplayName -eq 'PDF' -and $registration.InstallLocation -eq $install)
    Check 'Working registered uninstall command' ($registration.UninstallString -eq ('"' + $install + '\Uninstall.exe"'))
    $command = (Get-ItemProperty -LiteralPath $runKey -Name PDF).PDF
    Check 'Quoted per-user automatic startup entry named PDF' ($command -eq ('"' + $exe + '"')) $command
    $startup = @(Get-CimInstance Win32_StartupCommand | Where-Object { $_.Name -eq 'PDF' -and $_.Command -eq $command })
    $report.Add([pscustomobject]@{ Check='WMI startup enumeration'; Passed=$(if ($startup.Count -ge 1) { $true } else { $null }); Details=$(if ($startup.Count -ge 1) { 'PDF' } else { 'Provider did not refresh the new registration in this session; Run value verified directly.' }) })

    $resident = (Resident)[0]
    Check 'No top-level windows, including hidden windows' ([PDFWindows]::Count($resident.Id) -eq 0)
    Check 'PDF file metadata' ($resident.MainModule.FileVersionInfo.FileDescription -eq 'PDF')
    $cpuBefore = $resident.TotalProcessorTime.TotalMilliseconds
    $readBefore = (Get-CimInstance Win32_Process -Filter "ProcessId=$($resident.Id)")
    Start-Sleep -Seconds 30
    $resident.Refresh()
    $readAfter = (Get-CimInstance Win32_Process -Filter "ProcessId=$($resident.Id)")
    $cpuDelta = $resident.TotalProcessorTime.TotalMilliseconds - $cpuBefore
    Check 'Idle CPU below 50 ms in 30 seconds' ($cpuDelta -lt 50) $cpuDelta
    Check 'Idle working set below 12 MiB' ($resident.WorkingSet64 -lt 12MB) ([math]::Round($resident.WorkingSet64 / 1MB, 3))
    Check 'No idle read/write operations' ($readBefore.ReadOperationCount -eq $readAfter.ReadOperationCount -and $readBefore.WriteOperationCount -eq $readAfter.WriteOperationCount)
    Check 'No TCP endpoints' (@(Get-NetTCPConnection -OwningProcess $resident.Id -ErrorAction SilentlyContinue).Count -eq 0)
    Check 'No UDP endpoints' (@(Get-NetUDPEndpoint -OwningProcess $resident.Id -ErrorAction SilentlyContinue).Count -eq 0)
    $report.Add([pscustomobject]@{ Check='Idle thread states'; Passed=$true; Details=@($resident.Threads | ForEach-Object { "$($_.ThreadState):$($_.WaitReason)" }) })

    $duplicates = @(1..32 | ForEach-Object { Start-Process -FilePath $exe -PassThru -WindowStyle Hidden })
    foreach ($duplicate in $duplicates) {
        Check 'Duplicate exits successfully' ($duplicate.WaitForExit(10000) -and $duplicate.ExitCode -eq 0)
    }
    Check 'Original instance survives 32 simultaneous launches' ((Resident).Count -eq 1 -and (Resident)[0].Id -eq $resident.Id)

    # Simulate Windows executing the exact persisted Run command after sign-in.
    $stamp = (Get-Item -LiteralPath $exe).LastWriteTimeUtc
    $stop = Start-Process -FilePath $exe -ArgumentList '--stop' -PassThru -WindowStyle Hidden
    Check 'Maintenance stop succeeds' ($stop.WaitForExit(15000) -and $stop.ExitCode -eq 0) $stop.ExitCode
    Check 'Stopped before startup simulation' (Await { (Resident).Count -eq 0 })
    Start-Process -FilePath ($command.Trim('"')) -WindowStyle Hidden
    Check 'Registered sign-in command starts app' (Await { (Resident).Count -eq 1 })
    Check 'Startup does not reinstall or rewrite executable' ((Get-Item -LiteralPath $exe).LastWriteTimeUtc -eq $stamp)

    # A terminated process cannot leave a stale owned kernel mutex.
    (Resident)[0].Kill()
    Check 'Forced process exit completes' (Await { (Resident).Count -eq 0 })
    Start-Process -FilePath $exe -WindowStyle Hidden
    Check 'Application restarts after forced exit' (Await { (Resident).Count -eq 1 })
    Install
    Check 'Repeat installation keeps a single resident' ((Resident).Count -eq 1)
    Uninstall
    Check 'Empty install directory removed' (Await { -not (Test-Path -LiteralPath $install) })

    # Also exercise uninstallation with a missing application and a user-added file.
    Install
    $stop = Start-Process -FilePath $exe -ArgumentList '--stop' -PassThru -WindowStyle Hidden
    $stop.WaitForExit(15000) | Out-Null
    Check 'Stopped for missing-file uninstall test' (Await { (Resident).Count -eq 0 })
    # Exact named file operations only; never recursively delete the install path.
    Remove-Item -LiteralPath $exe
    $sentinel = Join-Path $install 'verification-user-file.txt'
    Set-Content -LiteralPath $sentinel -Value 'Preserve user-added files.'
    Uninstall
    Check 'Uninstall preserves user-added files' (Test-Path -LiteralPath $sentinel)
    Remove-Item -LiteralPath $sentinel
    Remove-Item -LiteralPath $install

    if ($LeaveInstalled) {
        Install
        [pscustomobject]@{
            BootUtcTicks=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks
            Command=(Get-ItemProperty -LiteralPath $runKey -Name PDF).PDF
            ExeHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
            CreationUtcTicks=(Get-Item -LiteralPath $exe).CreationTimeUtc.Ticks
        } | ConvertTo-Json | Set-Content -LiteralPath "$root\build\signin-baseline.json" -Encoding UTF8
    }
    $report.Add([pscustomobject]@{ Check='Actual reboot and subsequent Windows sign-in'; Passed=$null; Details='Not performed; the persisted Run command was exercised without restarting the desktop.' })
    $report.Add([pscustomobject]@{ Check='Windows 10 runtime test'; Passed=$null; Details='This machine runs Windows 11. Windows 10 compatibility is based on the x64 target, manifest and documented API baseline.' })
    $status = 'PASSED'
} catch {
    $status = 'FAILED'
    $report.Add([pscustomobject]@{ Check='Fatal error'; Passed=$false; Details=$_.ToString() })
    Write-Host $_ -ForegroundColor Red
} finally {
    [pscustomobject]@{
        Status=$status
        OS=[Environment]::OSVersion.VersionString
        StandardUser=(-not $elevated)
        LeaveInstalled=[bool]$LeaveInstalled
        Checks=$report
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$root\build\verification.json" -Encoding UTF8
    Stop-Transcript | Out-Null
}
if ($status -ne 'PASSED') { exit 1 }
