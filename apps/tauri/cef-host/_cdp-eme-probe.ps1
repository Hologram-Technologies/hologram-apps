# _cdp-eme-probe.ps1 — sharpen Phase 0: does EME infra exist, or is it only the codec param failing?
# Probe ClearKey + Widevine with a SUPPORTED codec (VP9) vs the unsupported one (H.264).
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$proc = Start-Process -FilePath $exe -PassThru
function Get-PageTarget { for ($i=0;$i -lt 40;$i++){ try { $l=Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/list" -TimeoutSec 3; $p=$l|?{$_.type -eq 'page' -and $_.url -like 'holo://*'}|Select -First 1; if($p){return $p} } catch {}; Start-Sleep -Milliseconds 500 }; return $null }
function Invoke-CdpEval { param($wsUrl,$expression)
  $ws=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl,$ct).Wait()
  $msg=@{id=1;method="Runtime.evaluate";params=@{expression=$expression;awaitPromise=$true;returnByValue=$true}}|ConvertTo-Json -Depth 8 -Compress
  $b=[System.Text.Encoding]::UTF8.GetBytes($msg); $ws.SendAsync([System.ArraySegment[byte]]::new($b),[System.Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait()
  $buf=New-Object byte[] 262144; $sb=New-Object System.Text.StringBuilder
  do { $r=$ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf),$ct); $r.Wait(); [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage)
  $ws.Dispose(); return ($sb.ToString()|ConvertFrom-Json) }
$probe = @'
(async () => {
  async function eme(ks, codec){ try { await navigator.requestMediaKeySystemAccess(ks, [{
      initDataTypes:['cenc','keyids','webm'],
      videoCapabilities:[{contentType: codec}] }]); return 'available'; } catch(e){ return 'reject:'+e.name; } }
  const vp9 = 'video/webm; codecs="vp9"';
  const h264 = 'video/mp4; codecs="avc1.640028"';
  return {
    clearkey_vp9:  await eme('org.w3.clearkey', vp9),
    clearkey_h264: await eme('org.w3.clearkey', h264),
    widevine_vp9:  await eme('com.widevine.alpha', vp9),
    widevine_h264: await eme('com.widevine.alpha', h264)
  };
})()
'@
try {
  $pg = Get-PageTarget; if (-not $pg){ throw "no holo page target" }
  $res = Invoke-CdpEval $pg.webSocketDebuggerUrl $probe
  Write-Host "EME (codec-separated): $($res.result.result.value | ConvertTo-Json -Compress)"
} finally { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Write-Host "host stopped." }
