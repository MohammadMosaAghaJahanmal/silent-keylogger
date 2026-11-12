# Portable, build-time tools only. No administrator access or global PATH edits.
param([string]$Destination = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'))
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$packages = @(
    @{
        Name='LLVM-MinGW'; Folder='llvm-mingw-20261104-ucrt-x86_64'
        File='llvm-mingw-20261104-ucrt-x86_64.zip'
        Url='https://github.com/mstorsjo/llvm-mingw/releases/download/20261104/llvm-mingw-20261104-ucrt-x86_64.zip'
        Sha256='552191B5754C49A5A20723276A6FC56541EA1922C4C50B7B669022333FC1B40F'
    },
    @{
        Name='NSIS'; Folder='nsis-3.13'; File='nsis-3.13.zip'
        Url='https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip'
        Sha256='BA63DFFC4410EE89193E1CB5A41989991BD77C61068DA17E3156D136B7B0B3D8'
    }
)
foreach ($package in $packages) {
    $archive = Join-Path $Destination $package.File
    if (-not (Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $package.Sha256) {
        Write-Host "Downloading $($package.Name)..."
        & curl.exe --fail --location --retry 2 --output $archive $package.Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($package.Name)" }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $package.Sha256) {
        throw "SHA-256 mismatch: $archive"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
}
Write-Host 'Build tools ready. Run .\build.ps1 from the project root.'
