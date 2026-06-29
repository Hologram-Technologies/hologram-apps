# _cdp-click-capture.ps1 - reliable: ONE persistent WS to the WhatsApp page; real Input.dispatchMouseEvent
# click on the first chat row (React honors OS-level input where JS-dispatched events fail); then probe the
# message DOM (validate the bundle's selectors) and check the inbox for a captured real message.
$ErrorActionPreference = "Continue"; $CT = [Threading.CancellationToken]::None
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:HOLO_OS_DIR = $dist; Start-Process -FilePath $exe | Out-Null
$ver=$null;for($i=0;$i -lt 50;$i++){try{$ver=Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 3;if($ver){break}}catch{};Start-Sleep -Milliseconds 500}
if(-not $ver){Write-Host "FAIL: no CDP";exit 1}
function New-Tab($u){ try{return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8}catch{try{return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8}catch{return $null}} }
function Connect-Ws($wsUrl){ for($i=0;$i -lt 6;$i++){ $ws=New-Object Net.WebSockets.ClientWebSocket; try{$ws.ConnectAsync([Uri]$wsUrl,$CT).Wait(8000)|Out-Null}catch{Start-Sleep -Milliseconds 700;continue}; if($ws.State -eq 'Open'){return $ws} }; return $null }
function Cmd($ws,$id,$method,$params){
  $msg=@{id=$id;method=$method;params=$params}|ConvertTo-Json -Depth 12 -Compress
  $b=[Text.Encoding]::UTF8.GetBytes($msg);$ws.SendAsync([ArraySegment[byte]]::new($b),'Text',$true,$CT).Wait()
  $buf=New-Object byte[] 262144;$deadline=[DateTime]::UtcNow.AddSeconds(25)
  while([DateTime]::UtcNow -lt $deadline){
    $sb=New-Object Text.StringBuilder
    try{do{$rt=$ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$CT);if(-not $rt.Wait(8000)){return $null};[void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$rt.Result.Count))}while(-not $rt.Result.EndOfMessage)}catch{return $null}
    $s=$sb.ToString(); if($s -match ('"id":'+$id+'\b')){ try{return ($s|ConvertFrom-Json)}catch{return $null} }
  }
  return $null
}
$RECT=@'
(()=>{var s=document.querySelector('#pane-side');if(!s)return null;var t=s.querySelector('span[title]');if(!t)return null;var el=t.closest('div[role=row]')||t.closest('div[tabindex]')||(t.parentElement&&t.parentElement.parentElement)||t;var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),name:t.getAttribute('title')}})()
'@
$PROBE=@'
(()=>{var h=document.querySelector('#main header');var titles=h?Array.prototype.slice.call(h.querySelectorAll('[title]')).map(function(e){return {tag:e.tagName,role:e.getAttribute('role')||null,title:(e.getAttribute('title')||'').slice(0,28)}}):[];var hs=h?Array.prototype.slice.call(h.querySelectorAll('span[dir]')).slice(0,3).map(function(e){return {dir:e.getAttribute('dir'),txt:(e.textContent||'').slice(0,28)}}):[];return {main:!!document.querySelector('#main'),headerTitles:titles,headerSpans:hs}})()
'@
$INBOXCHK=@'
(async()=>{var M=window.__M;if(!M)return{ready:false};var c=M.conversations().map(function(x){return {chat:x.chat,count:x.count}});var v=await M.verifyActive().catch(function(){return{ok:'n/a'}});return {total:c.length,convos:c,lastCapture:window.__lastCapture||null,activeChainVerifies:v.ok}})()
'@

$inbox=New-Tab "holo://os/apps/holo-messenger/index.html"; Start-Sleep -Seconds 5
$wa=New-Tab "https://web.whatsapp.com"; if(-not($wa -and $wa.webSocketDebuggerUrl)){Write-Host "no wa tab";exit 1}
Start-Sleep -Seconds 16
$ws=Connect-Ws $wa.webSocketDebuggerUrl; if(-not $ws){Write-Host "wa ws connect failed";exit 1}
$null=Cmd $ws 1 "Runtime.enable" @{}
$r=Cmd $ws 2 "Runtime.evaluate" @{expression=$RECT;returnByValue=$true}
$rect=$r.result.result.value
if(-not $rect){Write-Host "RECT: null (no chat row)"; }
else{
  Write-Host ("RECT: chat='"+$rect.name+"' x="+$rect.x+" y="+$rect.y)
  $null=Cmd $ws 3 "Input.dispatchMouseEvent" @{type="mouseMoved";x=$rect.x;y=$rect.y}
  $null=Cmd $ws 4 "Input.dispatchMouseEvent" @{type="mousePressed";x=$rect.x;y=$rect.y;button="left";buttons=1;clickCount=1}
  $null=Cmd $ws 5 "Input.dispatchMouseEvent" @{type="mouseReleased";x=$rect.x;y=$rect.y;button="left";buttons=1;clickCount=1}
  Start-Sleep -Seconds 5
  $p=Cmd $ws 6 "Runtime.evaluate" @{expression=$PROBE;returnByValue=$true}
  Write-Host ("WA-DOM: " + (($p.result.result.value)|ConvertTo-Json -Depth 6 -Compress))
}
$ws.Dispose()
Start-Sleep -Seconds 3
$iws=Connect-Ws $inbox.webSocketDebuggerUrl
if($iws){ $c=Cmd $iws 1 "Runtime.evaluate" @{expression=$INBOXCHK;returnByValue=$true;awaitPromise=$true}; Write-Host ("INBOX-AFTER: " + (($c.result.result.value)|ConvertTo-Json -Depth 6 -Compress)); $iws.Dispose() }
Write-Host "done."
