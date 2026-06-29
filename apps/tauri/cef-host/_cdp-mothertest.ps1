# _cdp-mothertest.ps1 — against the RUNNING native host: walk the full messenger journey end-to-end
# (inbox over the REAL holowhat CN, capture→CN, gated send, reaction, truename, chain verify).
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
  try{ return (($s|ConvertFrom-Json).result.result.value | ConvertTo-Json -Depth 8 -Compress) }catch{ return "RAW:"+$s.Substring(0,[Math]::Min(500,$s.Length)) }
}
$t = New-Tab "holo://os/apps/holo-messenger/index.html"
if(-not ($t -and $t.webSocketDebuggerUrl)){ Write-Host "ERR:no-tab"; exit 1 }
Start-Sleep -Seconds 7
$expr = "(async()=>{for(let i=0;i<200 && !(window.__M&&document.documentElement.getAttribute('data-live-carrier'));i++)await new Promise(r=>setTimeout(r,150));const M=window.__M;if(!M)return{ready:false};const j={};j.carrier=document.documentElement.getAttribute('data-live-carrier');j.holoNet=document.documentElement.getAttribute('data-holo-net');j.convos=M.conversations().length;const before=M.view().length;if(window.__handleCapture)await window.__handleCapture({holoMessengerCapture:true,platform:'whatsapp',input:{text:'mothertest capture',chat:'Ilya',sender:'Ilya'}});await new Promise(r=>setTimeout(r,400));j.captureToCN=/^blake3:[0-9a-f]{64}$/.test(window.__lastCNPut||'')&&M.view().some(m=>m.text==='mothertest capture');const r=await M.send('mothertest reply');j.gatedSend=!!r.sent;const k0=M.view()[0].kappa;const proj=await M.reactTo(k0,'🚀');const pm=proj.messages.find(m=>m.id===k0);j.reaction=!!(pm&&pm.reactions&&pm.reactions.some(x=>x.symbol==='🚀'));j.words=(M.address()||{}).words;const va=await M.verifyActive();j.chainVerifies=!!va.ok;j.PASS=j.carrier==='holowhat'&&j.captureToCN&&j.gatedSend&&j.reaction&&j.chainVerifies;return j;})()"
Write-Host ("MOTHER-TEST (native, real CN): " + (Eval-Page $t.webSocketDebuggerUrl $expr))
