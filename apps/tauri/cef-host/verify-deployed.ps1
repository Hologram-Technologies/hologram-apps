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
function Eval { param($wsUrl, $expr)
  for ($try=0; $try -lt 5; $try++) { try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter(6000); $ct = $cts.Token
    $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
    $p = @{ id=1; method="Runtime.evaluate"; params=@{ expression=$expr; awaitPromise=$true; returnByValue=$true } } | ConvertTo-Json -Depth 8 -Compress
    $b = [System.Text.Encoding]::UTF8.GetBytes($p)
    $ws.SendAsync([System.ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
    $buf = New-Object byte[] 262144; $sb = New-Object System.Text.StringBuilder
    do { $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); $r.Wait()
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while (-not $r.Result.EndOfMessage)
    $ws.Dispose()
    $j = $sb.ToString() | ConvertFrom-Json
    if ($j.result.exceptionDetails) { return "THREW: " + $j.result.exceptionDetails.exception.description }
    return $j.result.result.value
  } catch { Start-Sleep -Milliseconds 500 } } ; return "<cdp-fail>" }

$test = @'
(async()=>{
  const txt = await fetch("holo://os/_shared/holo-aside.mjs").then(r=>r.text());
  const served = txt.includes("offsetParent===null") ? "NEW" : "OLD";
  const root = document.documentElement;
  const gap = ()=>{const w=document.getElementById("world");const r=w&&w.getBoundingClientRect();return r?Math.round(innerWidth-r.right):null;};
  const g0 = gap();
  root.style.setProperty("--holo-aside-w","360px");
  const g1 = gap();
  dispatchEvent(new Event("resize"));
  await new Promise(r=>setTimeout(r,250));
  const g2 = gap();
  const av = getComputedStyle(root).getPropertyValue("--holo-aside-w").trim()||"(empty)";
  return JSON.stringify({served, baselineGap:g0, strandedGap:g1, afterResizeGap:g2, asideW:av});
})()
'@
try {
  $pg = Get-PageTarget; if (-not $pg) { throw "no target" }
  [void](Eval $pg.webSocketDebuggerUrl "location.href='holo://os/shell.html?desktop=1'")
  Start-Sleep -Seconds 7
  $pg = Get-PageTarget
  Write-Host "`n=== DEPLOYED MODULE SELF-HEAL (no maximize) ==="
  Write-Host (Eval $pg.webSocketDebuggerUrl $test)
  Write-Host "(served NEW · baseline ~8 · stranded ~368 · afterResize back to ~8 / empty = FIXED)"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "`nhost stopped."
}
