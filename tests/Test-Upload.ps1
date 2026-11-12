param(
    [string]$Toolchain = "$PSScriptRoot\..\.tools\llvm-mingw-20261104-ucrt-x86_64",
    [string]$LlvmBin = "$Toolchain\bin"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path "$root\build" -Force | Out-Null
& "$LlvmBin\clang.exe" '--target=x86_64-w64-windows-gnu' "-fuse-ld=$LlvmBin\ld.lld.exe" `
    '-isystem' "$Toolchain\include" '-L' "$Toolchain\x86_64-w64-mingw32\lib" `
    '-std=c++17' '-Os' '-Wall' '-Wextra' '-Werror' '-DUNICODE' '-D_UNICODE' `
    '-D_WIN32_WINNT=0x0A00' '-fno-exceptions' '-fno-rtti' '-fno-stack-protector' `
    '-fno-unwind-tables' '-fno-asynchronous-unwind-tables' '-nostdlib' `
    "$PSScriptRoot\upload_test.cpp" "$root\src\http_upload.cpp" "$root\src\device_info.cpp" '-o' "$root\build\upload_test.exe" `
    '-Wl,--subsystem,console:6.02,--entry,EntryPoint,--dynamicbase,--nxcompat,--high-entropy-va,--no-insert-timestamp,--strip-all' `
    '-lkernel32' '-ladvapi32' '-luser32' '-lshell32' '-lole32' '-lwinhttp'
if ($LASTEXITCODE -ne 0) { throw 'Upload test compilation failed' }
python "$PSScriptRoot\test_upload.py" | Tee-Object -FilePath "$root\build\upload-test.log"
if ($LASTEXITCODE -ne 0) { throw 'Upload integration tests failed' }
