# vendor-cef.ps1 — fetch the pinned CEF binary distribution into third_party/cef.
# CEF tracks chromium.git; this pins one stable build so the host is reproducible. Re-run to refresh.
$ErrorActionPreference = "Stop"

# Pinned: CEF 149 stable / Chromium 149.0.7827.156 (windows64 minimal).
$Version = "149.0.4+g2f1bfd8+chromium-149.0.7827.156"
$Sha1    = "60af3ad0d28a65d43ed45523cb5bbdf51aaf85e8"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tp   = Join-Path $here "third_party"
New-Item -ItemType Directory -Force -Path $tp | Out-Null

$file = "cef_binary_${Version}_windows64_minimal.tar.bz2"
$url  = "https://cef-builds.spotifycdn.com/$([uri]::EscapeDataString($file))"
$dst  = Join-Path $tp "cef.tar.bz2"

Write-Host "Downloading $file ..."
curl.exe -L --fail -o $dst $url

$h = (Get-FileHash $dst -Algorithm SHA1).Hash.ToLower()
if ($h -ne $Sha1) { throw "SHA1 mismatch: got $h expected $Sha1" }
Write-Host "SHA1 OK."

Write-Host "Extracting ..."
tar -xf $dst -C $tp
$ext = Get-ChildItem -Path $tp -Directory | Where-Object { $_.Name -like 'cef_binary_*' } | Select-Object -First 1
if (Test-Path "$tp\cef") { Remove-Item -Recurse -Force "$tp\cef" }
Rename-Item -Path $ext.FullName -NewName "cef"
Write-Host "CEF ready at $tp\cef"
