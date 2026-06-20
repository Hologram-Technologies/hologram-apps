# bootstrap.ps1 — boot Hologram natively from a single link (Windows).
#
#   irm https://hologram.os/native/bootstrap.ps1 | iex
#
# The link is content-addressed end to end. It resolves the release manifest (release.json), fetches
# the Windows installer, RE-DERIVES its sha256 κ and REFUSES a mismatch (Law L5), installs it
# (per-user, no admin), then opens Hologram via the now-registered hologram:// scheme — so every later
# link is one click. The verify-install IS the install. With no pinned release it builds from source.

[CmdletBinding()]
param(
  # …/releases/latest/download/release.json — the κ manifest pin-release.mjs publishes.
  [string]$ReleaseUrl = $env:HOLO_RELEASE_URL,
  # explicit single-artifact override (skips the manifest):
  [string]$Url        = $env:HOLO_NATIVE_URL,
  [string]$Kappa      = $env:HOLO_NATIVE_KAPPA,
  [switch]$FromSource
)
$ErrorActionPreference = "Stop"
Write-Host "Hologram - native boot" -ForegroundColor Cyan

# Baked-in default so the published one-liner stays clean. Points at this repo's release manifest;
# change the owner/repo here if you publish under a different name.
$DefaultReleaseUrl = "https://github.com/humuhumu33/hologram-apps/releases/latest/download/release.json"
if (-not $ReleaseUrl) { $ReleaseUrl = $DefaultReleaseUrl }

function Build-FromSource {
  Write-Host "-> building from source (Rust + Node + Tauri CLI)..."
  foreach ($t in @("cargo","node","npm")) { if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "missing prerequisite: $t" } }
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path; if (-not $here) { $here = Get-Location }
  Set-Location $here; npm install; npm run build
  Write-Host "OK built. Bundle under src-tauri/target/release/bundle/." -ForegroundColor Green
}

# Resolve the artifact + its κ from the manifest, unless an explicit pair was passed.
if (-not $FromSource -and (-not $Url -or -not $Kappa) -and $ReleaseUrl) {
  Write-Host "-> resolving manifest $ReleaseUrl"
  $m = Invoke-RestMethod -Uri $ReleaseUrl -UseBasicParsing
  $win = $m.platforms.win
  if (-not $win) { throw "no Windows artifact in release.json" }
  $Url = $win.url; $Kappa = $win.kappa
}

if ($FromSource -or -not $Url -or -not $Kappa) {
  if (-not $Url -or -not $Kappa) { Write-Host "(no pinned release - building locally)" -ForegroundColor Yellow }
  Build-FromSource; return
}

# ── fetch -> verify κ -> install -> open ──────────────────────────────────────────────────────────
$ext  = if ($Url -match '\.msi($|\?)') { '.msi' } else { '.exe' }
$dest = Join-Path $env:TEMP ("hologram-setup" + $ext)
Write-Host "-> fetching $Url"
Invoke-WebRequest -Uri $Url -OutFile $dest -UseBasicParsing
$got  = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLower()
$want = ($Kappa.ToLower() -replace '^did:holo:sha256:','')
if ($got -ne $want) {
  Remove-Item $dest -Force -ErrorAction SilentlyContinue
  throw "kappa MISMATCH - refusing to install.`n  expected $want`n  got      $got"   # Law L5: fail closed
}
Write-Host "OK kappa verified  did:holo:sha256:$got" -ForegroundColor Green
Write-Host "-> installing (per-user, no admin)..."
if ($ext -eq '.msi') { Start-Process msiexec.exe -ArgumentList @('/i', "`"$dest`"", '/passive') -Wait }
else                 { Start-Process -FilePath $dest -ArgumentList '/S' -Wait }                 # NSIS silent
Write-Host "-> opening Hologram..."
Start-Process "hologram://open"                                                                 # via the now-registered scheme
Write-Host "Done. Hologram is now one click - paste a hologram:// link or use 'Open in Hologram'." -ForegroundColor Green
