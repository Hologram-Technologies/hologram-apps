# _cdp-p6-capture.ps1 — against the RUNNING host: open the messenger, drive the capture path, confirm the
# captured message is published to the REAL holowhat content network (cnPut → blake3 κ) natively.
$ErrorActionPreference = "Continue"; $CT = [Threading.CancellationToken]::None
function New-Tab($u){ try{ return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 }catch{ try{ return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 }catch{ return $null } } }
function Eval-Page($wsUrl,$expr){
  $ws=New-Object Net.WebSockets.ClientWebSocket
  try{ $ws.ConnectAsync([Uri]$wsUrl,$CT).Wait(8000)|Out-Null }catch{ return "ERR:connect" }
  $msg=@{id=1;method="Runtime.evaluate";params=@{expression=$expr;awaitPromise=$true;returnByValue=$true}}|ConvertTo-Json -Depth 10 -Compress
  $b=[Text.Encoding]::UTF8.GetBytes($msg); $ws.SendAsync([ArraySegment[byte]]::new($b),'Text',$true,$CT).Wait()
  $buf=New-Object byte[] 262144; $sb=New-Object Text.StringBuilder
  try{ do{ $rt=$ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$CT); if(-not $rt.Wait(40000)){ $ws.Dispose(); return "ERR:timeout" }; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$rt.Result.Count)) } while(-not $rt.Result.EndOfMessage) }catch{ $ws.Dispose(); return "ERR:recv" }
  $ws.Dispose(); $s=$sb.ToString()
  try{ return (($s|ConvertFrom-Json).result.result.value | ConvertTo-Json -Depth 8 -Compress) }catch{ return "RAW:"+$s.Substring(0,[Math]::Min(400,$s.Length)) }
}
$t = New-Tab "holo://os/apps/holo-messenger/index.html"
if(-not ($t -and $t.webSocketDebuggerUrl)){ Write-Host "ERR:no-tab"; exit 1 }
Start-Sleep -Seconds 7
$expr = "(async()=>{for(let i=0;i<160 && !(window.__M&&document.documentElement.getAttribute('data-live-carrier'));i++)await new Promise(r=>setTimeout(r,150));const carrier=document.documentElement.getAttribute('data-live-carrier');const before=window.__M?window.__M.view().length:0;if(window.__handleCapture)await window.__handleCapture({holoMessengerCapture:true,platform:'whatsapp',input:{text:'P6 native capture to CN',chat:'Ilya',sender:'Ilya'}});await new Promise(r=>setTimeout(r,400));const v=window.__M?window.__M.view():[];return {carrier,published:/^blake3:[0-9a-f]{64}$/.test(window.__lastCNPut||''),cnKappa:(window.__lastCNPut||'').slice(0,22),rendered:v.length>before&&v.some(m=>m.text==='P6 native capture to CN')};})()"
Write-Host ("P6 CAPTURE→CN (native): " + (Eval-Page $t.webSocketDebuggerUrl $expr))
