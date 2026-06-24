# _cdp-media-resolver-test.ps1 — prove the κ media resolver: a clear H.264 <video> plays in the CEF host,
# whose engine has NO H.264 decoder. If it plays (readyState>=2, currentTime advances, videoWidth>0), the
# ONLY explanation is the resolver transcoded it to VP9 — the proof.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$ff   = "C:\Users\pavel\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe"
if (-not (Test-Path $ff)) { $ff = "ffmpeg" }

$env:HOLO_OS_DIR = $dist
$env:HOLO_MEDIA_RESOLVER = "1"
$env:HOLO_FFMPEG = $ff
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id); resolver=ON; ffmpeg=$ff"

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
  # read until we see the eval result (id matching last msg)
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
  $t = New-Tab "about:blank"
  if (-not ($t -and $t.webSocketDebuggerUrl)) { throw "no tab" }
  $ws = $t.webSocketDebuggerUrl
  $mp4 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"
  $page = "data:text/html,<video id=v muted autoplay src=`"$mp4`"></video>"
  # navigate to the page with the H.264 video, give the resolver time to fetch+transcode+serve, then read state
  Cdp $ws @(@{id=1;method="Page.enable"}, @{id=2;method="Page.navigate";params=@{url=$page}}) | Out-Null
  # foreground the tab so the engine doesn't suspend video decode (background tabs are throttled)
  try { Invoke-RestMethod ("http://127.0.0.1:9333/json/activate/"+$t.id) -TimeoutSec 4 | Out-Null } catch {}
  Cdp $ws @(@{id=3;method="Page.bringToFront"}, @{id=4;method="Emulation.setFocusEmulationEnabled";params=@{enabled=$true}}) | Out-Null
  Start-Sleep -Seconds 12
  $probe = @'
(async()=>{const v=document.getElementById('v');if(!v)return JSON.stringify({err:'no video el'});
try{v.muted=true;await v.play().catch(()=>{});}catch(e){}
const t0=v.currentTime; await new Promise(r=>setTimeout(r,2500)); const t1=v.currentTime;
return JSON.stringify({readyState:v.readyState,t0:+t0.toFixed(2),t1:+t1.toFixed(2),advanced:(t1>t0),
videoW:v.videoWidth,videoH:v.videoHeight,err:v.error?v.error.code:null,paused:v.paused,
canH264:(v.canPlayType('video/mp4; codecs="avc1.640028"')||'no')});})()
'@
  $res = Cdp $ws @(@{id=9;method="Runtime.evaluate";params=@{expression=$probe;awaitPromise=$true;returnByValue=$true}})
  Write-Host "RESOLVER-TEST:" $res.result.result.value
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
