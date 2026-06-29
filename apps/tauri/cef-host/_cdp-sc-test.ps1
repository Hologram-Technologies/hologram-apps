# _cdp-sc-test.ps1 — prove the native /sc/vstream route: the left-nav Holo Video default reel streams in the
# CEF host with BOTH video and audio. We navigate the tab straight to holo://os/sc/vstream?... (the route the
# dock player uses), then read the engine's decoded-byte counters: videoDecoded>0 AND audioDecoded>0 means the
# host resolved + copy-muxed the stream and the engine decoded both tracks — exactly the ask.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"

$env:HOLO_OS_DIR = $dist
$env:HOLO_YTDLP  = "C:\Users\pavel\Desktop\HOLOGRAM\holo-os\system\tools\bin\yt-dlp.exe"
$env:HOLO_FFMPEG = (Get-Command ffmpeg).Source
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id); yt-dlp=$($env:HOLO_YTDLP)"

function Wait-Cdp { for ($i=0;$i -lt 40;$i++){ try { Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 2 | Out-Null; return $true } catch {}; Start-Sleep -Milliseconds 500 }; return $false }
function New-Tab($u) { try { return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { try { return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { return $null } } }
function Cdp($wsUrl, $msgs) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
  foreach ($m in $msgs) {
    $b = [System.Text.Encoding]::UTF8.GetBytes(($m | ConvertTo-Json -Depth 8 -Compress))
    $ws.SendAsync([System.ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
  }
  $want = $msgs[-1].id
  $buf = New-Object byte[] 262144
  for ($k=0; $k -lt 200; $k++) {
    $sb = New-Object System.Text.StringBuilder
    do { $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); $r.Wait(); [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while (-not $r.Result.EndOfMessage)
    $o = $sb.ToString() | ConvertFrom-Json
    if ($o.id -eq $want) { $ws.Dispose(); return $o }
  }
  $ws.Dispose(); return $null
}

try {
  if (-not (Wait-Cdp)) { throw "CDP never came up" }
  $reel = "https://www.youtube.com/watch?v=AOCQp6lAfEE"
  $scUrl = "holo://os/sc/vstream?url=" + [uri]::EscapeDataString($reel) + "&h=480"
  $page = "data:text/html,<video id=v muted autoplay playsinline crossorigin=anonymous src=`"$scUrl`"></video>"
  $t = New-Tab "about:blank"
  if (-not ($t -and $t.webSocketDebuggerUrl)) { throw "no tab" }
  $ws = $t.webSocketDebuggerUrl
  Write-Host "navigating with video src: $scUrl"
  Cdp $ws @(@{id=1;method="Page.enable"}, @{id=2;method="Page.navigate";params=@{url=$page}}) | Out-Null
  try { Invoke-RestMethod ("http://127.0.0.1:9333/json/activate/"+$t.id) -TimeoutSec 4 | Out-Null } catch {}
  Cdp $ws @(@{id=3;method="Page.bringToFront"}, @{id=4;method="Emulation.setFocusEmulationEnabled";params=@{enabled=$true}}) | Out-Null
  Write-Host "waiting for resolve + mux + buffer (25s)..."
  Start-Sleep -Seconds 25
  $probe = @'
(async()=>{const v=document.querySelector('video');if(!v)return JSON.stringify({err:'no video el'});
try{v.muted=true;await v.play().catch(()=>{});}catch(e){}
const t0=v.currentTime; await new Promise(r=>setTimeout(r,3000)); const t1=v.currentTime;
return JSON.stringify({readyState:v.readyState,t0:+t0.toFixed(2),t1:+t1.toFixed(2),advanced:(t1>t0),
videoW:v.videoWidth,videoH:v.videoHeight,
videoDecoded:(v.webkitVideoDecodedByteCount||0),audioDecoded:(v.webkitAudioDecodedByteCount||0),
err:v.error?v.error.code:null,paused:v.paused});})()
'@
  $res = Cdp $ws @(@{id=9;method="Runtime.evaluate";params=@{expression=$probe;awaitPromise=$true;returnByValue=$true}})
  Write-Host "SC-VSTREAM-TEST:" $res.result.result.value
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
