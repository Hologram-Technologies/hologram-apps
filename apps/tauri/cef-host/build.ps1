# build.ps1 — build the Rust κ-route verifier, then the CEF host, inside the VS2022 x64 environment.
# NOTE: native tools (cargo/cmake) write progress to stderr; we gate on $LASTEXITCODE, not on stderr,
# so do NOT set $ErrorActionPreference = "Stop" here (it would abort on cargo's first stderr line).
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tauri = Split-Path -Parent $here

# 1) vendor CEF if missing
if (-not (Test-Path (Join-Path $here "third_party\cef"))) { & (Join-Path $here "vendor-cef.ps1") }

# 2) bake the closure anchor (sha256 of the shipped os-closure.json) into the host = the trust root.
#    A swapped/tampered manifest at runtime != this baked value → the store refuses everything (G1).
$closure = Join-Path $tauri "dist\os-closure.json"
$anchorHdr = Join-Path $here "src\closure_anchor.h"
if (Test-Path $closure) {
  $anchor = (Get-FileHash $closure -Algorithm SHA256).Hash.ToLower()
  $lines = @(
    "#ifndef HOLO_CLOSURE_ANCHOR_H",
    "#define HOLO_CLOSURE_ANCHOR_H",
    "#define HOLO_CLOSURE_ANCHOR `"$anchor`"",
    "#endif"
  )
  Set-Content -Path $anchorHdr -Value $lines -Encoding ASCII
  Write-Host "Baked closure anchor: $($anchor.Substring(0,12))..."
} else {
  Write-Host "WARNING: $closure not found; closure anchor NOT baked (run make-dist.mjs first)."
}

# 3) locate vcvars64.bat (-prerelease so VS Insiders/preview is found too)
$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -prerelease -property installationPath
$vcvars = if ($vs) { Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat" } else { $null }
if (-not $vcvars -or -not (Test-Path $vcvars)) {
  # fallback: search the standard install roots
  $vcvars = Get-ChildItem "C:\Program Files\Microsoft Visual Studio","C:\Program Files (x86)\Microsoft Visual Studio" `
    -Recurse -Filter vcvars64.bat -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $vcvars -or -not (Test-Path $vcvars)) { throw "vcvars64.bat not found" }
Write-Host "Using $vcvars"

# 4) inside the MSVC env: build the Rust verifier for the MSVC ABI (to match libcef.lib), then cmake+ninja.
#    libcef.lib is MSVC/COFF, so the verifier must be MSVC too (the default toolchain here is GNU).
$build = Join-Path $here "build"
New-Item -ItemType Directory -Force -Path $build | Out-Null
$krBuild = "cargo +nightly-x86_64-pc-windows-msvc build --release -p kappa-route --target x86_64-pc-windows-msvc"
$cmd = "`"$vcvars`" && cd /d `"$tauri\src-tauri`" && $krBuild && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -S `"$here`" -B `"$build`" && cmake --build `"$build`" --target holo_cef_host"
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
Write-Host "Built → $build\Release\holo_cef_host.exe"
