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
    "$PSScriptRoot\device_info_test.cpp" "$root\src\device_info.cpp" '-o' "$root\build\device_info_test.exe" `
    '-Wl,--subsystem,console:6.02,--entry,EntryPoint,--dynamicbase,--nxcompat,--high-entropy-va,--no-insert-timestamp,--strip-all' `
    '-lkernel32' '-ladvapi32' '-lole32'
if ($LASTEXITCODE -ne 0) { throw 'Device test compilation failed' }
& "$root\build\device_info_test.exe" | Tee-Object -FilePath "$root\build\device-test.log"
if ($LASTEXITCODE -ne 0) { throw "Device information test failed: $LASTEXITCODE" }
