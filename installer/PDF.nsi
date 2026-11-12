Unicode true
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define APP "PDF"
!define VERSION "1.0.0"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PDF"
!define SETUP_MUTEX "Local\PDF.059BEB10-6FB0-4B88-A6E0-2EA7907C1B75.Setup"

Name "${APP}"
OutFile "..\dist\PDF-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\PDF"
RequestExecutionLevel user
ManifestSupportedOS Win10
SilentInstall silent
SilentUnInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
ShowUninstDetails nevershow
CRCCheck force
SetCompressor zlib
SetDatablockOptimize on
Icon "..\assets\PDF.ico"
UninstallIcon "..\assets\PDF.ico"
VIProductVersion "1.0.0.0"
VIAddVersionKey /LANG=1033 "ProductName" "PDF"
VIAddVersionKey /LANG=1033 "FileDescription" "PDF Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "PDF project"

Var SetupMutex
Var Attempts

!macro Initialize
    SetSilent silent
    SetShellVarContext current
    SetRegView 64
    ; Never honor /D or _?= as a destination: this product has one fixed location.
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\PDF"
    ${IfNot} ${RunningX64}
        SetErrorLevel 1633
        Quit
    ${EndIf}
    ${IfNot} ${AtLeastWin10}
        SetErrorLevel 1633
        Quit
    ${EndIf}
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${SETUP_MUTEX}") p .r0 ?e'
    Pop $1
    StrCpy $SetupMutex $0
    ${If} $SetupMutex == 0
        SetErrorLevel 1603
        Quit
    ${EndIf}
    ${If} $1 == 183
        SetErrorLevel 1618
        Quit
    ${EndIf}
!macroend

Function .onInit
    !insertmacro Initialize
FunctionEnd

Function un.onInit
    !insertmacro Initialize
FunctionEnd

!macro StopAndDeleteApp ERROR_LABEL
    ; Run maintenance from NSIS's private temp directory, never a second resident.
    ClearErrors
    ExecWait '"$PLUGINSDIR\PDF.exe" --stop' $0
    IfErrors ${ERROR_LABEL}
    ${If} $0 != 0
        Goto ${ERROR_LABEL}
    ${EndIf}
    ; Mutex release precedes process teardown. Allow the image mapping to close.
    StrCpy $Attempts 0
    ${Do}
        ClearErrors
        Delete "$INSTDIR\PDF.exe"
        ${IfNot} ${Errors}
            ${ExitDo}
        ${EndIf}
        IntOp $Attempts $Attempts + 1
        ${If} $Attempts >= 100
            Goto ${ERROR_LABEL}
        ${EndIf}
        Sleep 50
    ${Loop}
!macroend

Section "Install"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "..\dist\PDF.exe"
    SetOutPath "$INSTDIR"
    IfErrors install_failed
    !insertmacro StopAndDeleteApp install_failed
    ClearErrors
    File "..\dist\PDF.exe"
    File "..\assets\PDF.ico"
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    IfErrors install_failed

    ; Every persistent setting belongs to the current user, in the 64-bit view.
    ClearErrors
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "PDF"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "PDF"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '"$INSTDIR\PDF.exe",0'
    WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $0
    WriteRegStr HKCU "${RUN_KEY}" "PDF" '"$INSTDIR\PDF.exe"'
    IfErrors registration_failed

    ClearErrors
    Exec '"$INSTDIR\PDF.exe"'
    IfErrors launch_failed
    SetErrorLevel 0
    Goto install_done

registration_failed:
    ; Keep Uninstall.exe and its registration available for cleanup or retry.
    SetErrorLevel 1603
    Goto install_done
launch_failed:
    SetErrorLevel 1603
    Goto install_done
install_failed:
    SetErrorLevel 1603
install_done:
SectionEnd

Section "Uninstall"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    ; Embed the maintenance helper so uninstall also works if PDF.exe is missing.
    File "..\dist\PDF.exe"
    !insertmacro StopAndDeleteApp uninstall_failed
    ClearErrors
    DeleteRegValue HKCU "${RUN_KEY}" "PDF"
    ; Windows can retain an enabled/disabled startup record after a Run removal.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "PDF"
    ClearErrors
    Delete "$INSTDIR\PDF.ico"
    Delete "$INSTDIR\Uninstall.exe"
    IfErrors uninstall_failed
    ClearErrors
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    IfErrors uninstall_failed
    ; Remove only our three known files. Never recursively delete user additions.
    RMDir "$INSTDIR"
    SetErrorLevel 0
    Goto uninstall_done
uninstall_failed:
    SetErrorLevel 1603
uninstall_done:
SectionEnd
