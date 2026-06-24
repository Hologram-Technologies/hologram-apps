# _verify-popup.ps1 — the real end-to-end: load an action+popup extension, fire holo:extaction via the
# shell, and confirm the extension's popup actually RENDERED (its marker DOM is present) in the popup window.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$ext  = Join-Path $here "test-ext-popup"
$id   = "glnnkklhbkpdokhckaoajoiigiabplad"
$env:HOLO_OS_DIR = $dist
$env:HOLO_EXTENSIONS = $ext
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id)  ext=$ext"

function Get-Targets { try { return Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/list" -TimeoutSec 3 } catch { return $null } }
function Wait-HoloPage { for ($i=0;$i -lt 40;$i++){ $l=Get-Targets; if($l){ $p=$l|?{$_.type -eq 'page' -and $_.url -like 'holo://*'}|select -First 1; if($p){return $p} }; Start-Sleep -Milliseconds 500 }; return $null }
function Cdp { param($ws,$expr)
  $c=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[System.Threading.CancellationToken]::None
  $c.ConnectAsync([Uri]$ws,$ct).Wait()
  $m=@{id=1;method="Runtime.evaluate";params=@{expression=$expr;awaitPromise=$true;returnByValue=$true}}|ConvertTo-Json -Depth 8 -Compress
  $b=[Text.Encoding]::UTF8.GetBytes($m)
  $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait()
  $buf=New-Object byte[] 131072; $sb=New-Object Text.StringBuilder
  do{ $r=$c.ReceiveAsync([ArraySegment[byte]]::new($buf),$ct);$r.Wait(); [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage)
  $c.Dispose(); return ($sb.ToString()|ConvertFrom-Json)
}
try {
  $pg = Wait-HoloPage
  if (-not $pg) { throw "host did not boot" }
  Write-Host "PROOF 1 - OS booted: $($pg.url)"
  # fire the proxy verb from the shell (exactly what a rail click does)
  $fire = Cdp $pg.webSocketDebuggerUrl "(async()=>{return await new Promise(res=>{window.cefQuery({request:'holo:extaction:chrome-extension://$id/popup.html',persistent:false,onSuccess:r=>res('ok:'+r),onFailure:(c,m)=>res('fail:'+c+':'+m)});});})()"
  Write-Host "PROOF 2 - extaction fired: $($fire.result.result.value)"
  # find the popup window target + read its marker DOM
  $popup = $null
  for ($i=0; $i -lt 30; $i++) {
    $l = Get-Targets
    $popup = $l | ? { $_.url -like "chrome-extension://$id/popup.html*" } | select -First 1
    if ($popup) { break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $popup) { Write-Host "PROOF 3 - popup target: NOT FOUND (popup did not open)"; }
  else {
    Write-Host "PROOF 3 - popup window target present: $($popup.url)"
    $mark = Cdp $popup.webSocketDebuggerUrl "(document.getElementById('mark')&&document.getElementById('mark').textContent)||('NO-MARK title='+document.title)"
    Write-Host "PROOF 4 - popup RENDERED, marker = $($mark.result.result.value)"
  }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
