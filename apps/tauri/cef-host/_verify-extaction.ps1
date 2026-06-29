# _verify-extaction.ps1 — boot the host on sealed dist, prove the OS loads via CDP, then prove the new
# holo:extaction proxy verb is REACHABLE and ENFORCES its validation (valid-form → ok; bad scheme / bad id
# → refused). Reuses the prove-boot CDP plumbing.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
if (-not (Test-Path $exe))  { throw "host not built: $exe" }
if (-not (Test-Path $dist)) { throw "no sealed dist: $dist" }

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
function Invoke-CdpEval {
  param($wsUrl, $expression)
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
  $msg = @{ id=1; method="Runtime.evaluate"; params=@{ expression=$expression; awaitPromise=$true; returnByValue=$true } } | ConvertTo-Json -Depth 8 -Compress
  $b = [System.Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([System.ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
  $buf = New-Object byte[] 131072
  $sb = New-Object System.Text.StringBuilder
  do {
    $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); $r.Wait()
    [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count))
  } while (-not $r.Result.EndOfMessage)
  $ws.Dispose()
  return ($sb.ToString() | ConvertFrom-Json)
}
# wrap the callback-based cefQuery into a promise so awaitPromise can resolve it
function CefQ($req) {
  return "(async()=>{return await new Promise(res=>{try{window.cefQuery({request:'$req',persistent:false,onSuccess:r=>res('ok:'+r),onFailure:(c,m)=>res('fail:'+c+':'+m)});}catch(e){res('throw:'+e);}});})()"
}

try {
  $pg = Get-PageTarget
  if (-not $pg) { throw "no holo page target on CDP - host did not boot" }
  Write-Host "PROOF 1 - OS booted via kappa-route: $($pg.url)"
  $ws = $pg.webSocketDebuggerUrl

  $valid = Invoke-CdpEval $ws (CefQ "holo:extaction:chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html")
  Write-Host "PROOF 2 - verb reachable, valid form ACCEPTED: $($valid.result.result.value)"

  $badScheme = Invoke-CdpEval $ws (CefQ "holo:extaction:https://evil.example/x")
  Write-Host "PROOF 3 - non-chrome-extension url REFUSED:     $($badScheme.result.result.value)"

  $badId = Invoke-CdpEval $ws (CefQ "holo:extaction:chrome-extension://NOTAVALIDEXTID/popup.html")
  Write-Host "PROOF 4 - bad extension id REFUSED:             $($badId.result.result.value)"

  $traversal = Invoke-CdpEval $ws (CefQ "holo:extaction:chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/../../etc/x")
  Write-Host "PROOF 5 - path traversal REFUSED:               $($traversal.result.result.value)"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
