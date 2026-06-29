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
}
function Eval { param($ws, $expr)
  $p = @{ expression=$expr; awaitPromise=$true; returnByValue=$true } | ConvertTo-Json -Depth 8 -Compress
  (Invoke-CdpRaw $ws "Runtime.evaluate" $p).result.result.value
}

$probe = @'
(()=>{const out={url:location.href,rs:document.readyState,title:document.title,bodyId:document.body.id,bodyCls:document.body.className};
out.hasWorld=!!document.getElementById('world');
out.ids=[...document.querySelectorAll('body > *')].slice(0,40).map(e=>({t:e.tagName.toLowerCase(),id:e.id||'',cls:(e.className&&e.className.toString().slice(0,30))||'',d:getComputedStyle(e).display}));
return JSON.stringify(out);})()
'@
try {
  $pg = Get-PageTarget
  if (-not $pg) { throw "no holo page target" }
  $ws = $pg.webSocketDebuggerUrl
  Start-Sleep -Milliseconds 2500
  Write-Host "`n=== PROBE ==="
  Eval $ws $probe
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "`nhost stopped."
}
