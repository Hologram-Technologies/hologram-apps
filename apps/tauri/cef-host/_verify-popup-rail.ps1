# _verify-popup-rail.ps1 — P2: prove the Hologram action popup renders the κ app-rail grid.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$ext  = Join-Path $here "holo-toolbar-ext"
$id   = "kekaokfgifngdmffomdbepjagmnnmdmn"
$env:HOLO_OS_DIR = $dist
$env:HOLO_EXTENSIONS = $ext
$env:HOLO_START_URL = "holo://os/shell.html?desktop=1"
$p = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($p.Id)"

function Cdp { param($ws,$expr)
  $c=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[Threading.CancellationToken]::None
  try { $c.ConnectAsync([Uri]$ws,$ct).Wait() } catch { return "WS-CONNECT-FAIL" }
  function Send($o){ $b=[Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Depth 8 -Compress)); $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait() }
  Send @{ id=1; method="Runtime.enable" }
  Send @{ id=2; method="Runtime.evaluate"; params=@{ expression=$expr; awaitPromise=$true; returnByValue=$true } }
  $buf=New-Object byte[] 262144; $val=$null
  for ($n=0; $n -lt 50; $n++) {
    $sb=New-Object Text.StringBuilder
    try { do{ $r=$c.ReceiveAsync([ArraySegment[byte]]::new($buf),$ct);$r.Wait(); [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage) }
    catch { break }
    $m=$sb.ToString()|ConvertFrom-Json
    if ($m.id -eq 2) { if ($m.result.result.value -ne $null) { $val=$m.result.result.value } elseif ($m.error) { $val="CDP-ERR: "+$m.error.message } else { $val="(no value)" }; break }
  }
  try { $c.Dispose() } catch {}
  return $val
}
try {
  # wait for host, then open the popup page as its own tab via the CDP /json/new endpoint
  $new=$null
  for ($i=0;$i -lt 40;$i++){
    try { $new = Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?chrome-extension://$id/popup.html") -TimeoutSec 3 } catch {}
    if ($new -and $new.webSocketDebuggerUrl) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $new -or -not $new.webSocketDebuggerUrl) { throw "couldn't open popup tab via /json/new" }
  Write-Host "PROOF 1 - popup tab opened: $($new.url)"
  Start-Sleep -Seconds 2   # popup.js fetches bundled list + renders the grid
  $r = Cdp $new.webSocketDebuggerUrl "JSON.stringify({title:document.title,tiles:document.querySelectorAll('.tile').length,header:(document.querySelector('header')||{}).textContent,first:(document.querySelector('.tile .lbl')||{}).textContent,last:(document.querySelectorAll('.tile .lbl')[document.querySelectorAll('.tile .lbl').length-1]||{}).textContent})"
  Write-Host "PROOF 2 - popup app-rail grid: $r"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
