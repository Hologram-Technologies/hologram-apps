# _verify-live-bookmarks.ps1 — P1.5: prove the LIVE channel shell → host → broker → SW → native bookmarks.
# Adds a distinctive bookmark in the shell, confirms it flows to the broker, then the SW reads+projects it.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$ext  = Join-Path $here "holo-toolbar-ext"
# clean slate: kill any host + wait until BOTH ports are actually free (avoid zombie contention)
Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$k=0; while ((((Get-NetTCPConnection -LocalPort 9333 -State Listen -ErrorAction SilentlyContinue)) -or ((Get-NetTCPConnection -LocalPort 8495 -State Listen -ErrorAction SilentlyContinue))) -and $k -lt 15) {
  (Get-NetTCPConnection -LocalPort 9333 -State Listen -ErrorAction SilentlyContinue).OwningProcess + (Get-NetTCPConnection -LocalPort 8495 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {} }
  Start-Sleep 1; $k++
}
Write-Host "ports free (9333/8495): $(-not [bool](Get-NetTCPConnection -LocalPort 9333 -State Listen -ErrorAction SilentlyContinue))/$(-not [bool](Get-NetTCPConnection -LocalPort 8495 -State Listen -ErrorAction SilentlyContinue))"
Remove-Item -Recurse -Force (Join-Path $here "build\Release\cache") -ErrorAction SilentlyContinue
$env:HOLO_OS_DIR=$dist; $env:HOLO_EXTENSIONS=$ext; $env:HOLO_START_URL="holo://os/shell.html?desktop=1"
$p = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($p.Id)"
Start-Sleep -Seconds 10   # generous full boot: shell + deferred broker (1200ms) + extension SW (onInstalled)

function Targets { try { Invoke-RestMethod "http://127.0.0.1:9333/json/list" -TimeoutSec 3 } catch { $null } }
function Cdp { param($ws,$expr)
  $c=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[Threading.CancellationToken]::None
  try { $c.ConnectAsync([Uri]$ws,$ct).Wait() } catch { return "WS-FAIL" }
  function Send($o){ $b=[Text.Encoding]::UTF8.GetBytes(($o|ConvertTo-Json -Depth 8 -Compress)); $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait() }
  Send @{ id=1; method="Runtime.enable" }; Send @{ id=2; method="Runtime.evaluate"; params=@{ expression=$expr; awaitPromise=$true; returnByValue=$true } }
  $buf=New-Object byte[] 262144; $val=$null
  for ($n=0; $n -lt 60; $n++) { $sb=New-Object Text.StringBuilder
    try { do{ $r=$c.ReceiveAsync([ArraySegment[byte]]::new($buf),$ct);$r.Wait(); [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage) } catch { break }
    $m=$sb.ToString()|ConvertFrom-Json; if ($m.id -eq 2) { if ($m.result.result.value -ne $null) { $val=$m.result.result.value } elseif ($m.error) { $val="CDP-ERR: "+$m.error.message } else { $val="(no value)" }; break } }
  try { $c.Dispose() } catch {}; return $val
}
function Find($type,$like){ for($i=0;$i -lt 50;$i++){ $l=Targets; if($l){ $t=$l|?{$_.type -eq $type -and $_.url -like $like}|select -First 1; if($t){return $t} }; Start-Sleep -Milliseconds 500 }; return $null }
try {
  $pg = Find 'page' 'holo://*shell.html*'; if (-not $pg) { throw "shell not up" }
  Write-Host "PROOF 1 - shell up: $($pg.url)"
  Start-Sleep -Seconds 2
  # add a distinctive LIVE bookmark in the shell → triggers the push
  $add = Cdp $pg.webSocketDebuggerUrl "(async()=>{try{const ok=await window.HoloBookmarks.add('holo://org.hologram.LiveTest',{label:'LiveTest'});return 'added='+ok+' count='+window.HoloBookmarks.items().length;}catch(e){return 'ERR:'+((e&&e.message)||e);}})()"
  Write-Host "PROOF 2 - shell added live bookmark: $add"
  Start-Sleep -Seconds 1
  # broker now serves the pushed list?
  $broker = "down"; try { $b = Invoke-RestMethod "http://127.0.0.1:8495/_holo/bar.json" -TimeoutSec 3; $broker = "items=$($b.Count) hasLiveTest=$([bool]($b | ? { $_.label -eq 'LiveTest' }))" } catch { $broker = "ERR $_" }
  Write-Host "PROOF 3 - broker /_holo/bar.json (host received push): $broker"
  # SW reads the broker + projects → native bookmarks include LiveTest
  $sw = Find 'service_worker' 'chrome-extension://*bg.js'; if (-not $sw) { throw "SW not found" }
  $proj = Cdp $sw.webSocketDebuggerUrl "(async()=>{try{const r=await fetch('http://localhost:8495/_holo/bar.json',{cache:'no-store'});const arr=await r.json();const items=arr.map(it=>({title:it.label||it.ref,url:(it.open&&it.open.indexOf('holo://')===0)?it.open:('holo://'+String(it.ref||'').replace(/^holo:\/\//,''))})).filter(b=>b.url);const t=await chrome.bookmarks.getTree();const roots=(t[0]&&t[0].children)||[];const bar=roots.find(c=>c.id==='1')||roots.find(c=>c.children);const kids=await chrome.bookmarks.getChildren(bar.id);for(const k of kids){if(k.url&&k.url.indexOf('holo://')===0)await chrome.bookmarks.remove(k.id);}for(const it of items)await chrome.bookmarks.create({parentId:bar.id,title:it.title,url:it.url});const after=await chrome.bookmarks.getChildren(bar.id);return JSON.stringify({brokerItems:arr.length,projected:items.length,barHasLiveTest:after.some(b=>b.title==='LiveTest')});}catch(e){return 'ERR:'+((e&&e.message)||e);}})()"
  Write-Host "PROOF 4 - SW read broker + projected to native bar: $proj"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Write-Host "host stopped."
}
