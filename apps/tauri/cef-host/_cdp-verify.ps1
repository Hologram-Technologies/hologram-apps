# _cdp-verify.ps1 - one fresh host on dist; per-tab fresh WS + single Runtime.evaluate (robust).
# Proves (1) the messenger inbox boots natively and (2) the Phase-7 capture flag arms on web.whatsapp.com.
$ErrorActionPreference = "Continue"
$CT = [Threading.CancellationToken]::None
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"

Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:HOLO_OS_DIR = $dist
Start-Process -FilePath $exe | Out-Null

$ver=$null; for ($i=0;$i -lt 50;$i++){ try { $ver=Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 3; if($ver){break} } catch {}; Start-Sleep -Milliseconds 500 }
if (-not $ver) { Write-Host "FAIL: no CDP after launch"; exit 1 }
Write-Host "host up, CDP live"

function New-Tab($url) {
  try { return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?" + $url) -TimeoutSec 8 } catch {
    try { return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?" + $url) -TimeoutSec 8 } catch { return $null }
  }
}
function Eval-Page($wsUrl, $expr) {
  $ws = New-Object Net.WebSockets.ClientWebSocket
  try { $ws.ConnectAsync([Uri]$wsUrl, $CT).Wait(8000) | Out-Null } catch { return "ERR:connect" }
  $msg = @{ id=1; method="Runtime.evaluate"; params=@{ expression=$expr; awaitPromise=$true; returnByValue=$true } } | ConvertTo-Json -Depth 10 -Compress
  $b = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($b),'Text',$true,$CT).Wait()
  $buf = New-Object byte[] 262144; $sb = New-Object Text.StringBuilder
  # ONE receive chain, long wait (no re-entrant ReceiveAsync). A /json page WS with no enabled domains
  # emits only the evaluate response, so the first complete message IS our result.
  try { do { $rt=$ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$CT); if(-not $rt.Wait(24000)){ $ws.Dispose(); return "ERR:timeout" }; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$rt.Result.Count)) } while(-not $rt.Result.EndOfMessage) } catch { $ws.Dispose(); return "ERR:recv" }
  $ws.Dispose(); $s=$sb.ToString()
  try { return (($s|ConvertFrom-Json).result.result.value | ConvertTo-Json -Depth 8 -Compress) } catch { return "RAW:"+$s.Substring(0,[Math]::Min(300,$s.Length)) }
}

# (1) inbox boots natively (poll inside the page up to ~14s for the ML-KEM/epoch boot)
$t1 = New-Tab "holo://os/apps/holo-messenger/index.html"
if ($t1 -and $t1.webSocketDebuggerUrl) {
  Start-Sleep -Seconds 3
  Write-Host ("INBOX: " + (Eval-Page $t1.webSocketDebuggerUrl "(async()=>{for(let i=0;i<60&&!window.__M;i++)await new Promise(r=>setTimeout(r,100));const mods=['holo-bridge-adapters','holo-messenger-thread','holo-messenger-transport','holo-pluck','holo-messenger-send','holo-stepup','holo-identity','holo-messenger-epoch','holo-messenger-secure','holo-pqc','holo-messenger-share','holo-words'];const fetched={};for(const m of mods){try{const r=await fetch('/usr/lib/holo/'+m+'.mjs');if(r.status!==200)fetched[m]=r.status;}catch(e){fetched[m]='ERR';}}return {ready:!!window.__M,convos:window.__M?window.__M.conversations().length:null,missing:fetched,err:document.documentElement.getAttribute('data-holo-messenger-error')};})()"))
} else { Write-Host "INBOX: ERR:no-tab ($([bool]$t1))" }

# (2) capture arms on real web.whatsapp.com (settle the tab, then poll the flag)
$t2 = New-Tab "https://web.whatsapp.com"
Write-Host ("  (whatsapp tab ws present: " + [bool]($t2 -and $t2.webSocketDebuggerUrl) + ")")
if ($t2 -and $t2.webSocketDebuggerUrl) {
  Start-Sleep -Seconds 6
  Write-Host ("CAPTURE: " + (Eval-Page $t2.webSocketDebuggerUrl "(async()=>{for(let i=0;i<120&&!window.__holoMessengerArmed;i++)await new Promise(r=>setTimeout(r,100));return {armed:(window.__holoMessengerArmed||null),host:location.hostname};})()"))
} else { Write-Host "CAPTURE: ERR:no-tab" }
Write-Host "host left running."
