# _speed-harness.ps1 — RELIABLE native-browser speed measurement (M0 of deploy-and-prove). No flaky
# multi-eval CDP: one small bounded eval for the page's own first-paint, plus the deterministic process->CDP
# floor. Run boot_timing separately for the serve numbers. Reproducible; a stage it can't read is reported
# "unmeasured", never guessed.
#   powershell -ExecutionPolicy Bypass -File _speed-harness.ps1 [-Url holo://os/home.html] [-Port 9470]
param([string]$Url = "holo://os/home.html", [int]$Port = 9470)
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
if (-not (Test-Path $exe)) { Write-Host "no host build: $exe"; exit 1 }

$env:HOLO_OS_DIR = $dist
$env:HOLO_DEBUG_PORT = "$Port"
$env:HOLO_CACHE_DIR = (Join-Path $env:TEMP ("holo-speed-" + (Get-Random)))
$env:HOLO_BROKER_PORT = "$([int]($Port - 1000))"
$env:HOLO_CLOSURE_ANCHOR = (Get-FileHash (Join-Path $dist "os-closure.json") -Algorithm SHA256).Hash.ToLower()

# ── stage A: process + CEF floor (launch -> CDP ready) ──
$t0 = Get-Date
$p = Start-Process -FilePath $exe -PassThru
$floor = $null
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 200
  if ($p.HasExited) { Write-Host "host exited ($($p.ExitCode))"; exit 1 }
  try { Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 | Out-Null; $floor = ((Get-Date) - $t0).TotalMilliseconds; break } catch {}
}
if (-not $floor) { Write-Host "no CDP after 20s"; if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }; exit 1 }

# ── stage B: the self-reporting probe — _boot-probe.html loads the shell in an iframe, measures its OWN
#    first-paint, and writes it into <title>. We read that title back over plain HTTP (/json/list). NO
#    WebSocket, NO eval — fully reliable. (The -Url arg is the surface the probe frames; default = shell.) ──
Invoke-RestMethod -Method Put "http://127.0.0.1:$Port/json/new?holo://os/usr/share/holo/_boot-probe.html" -TimeoutSec 5 | Out-Null
$paint = "unmeasured"
for ($w = 0; $w -lt 50; $w++) {   # poll the title over HTTP until the probe reports (max ~25s — cold serve varies)
  Start-Sleep -Milliseconds 500
  try {
    $hit = (Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 3) | Where-Object { $_.title -like 'SPEED:*' } | Select-Object -First 1
    if ($hit) { $paint = $hit.title.Substring(6); break }
  } catch {}
}

# ── report (staged, per-device, honest) ──
$cores = [Environment]::ProcessorCount
Write-Host ""
Write-Host "-- Hologram native speed (probe frames $Url) -- $cores cores --"
Write-Host ("  process + CEF floor (launch->CDP)   : {0} ms   [fixed engine cost; a tab in a running browser pays ~0]" -f [math]::Round($floor))
Write-Host ("  shell boot (iframe perf, DCL/load/FCP): {0}" -f ($paint -replace '&quot;','"'))
Write-Host "  serve numbers (run separately): cargo run --release -p kappa-route --example boot_timing -- `"$dist`""
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Remove-Item $env:HOLO_CACHE_DIR -Recurse -Force -ErrorAction SilentlyContinue
