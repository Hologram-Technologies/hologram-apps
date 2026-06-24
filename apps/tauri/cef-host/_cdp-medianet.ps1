# _cdp-medianet.ps1 — capture the media element's actual network request/response for /sc/vstream.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:HOLO_OS_DIR = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_YTDLP  = "C:\Users\pavel\Desktop\HOLOGRAM\holo-os\system\tools\bin\yt-dlp.exe"
$env:HOLO_FFMPEG = (Get-Command ffmpeg).Source
$env:HOLO_LW_DIR = "C:\Users\pavel\AppData\Local\Temp\holo-lw"
Get-Process holo_cef_host,yt-dlp,ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 2
$proc = Start-Process -FilePath (Join-Path $here "build\Release\holo_cef_host.exe") -PassThru
for ($i=0;$i -lt 40;$i++){ try { Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 2 | Out-Null; break } catch {}; Start-Sleep -Milliseconds 500 }
$t = try { Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:9333/json/new?holo://os/lw/sctest.html" -TimeoutSec 8 } catch { Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/new?holo://os/lw/sctest.html" -TimeoutSec 8 }
$ws = $t.webSocketDebuggerUrl
try { Invoke-RestMethod ("http://127.0.0.1:9333/json/activate/"+$t.id) -TimeoutSec 4 | Out-Null } catch {}
$sock = New-Object System.Net.WebSockets.ClientWebSocket; $ct=[System.Threading.CancellationToken]::None
$sock.ConnectAsync([Uri]$ws,$ct).Wait()
function Send($o){ $b=[System.Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Depth 8 -Compress)); $sock.SendAsync([System.ArraySegment[byte]]::new($b),[System.Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait() }
Send @{id=1;method="Network.enable"}
Send @{id=2;method="Page.reload";params=@{ignoreCache=$true}}
# read frames for 14s, collect media request lifecycle
$buf=New-Object byte[] 262144
$deadline=(Get-Date).AddSeconds(14)
$reqId=$null; $lines=@()
while((Get-Date) -lt $deadline){
  $sb=New-Object System.Text.StringBuilder
  try { do { $r=$sock.ReceiveAsync([System.ArraySegment[byte]]::new($buf),$ct); if(-not $r.Wait(14000)){break}; [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage) } catch { break }
  $s=$sb.ToString(); if(-not $s){continue}
  try { $o=$s|ConvertFrom-Json } catch { continue }
  switch($o.method){
    "Network.requestWillBeSent" { if($o.params.request.url -match "/sc/vstream"){ $reqId=$o.params.requestId; $lines+=("REQ "+$o.params.request.method+" range="+$o.params.request.headers.Range) } }
    "Network.responseReceived"  { if($o.params.requestId -eq $reqId){ $lines+=("RESP status="+$o.params.response.status+" mime="+$o.params.response.mimeType+" len="+$o.params.response.headers.'Content-Length') } }
    "Network.dataReceived"      { if($o.params.requestId -eq $reqId){ $lines+=("DATA +"+$o.params.dataLength) } }
    "Network.loadingFinished"   { if($o.params.requestId -eq $reqId){ $lines+=("FINISHED total="+$o.params.encodedDataLength) } }
    "Network.loadingFailed"     { if($o.params.requestId -eq $reqId){ $lines+=("FAILED "+$o.params.errorText+" canceled="+$o.params.canceled) } }
  }
}
$sock.Dispose()
$lines | Select-Object -First 30 | ForEach-Object { Write-Host $_ }
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
