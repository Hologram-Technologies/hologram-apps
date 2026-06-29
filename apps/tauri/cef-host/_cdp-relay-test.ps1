# _cdp-relay-test.ps1 - prove the cross-origin capture relay end-to-end WITHOUT a WhatsApp login:
# a web origin calls cefQuery('holo:capture:..') -> host RelayCapture -> holo://os inbox 'holo-capture'
# event -> handleCapture mints+ingests. Also checks the UA fix + inbox-native boot.
$ErrorActionPreference = "Continue"; $CT = [Threading.CancellationToken]::None
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:HOLO_OS_DIR = $dist
Start-Process -FilePath $exe | Out-Null

function New-Tab($u){ try{return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8}catch{try{return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8}catch{return $null}} }
function Eval-Ws($wsUrl,$expr){
  for($try=0;$try -lt 5;$try++){
    $ws=New-Object Net.WebSockets.ClientWebSocket
    try{$ws.ConnectAsync([Uri]$wsUrl,$CT).Wait(8000)|Out-Null}catch{Start-Sleep -Milliseconds 800;continue}
    if($ws.State -ne 'Open'){Start-Sleep -Milliseconds 800;continue}
    $msg=@{id=1;method="Runtime.evaluate";params=@{expression=$expr;awaitPromise=$true;returnByValue=$true}}|ConvertTo-Json -Depth 12 -Compress
    $b=[Text.Encoding]::UTF8.GetBytes($msg);$ws.SendAsync([ArraySegment[byte]]::new($b),'Text',$true,$CT).Wait()
    $buf=New-Object byte[] 262144;$sb=New-Object Text.StringBuilder
    try{do{$rt=$ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$CT);if(-not $rt.Wait(30000)){$ws.Dispose();return "ERR:timeout"};[void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$rt.Result.Count))}while(-not $rt.Result.EndOfMessage)}catch{$ws.Dispose();Start-Sleep -Milliseconds 800;continue}
    $ws.Dispose();$s=$sb.ToString()
    try{return (($s|ConvertFrom-Json).result.result.value|ConvertTo-Json -Depth 10 -Compress)}catch{return "RAW:"+$s.Substring(0,[Math]::Min(500,$s.Length))}
  }
  return "ERR:connect"
}
$ver=$null;for($i=0;$i -lt 50;$i++){try{$ver=Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 3;if($ver){break}}catch{};Start-Sleep -Milliseconds 500}
if(-not $ver){Write-Host "FAIL: no CDP";exit 1}
Write-Host "host up"

# 1) inbox boots natively
$inbox = New-Tab "holo://os/apps/holo-messenger/index.html"
if(-not($inbox -and $inbox.webSocketDebuggerUrl)){Write-Host "INBOX: no tab";exit 1}
Start-Sleep -Seconds 5
$inboxReady = @'
(async()=>{for(let i=0;i<80&&!window.__M;i++)await new Promise(r=>setTimeout(r,100));return {ready:!!window.__M,convos:window.__M?window.__M.conversations().length:null,handler:typeof window.__handleCapture}})()
'@
Write-Host ("INBOX: " + (Eval-Ws $inbox.webSocketDebuggerUrl $inboxReady))

# 2) from a WEB origin, fire a synthetic capture through cefQuery -> host relay -> inbox
$web = New-Tab "https://example.com"
Start-Sleep -Seconds 4
$fire = @'
(()=>{if(!window.cefQuery)return {cefQuery:false,ua:navigator.userAgent};var p={holoMessengerCapture:true,platform:"whatsapp",input:{text:"relay test from CDP",sender:"Tester",sentAt:"12:00",chat:"Relay Test",source:"web.whatsapp.com"}};window.cefQuery({request:"holo:capture:"+encodeURIComponent(JSON.stringify(p)),persistent:false,onSuccess:function(){},onFailure:function(){}});return {cefQuery:true,ua:navigator.userAgent};})()
'@
Write-Host ("WEB-FIRE: " + (Eval-Ws $web.webSocketDebuggerUrl $fire))

# 3) back on the inbox: did the relayed capture arrive + ingest?
Start-Sleep -Seconds 2
$check = @'
(()=>{const conv=window.__M?window.__M.conversations():[];const rt=conv.find(c=>c.chat==="Relay Test");return {lastCapture:window.__lastCapture||null,relayConvo:rt?{chat:rt.chat,count:rt.count,last:rt.lastText}:null,total:conv.length}})()
'@
Write-Host ("INBOX-AFTER: " + (Eval-Ws $inbox.webSocketDebuggerUrl $check))

# 4) whatsapp render + UA state
$wa = New-Tab "https://web.whatsapp.com"
Start-Sleep -Seconds 14
$wstate = @'
(()=>{const q=s=>document.querySelector(s);return {armed:window.__holoMessengerArmed||null,loggedIn:!!(q('#pane-side')||q('[aria-label=\"Chat list\"]')),canvases:document.querySelectorAll('canvas').length,ua:navigator.userAgent,note:(document.body?document.body.innerText.replace(/\s+/g,' ').slice(0,140):'')}})()
'@
Write-Host ("WHATSAPP: " + (Eval-Ws $wa.webSocketDebuggerUrl $wstate))
Write-Host "host left running."
