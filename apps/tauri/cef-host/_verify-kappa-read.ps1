# _verify-kappa-read.ps1 — P0 proof: load the Hologram projector extension and check whether its service
# worker can READ the κ substrate (holo://) — the hinge of the κ-projection approach. Finds the SW target
# via CDP and reads globalThis.__holoKappaRead.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$ext  = Join-Path $here "holo-toolbar-ext"
$env:HOLO_OS_DIR = $dist
$env:HOLO_EXTENSIONS = $ext
$p = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($p.Id)  ext=$ext"

function Targets { try { Invoke-RestMethod "http://127.0.0.1:9333/json/list" -TimeoutSec 3 } catch { $null } }
function Cdp { param($ws,$expr)
  $c=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[Threading.CancellationToken]::None
  $c.ConnectAsync([Uri]$ws,$ct).Wait()
  function Send($obj){ $b=[Text.Encoding]::UTF8.GetBytes(($obj|ConvertTo-Json -Depth 8 -Compress)); $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait() }
  Send @{ id=1; method="Runtime.enable" }
  Send @{ id=2; method="Runtime.evaluate"; params=@{ expression=$expr; awaitPromise=$true; returnByValue=$true } }
  $buf=New-Object byte[] 262144; $val=$null
  for ($n=0; $n -lt 40; $n++) {
    $sb=New-Object Text.StringBuilder
    do{ $r=$c.ReceiveAsync([ArraySegment[byte]]::new($buf),$ct);$r.Wait(); [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage)
    $msg = $sb.ToString() | ConvertFrom-Json
    if ($msg.id -eq 2) { if ($msg.result.result.value -ne $null) { $val = $msg.result.result.value } elseif ($msg.error) { $val = "CDP-ERR: " + $msg.error.message } else { $val = "(no value)" } ; break }
  }
  $c.Dispose(); return $val
}
try {
  # wait for the OS page (host booted) + give the SW time to instantiate + run its probe
  $sw=$null
  for ($i=0; $i -lt 40; $i++) {
    $l = Targets
    if ($l) {
      $sw = $l | ? { $_.type -eq 'service_worker' -and $_.url -like 'chrome-extension://*bg.js' } | select -First 1
      if ($sw) { break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $sw) {
    Write-Host "PROOF - service worker target: NOT FOUND. Targets seen:"
    (Targets) | ForEach-Object { "   $($_.type)  $($_.url)" }
    throw "SW not found (MV3 lazy, or extension didn't load)"
  }
  Write-Host "PROOF 1 - projector SW present: $($sw.url)"
  # Direct live probe IN the SW context (sidesteps MV3 SW ephemerality): can it fetch holo://?
  $live = Cdp $sw.webSocketDebuggerUrl "(async()=>{try{const r=await fetch('holo://os/_shared/holo-bar.mjs');const t=await r.text();return JSON.stringify({option:'A:sw-fetch',status:r.status,len:t.length,ok:r.ok&&t.length>0});}catch(e){return 'ERR:'+((e&&e.message)||e);}})()"
  Write-Host "PROOF 2 - SW fetch holo:// (option A): $live"
  # can it also drive Chrome's native bookmarks bar? (P1 capability check)
  $bm = Cdp $sw.webSocketDebuggerUrl "(async()=>{try{const t=await chrome.bookmarks.getTree();return JSON.stringify({bookmarksApi:!!t,roots:(t&&t[0]&&t[0].children||[]).length});}catch(e){return 'ERR:'+((e&&e.message)||e);}})()"
  Write-Host "PROOF 3 - chrome.bookmarks reachable (P1): $bm"
  # Option C: can the SW read κ over the host's localhost broker (http IS fetchable from a SW)?
  # Is the broker even serving? Probe directly from PS (no CORS/permission in play here).
  $direct = "down"; foreach ($u in @("http://localhost:8495/","http://127.0.0.1:8495/")) { try { $rr = Invoke-WebRequest $u -TimeoutSec 2 -UseBasicParsing; $direct = "up status=$($rr.StatusCode)"; break } catch { if ($_.Exception.Response) { $direct = "up status=$([int]$_.Exception.Response.StatusCode)" ; break } } }
  Write-Host "PROOF 4 - broker serving (direct PS probe :8495): $direct"
  $broker = Cdp $sw.webSocketDebuggerUrl "(async()=>{for(const u of ['http://localhost:8495/','http://127.0.0.1:8495/']){try{const r=await fetch(u);return JSON.stringify({url:u,status:r.status});}catch(e){}}return 'ALL-FAILED';})()"
  Write-Host "PROOF 5 - SW fetch broker http (option C, with localhost perm): $broker"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
