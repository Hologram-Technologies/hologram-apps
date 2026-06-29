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
  for ($try=0; $try -lt 6; $try++) { try {
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
  if ($r -and $r.result -and $r.result.exceptionDetails) { return "THREW: " + $r.result.exceptionDetails.exception.description }
  if ($r) { return $r.result.result.value } else { return "<cdp-fail>" } }

$defn = 'window.__ns=function(){var root=document.documentElement,reserve=0,els=document.querySelectorAll(".holo-aside.on");for(var i=0;i<els.length;i++){var a=els[i];if(a.offsetParent===null)continue;var cs=getComputedStyle(a);if(cs.visibility==="hidden"||parseFloat(cs.opacity)===0)continue;var w=a.getBoundingClientRect().width;if(w>=1)reserve=Math.max(reserve,Math.round(w));}if(reserve>0){root.style.setProperty("--holo-aside-w",reserve+"px");root.classList.add("aside-open");}else{root.style.removeProperty("--holo-aside-w");root.classList.remove("aside-open");}return getComputedStyle(root).getPropertyValue("--holo-aside-w").trim()||"(empty)";};window.__mk=function(vis){var a=document.getElementById("__t");if(a)a.remove();a=document.createElement("aside");a.id="__t";a.className="holo-aside on";a.style.cssText="position:fixed;top:0;right:0;bottom:0;width:400px;z-index:60;background:#111;"+(vis?"":"visibility:hidden;");document.body.appendChild(a);return 1;};window.__gap=function(){var w=document.getElementById("world");var r=w&&w.getBoundingClientRect();return r?Math.round(innerWidth-r.right):null;};1'
try {
  $pg = Get-PageTarget; if (-not $pg) { throw "no target" }
  $ws = $pg.webSocketDebuggerUrl
  [void](Eval $ws "location.href='holo://os/shell.html?desktop=1'")
  Start-Sleep -Seconds 6
  $pg = Get-PageTarget; $ws = $pg.webSocketDebuggerUrl
  $wb = Invoke-CdpRaw $ws "Browser.getWindowForTarget" "{}"; $wid = $wb.result.windowId
  if ($wid) { [void](Invoke-CdpRaw $ws "Browser.setWindowBounds" "{`"windowId`":$wid,`"bounds`":{`"windowState`":`"maximized`"}}") }
  Start-Sleep -Milliseconds 1500
  $pg = Get-PageTarget; $ws = $pg.webSocketDebuggerUrl
  Write-Host "`n=== FIX VERIFICATION ==="
  Write-Host ("define:      " + (Eval $ws $defn))
  [void](Eval $ws "window.__mk(true)")
  Write-Host ("A visible:   asideW=" + (Eval $ws "window.__ns()") + "  worldGap=" + (Eval $ws "window.__gap()") + "   (expect ~400 / squeezed)")
  [void](Eval $ws "window.__mk(false)")
  Write-Host ("B hidden:    asideW=" + (Eval $ws "window.__ns()") + "  worldGap=" + (Eval $ws "window.__gap()") + "   (expect empty / 8)")
  [void](Eval $ws "(function(){var a=document.getElementById('__t');if(a)a.remove();document.documentElement.style.setProperty('--holo-aside-w','400px');return 1})()")
  Write-Host ("C stale:     asideW=" + (Eval $ws "window.__ns()") + "  worldGap=" + (Eval $ws "window.__gap()") + "   (expect empty / 8)")
  [void](Eval $ws "(function(){var a=document.getElementById('__t');if(a)a.remove();document.documentElement.style.removeProperty('--holo-aside-w');return 1})()")
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "`nhost stopped."
}
