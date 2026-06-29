# _cdp-p6.ps1 — launch the rebuilt host on dist; verify the messenger loads window.HoloNet (the REAL
# holowhat content network WASM) NATIVELY and runs over it.
$ErrorActionPreference = "Continue"; $CT = [Threading.CancellationToken]::None
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:HOLO_OS_DIR = $dist; Start-Process -FilePath $exe | Out-Null
$ver=$null; for($i=0;$i -lt 60;$i++){ try{ $ver=Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 3; if($ver){break} }catch{}; Start-Sleep -Milliseconds 500 }
if(-not $ver){ Write-Host "FAIL: no CDP"; exit 1 }
Write-Host "host up"
function New-Tab($u){ try{ return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 }catch{ try{ return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 }catch{ return $null } } }
function Eval-Page($wsUrl,$expr){
  $ws=New-Object Net.WebSockets.ClientWebSocket
  try{ $ws.ConnectAsync([Uri]$wsUrl,$CT).Wait(8000)|Out-Null }catch{ return "ERR:connect" }
  $msg=@{id=1;method="Runtime.evaluate";params=@{expression=$expr;awaitPromise=$true;returnByValue=$true}}|ConvertTo-Json -Depth 10 -Compress
  $b=[Text.Encoding]::UTF8.GetBytes($msg); $ws.SendAsync([ArraySegment[byte]]::new($b),'Text',$true,$CT).Wait()
  $buf=New-Object byte[] 262144; $sb=New-Object Text.StringBuilder
  try{ do{ $rt=$ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$CT); if(-not $rt.Wait(30000)){ $ws.Dispose(); return "ERR:timeout" }; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$rt.Result.Count)) } while(-not $rt.Result.EndOfMessage) }catch{ $ws.Dispose(); return "ERR:recv" }
  $ws.Dispose(); $s=$sb.ToString()
  try{ return (($s|ConvertFrom-Json).result.result.value | ConvertTo-Json -Depth 8 -Compress) }catch{ return "RAW:"+$s.Substring(0,[Math]::Min(400,$s.Length)) }
}
$t = New-Tab "holo://os/apps/holo-messenger/index.html"
if(-not ($t -and $t.webSocketDebuggerUrl)){ Write-Host "MESSENGER: ERR:no-tab"; exit 1 }
Start-Sleep -Seconds 6
$expr = "(async()=>{for(let i=0;i<120 && !window.__M;i++)await new Promise(r=>setTimeout(r,150));await new Promise(r=>setTimeout(r,1500));return {ready:!!window.__M,carrier:document.documentElement.getAttribute('data-live-carrier'),holoNet:document.documentElement.getAttribute('data-holo-net'),impl:(window.HoloNet&&window.HoloNet.impl)||null,kappaKAT:(window.HoloNet&&window.HoloNet.kappa)?(window.HoloNet.kappa(new TextEncoder().encode('abc'))==='blake3:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85'):null,convos:window.__M?window.__M.conversations().length:null,err:document.documentElement.getAttribute('data-holo-messenger-error')};})()"
Write-Host ("MESSENGER (native): " + (Eval-Page $t.webSocketDebuggerUrl $expr))
Write-Host "host left running."
