# _verify-bookmarks.ps1 — P1a: prove the projector mirrors the κ list onto Chrome's native bookmarks via
# chrome.bookmarks. Triggers projection in the SW, then reads back the bar's holo:// children.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$ext  = Join-Path $here "holo-toolbar-ext"
$env:HOLO_OS_DIR = $dist
$env:HOLO_EXTENSIONS = $ext
$env:HOLO_START_URL = "holo://os/shell.html?desktop=1"   # load the shell so the content script runs + seeds the bar
$p = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($p.Id) → shell (content-script trigger)"

function Targets { try { Invoke-RestMethod "http://127.0.0.1:9333/json/list" -TimeoutSec 3 } catch { $null } }
function Cdp { param($ws,$expr)
  $c=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[Threading.CancellationToken]::None
  $c.ConnectAsync([Uri]$ws,$ct).Wait()
  function Send($o){ $b=[Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Depth 8 -Compress)); $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait() }
  Send @{ id=1; method="Runtime.enable" }
  Send @{ id=2; method="Runtime.evaluate"; params=@{ expression=$expr; awaitPromise=$true; returnByValue=$true } }
  $buf=New-Object byte[] 262144; $val=$null
  for ($n=0; $n -lt 50; $n++) {
    $sb=New-Object Text.StringBuilder
    do{ $r=$c.ReceiveAsync([ArraySegment[byte]]::new($buf),$ct);$r.Wait(); [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage)
    $m=$sb.ToString()|ConvertFrom-Json
    if ($m.id -eq 2) { if ($m.result.result.value -ne $null) { $val=$m.result.result.value } elseif ($m.error) { $val="CDP-ERR: "+$m.error.message } else { $val="(no value)" }; break }
  }
  $c.Dispose(); return $val
}
try {
  $sw=$null
  for ($i=0;$i -lt 40;$i++){ $l=Targets; if($l){ $sw=$l|?{$_.type -eq 'service_worker' -and $_.url -like 'chrome-extension://*bg.js'}|select -First 1; if($sw){break} }; Start-Sleep -Milliseconds 500 }
  if (-not $sw) { throw "projector SW not found" }
  Write-Host "PROOF 1 - projector SW: $($sw.url)"
  Start-Sleep -Seconds 3   # let the shell load → content script push → SW project
  $auto = Cdp $sw.webSocketDebuggerUrl "(async()=>{try{const s=await chrome.storage.local.get('holoBookmarksProjected');return JSON.stringify(s.holoBookmarksProjected||null);}catch(e){return 'ERR:'+((e&&e.message)||e);}})()"
  Write-Host "PROOF 2 - projection record (source live=content-script): $auto"
  $bar = Cdp $sw.webSocketDebuggerUrl "(async()=>{const t=await chrome.bookmarks.getTree();const roots=(t[0]&&t[0].children)||[];const bar=roots.find(c=>c.id==='1')||roots.find(c=>c.children);const kids=bar?await chrome.bookmarks.getChildren(bar.id):[];const holo=kids.filter(k=>k.url&&k.url.indexOf('holo://')===0);return JSON.stringify({barTitle:bar&&bar.title,total:kids.length,holo:holo.length,sample:holo.slice(0,3).map(h=>h.title)});})()"
  Write-Host "PROOF 3 - native bookmarks bar contents: $bar"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
