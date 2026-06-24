# _cdp-sc-lw.ps1 — test /sc/vstream from a SAME-ORIGIN holo://os page (served via the lw dev seam), the way
# the real dock player loads it. Reports both a raw fetch (backend bytes) and <video> playback (full path).
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$env:HOLO_YTDLP  = "C:\Users\pavel\Desktop\HOLOGRAM\holo-os\system\tools\bin\yt-dlp.exe"
$env:HOLO_FFMPEG = (Get-Command ffmpeg).Source
$env:HOLO_LW_DIR = "C:\Users\pavel\AppData\Local\Temp\holo-lw"
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id); ffmpeg=$($env:HOLO_FFMPEG)"

function Wait-Cdp { for ($i=0;$i -lt 40;$i++){ try { Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 2 | Out-Null; return $true } catch {}; Start-Sleep -Milliseconds 500 }; return $false }
function New-Tab($u) { try { return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { try { return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { return $null } } }
function Eval($wsUrl, $expr) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket; $ct=[System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl,$ct).Wait()
  $m = @{id=1;method="Runtime.evaluate";params=@{expression=$expr;awaitPromise=$true;returnByValue=$true}} | ConvertTo-Json -Depth 8 -Compress
  $b=[System.Text.Encoding]::UTF8.GetBytes($m)
  $ws.SendAsync([System.ArraySegment[byte]]::new($b),[System.Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait()
  $buf=New-Object byte[] 262144
  for($k=0;$k -lt 400;$k++){ $sb=New-Object System.Text.StringBuilder; do { $r=$ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf),$ct); $r.Wait(); [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage); $o=$sb.ToString()|ConvertFrom-Json; if($o.id -eq 1){ $ws.Dispose(); return $o.result.result.value } }
  $ws.Dispose(); return $null
}

try {
  if (-not (Wait-Cdp)) { throw "CDP never came up" }
  $t = New-Tab "holo://os/lw/sctest.html"
  if (-not ($t -and $t.webSocketDebuggerUrl)) { throw "no tab" }
  $ws = $t.webSocketDebuggerUrl
  try { Invoke-RestMethod ("http://127.0.0.1:9333/json/activate/"+$t.id) -TimeoutSec 4 | Out-Null } catch {}
  Start-Sleep -Seconds 2
  Write-Host "page title: $(Eval $ws 'document.title')"
  Write-Host "PLAY-PROBE (same-origin <video>):"
  try { Write-Host ("  " + (Eval $ws 'window.__playProbe ? window.__playProbe() : "no probe fn"')) } catch { Write-Host "  play eval error: $_" }
  Write-Host "FETCH-PROBE (backend bytes):"
  try { Write-Host ("  " + (Eval $ws 'window.__fetchProbe ? window.__fetchProbe() : "no probe fn (page not served?)"')) } catch { Write-Host "  fetch eval error: $_" }
  Write-Host "host alive after probes: $((@(Get-Process holo_cef_host -ErrorAction SilentlyContinue)).Count -gt 0)"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Get-Process yt-dlp,ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
