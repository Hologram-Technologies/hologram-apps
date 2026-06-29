# _cdp-capture-real.ps1 - the final mile: open a real WhatsApp chat so rows render, let the armed
# bundle capture+relay, and confirm a REAL message lands in the inbox. Connects to the RUNNING host
# (preserves the logged-in session). Reports structurally (chat name + count + kappa), not message bodies.
$ErrorActionPreference = "Continue"; $CT = [Threading.CancellationToken]::None
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:HOLO_OS_DIR = $dist
Start-Process -FilePath $exe | Out-Null
$ver=$null;for($i=0;$i -lt 50;$i++){try{$ver=Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 3;if($ver){break}}catch{};Start-Sleep -Milliseconds 500}
if(-not $ver){Write-Host "FAIL: no CDP after launch";exit 1}
Write-Host "host up"
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
    try{return (($s|ConvertFrom-Json).result.result.value|ConvertTo-Json -Depth 10 -Compress)}catch{return "RAW:"+$s.Substring(0,[Math]::Min(400,$s.Length))}
  }
  return "ERR:connect"
}

$inbox = New-Tab "holo://os/apps/holo-messenger/index.html"
Start-Sleep -Seconds 5
$ready = @'
(async()=>{for(let i=0;i<80&&!window.__M;i++)await new Promise(r=>setTimeout(r,100));return {ready:!!window.__M,convos:window.__M?window.__M.conversations().length:null}})()
'@
Write-Host ("INBOX: " + (Eval-Ws $inbox.webSocketDebuggerUrl $ready))

$wa = New-Tab "https://web.whatsapp.com"
Start-Sleep -Seconds 15
# open the first chat so message rows render (the armed bundle's MutationObserver then captures them)
$open = @'
(()=>{var side=document.querySelector('#pane-side');if(!side)return {opened:false,why:'no pane-side',title:document.title};var names=Array.prototype.slice.call(side.querySelectorAll('span[title]'));if(!names.length)return {opened:false,why:'no names'};var t=names[0];var name=t.getAttribute('title');var el=t;for(var i=0;i<8&&el;i++){var r=el.getAttribute?el.getAttribute('role'):null;if(r==='listitem'||r==='row'||(el.hasAttribute&&el.hasAttribute('tabindex')))break;el=el.parentElement;}var target=el||t;try{['mousedown','mouseup','click'].forEach(function(tp){target.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window}));});}catch(e){}return {opened:true,chat:name,chats:names.length}})()
'@
Write-Host ("OPEN-CHAT: " + (Eval-Ws $wa.webSocketDebuggerUrl $open))
Start-Sleep -Seconds 3
# nudge: confirm message rows + the bundle's selectors actually match (structure-only)
$probe = @'
(()=>{var n=function(s){try{return document.querySelectorAll(s).length}catch(e){return -1}};var main=document.querySelector('#main');var sketch=null;var cap=document.querySelector('#main [data-pre-plain-text]');if(cap){var row=cap.closest('div[data-id]')||cap.closest('div[role=row]')||cap;sketch={via:'pre-plain',hasSelectable:!!row.querySelector('span.selectable-text'),tag:row.tagName};}return {armed:window.__holoMessengerArmed||null,mainPresent:!!main,prePlain:n('#main [data-pre-plain-text]'),selectable:n('#main span.selectable-text'),msgInOut:n('#main div.message-in, #main div.message-out'),roleRow:n('#main div[role=row]'),dataId:n('#main div[data-id]'),sketch:sketch}})()
'@
Write-Host ("WA-DOM: " + (Eval-Ws $wa.webSocketDebuggerUrl $probe))
Start-Sleep -Seconds 4
# did real messages reach the inbox?
$check = @'
(()=>{const conv=window.__M?window.__M.conversations():[];const wa=conv.filter(c=>true);const lc=window.__lastCapture||null;const waConv=conv.filter(c=>c.lastKappa).map(c=>({chat:c.chat,count:c.count,hasKappa:/^did:holo:sha256:/.test(c.lastKappa||'')}));return {total:conv.length,lastCapturePlatform:lc?lc.platform:null,lastCaptureChat:lc?lc.chat:null,captured:waConv}})()
'@
Write-Host ("INBOX-AFTER: " + (Eval-Ws $inbox.webSocketDebuggerUrl $check))
Write-Host "done."
