$ErrorActionPreference = "Continue"
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe   = Join-Path $here "build\Release\holo_cef_host.exe"
$dist  = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id)"

function Get-PageTarget {
  for ($i=0; $i -lt 40; $i++) {
    try {
      $list = Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/list" -TimeoutSec 3
      $pg = $list | Where-Object { $_.type -eq 'page' -and $_.url -like 'holo://*' } | Select-Object -First 1
      if ($pg) { return $pg }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Invoke-CdpRaw { param($wsUrl, $method, $paramsJson)
  try {
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
  } catch { Write-Host "cdp err: $($_.Exception.Message)"; return $null }
}
function Eval { param($ws, $expr)
  $p = @{ expression=$expr; awaitPromise=$true; returnByValue=$true } | ConvertTo-Json -Depth 8 -Compress
  $r = Invoke-CdpRaw $ws "Runtime.evaluate" $p
  if ($r) { return $r.result.result.value } else { return $null }
}

$metrics = @'
(()=>{const w=document.getElementById('world');const wr=w?w.getBoundingClientRect():null;
return JSON.stringify({innerW:window.innerWidth,outerW:window.outerWidth,dpr:window.devicePixelRatio,
screenW:screen.width,availW:screen.availWidth,
world:wr?{l:Math.round(wr.left),r:Math.round(wr.right)}:null,
worldRightGap:wr?Math.round(window.innerWidth-wr.right):null});})()
'@
try {
  $pg = Get-PageTarget; if (-not $pg) { throw "no target" }
  $ws = $pg.webSocketDebuggerUrl
  [void](Eval $ws "location.href='holo://os/shell.html?desktop=1'")
  Start-Sleep -Seconds 5
  $pg = Get-PageTarget; $ws = $pg.webSocketDebuggerUrl
  $wb = Invoke-CdpRaw $ws "Browser.getWindowForTarget" "{}"; $wid = $wb.result.windowId
  Write-Host "screen info first:"; Eval $ws "JSON.stringify({screenW:screen.width,availW:screen.availWidth,dpr:devicePixelRatio})"
  foreach ($wpx in 1400,1800,2200) {
    [void](Invoke-CdpRaw $ws "Browser.setWindowBounds" "{`"windowId`":$wid,`"bounds`":{`"windowState`":`"normal`",`"left`":0,`"top`":0,`"width`":$wpx,`"height`":1000}}")
    Start-Sleep -Milliseconds 900
    Write-Host "`n=== requested width $wpx ==="
    Eval $ws $metrics
  }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "`nhost stopped."
}
