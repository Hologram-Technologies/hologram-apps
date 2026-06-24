$ErrorActionPreference = "Continue"
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe   = Join-Path $here "build\Release\holo_cef_host.exe"
$dist  = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id)"
function Get-PageTarget { for ($i=0; $i -lt 60; $i++) { try {
  $list = Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/list" -TimeoutSec 3
  $pg = $list | Where-Object { $_.type -eq 'page' -and $_.url -like 'holo://*' } | Select-Object -First 1
  if ($pg) { return $pg } } catch {} ; Start-Sleep -Milliseconds 500 } ; return $null }
function Invoke-CdpRaw { param($wsUrl, $method, $paramsJson)
  for ($try=0; $try -lt 4; $try++) { try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ct = [System.Threading.CancellationToken]::None
    $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
    $msg = "{`"id`":1,`"method`":`"$method`",`"params`":$paramsJson}"
    $b = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $ws.SendAsync([System.ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
    $buf = New-Object byte[] 262144; $sb = New-Object System.Text.StringBuilder
    do { $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); $r.Wait()
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while (-not $r.Result.EndOfMessage)
    $ws.Dispose(); return ($sb.ToString() | ConvertFrom-Json)
  } catch { Start-Sleep -Milliseconds 400 } } ; return $null }
function Eval { param($ws, $expr)
  $p = @{ expression=$expr; awaitPromise=$true; returnByValue=$true } | ConvertTo-Json -Depth 8 -Compress
  $r = Invoke-CdpRaw $ws "Runtime.evaluate" $p
  if ($r) { return $r.result.result.value } else { return "<cdp-fail>" } }

$probe = @'
(()=>{const cs=getComputedStyle(document.documentElement);const w=document.getElementById('world');const wr=w?w.getBoundingClientRect():null;
const on=[...document.querySelectorAll('.holo-aside.on')].map(a=>({id:a.id,vis:getComputedStyle(a).visibility,op:getComputedStyle(a).opacity,par:a.offsetParent!==null,w:Math.round(a.getBoundingClientRect().width)}));
return JSON.stringify({asideW:cs.getPropertyValue('--holo-aside-w').trim(),innerW:innerWidth,worldR:wr?Math.round(wr.right):null,gap:wr?Math.round(innerWidth-wr.right):null,onAsides:on});})()
'@
try {
  $pg = Get-PageTarget; if (-not $pg) { throw "no target" }
  $ws = $pg.webSocketDebuggerUrl
  [void](Eval $ws "location.href='holo://os/shell.html?desktop=1'")
  Start-Sleep -Seconds 6
  $pg = Get-PageTarget; $ws = $pg.webSocketDebuggerUrl
  $wb = Invoke-CdpRaw $ws "Browser.getWindowForTarget" "{}"; $wid = $wb.result.windowId
  if ($wid) { [void](Invoke-CdpRaw $ws "Browser.setWindowBounds" "{`"windowId`":$wid,`"bounds`":{`"windowState`":`"maximized`"}}") }
  Start-Sleep -Milliseconds 800

  Write-Host "`n[0] baseline:"; Eval $ws $probe
  Write-Host "`n[1] open Play (verb-run):"; [void](Eval $ws "(()=>{const b=document.getElementById('verb-run');if(b)b.click();return 1})()"); Start-Sleep -Milliseconds 700; Eval $ws $probe
  Write-Host "`n[2] new tab + selectTab(1) while Play open:"; [void](Eval $ws "(()=>{try{const t=window.__tabs;t.newTab&&t.newTab();}catch(e){return ''+e}return 1})()"); Start-Sleep -Milliseconds 700; Eval $ws $probe
  Write-Host "`n[3] selectTab(0) back:"; [void](Eval $ws "(()=>{try{window.__tabs.selectTab(0)}catch(e){return ''+e}return 1})()"); Start-Sleep -Milliseconds 700; Eval $ws $probe
  Write-Host "`n[4] dispatch resize:"; [void](Eval $ws "(()=>{dispatchEvent(new Event('resize'));return 1})()"); Start-Sleep -Milliseconds 400; Eval $ws $probe
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "`nhost stopped."
}
