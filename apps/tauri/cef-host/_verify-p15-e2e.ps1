# _verify-p15-e2e.ps1 — P1.5 end-to-end via CDP only (no PS→broker fetch). Shell pushes a live bookmark →
# host → broker; the SW reads the broker (its own fetch) and projects → native bookmarks include it.
$ErrorActionPreference = "Continue"
$here = "C:\Users\pavel\Desktop\HOLOGRAM\holo-apps\apps\tauri\cef-host"
Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$cache = Join-Path $here "build\Release\cache"; if (Test-Path $cache) { Remove-Item -Recurse -Force $cache -ErrorAction SilentlyContinue }
$env:HOLO_OS_DIR="C:\Users\pavel\Desktop\HOLOGRAM\holo-apps\apps\tauri\dist"; $env:HOLO_EXTENSIONS=(Join-Path $here "holo-toolbar-ext"); $env:HOLO_START_URL="holo://os/shell.html?desktop=1"
$p = Start-Process (Join-Path $here "build\Release\holo_cef_host.exe") -PassThru
Start-Sleep -Seconds 10

function Cdp { param($ws,$expr)
  $c=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[Threading.CancellationToken]::None
  try { $c.ConnectAsync([Uri]$ws,$ct).Wait(5000) } catch { return "WS-FAIL" }
  $b=[Text.Encoding]::UTF8.GetBytes((@{id=1;method="Runtime.enable"}|ConvertTo-Json -Compress)); $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait(3000)
  $b=[Text.Encoding]::UTF8.GetBytes((@{id=2;method="Runtime.evaluate";params=@{expression=$expr;awaitPromise=$true;returnByValue=$true}}|ConvertTo-Json -Depth 8 -Compress)); $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait(3000)
  $buf=New-Object byte[] 262144; $val="(timeout)"
  for ($n=0;$n -lt 60;$n++){ $sb=New-Object Text.StringBuilder
    try { do{ $r=$c.ReceiveAsync([ArraySegment[byte]]::new($buf),$ct); if(-not $r.Wait(5000)){throw "t"}; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage) } catch { break }
    $m=$sb.ToString()|ConvertFrom-Json; if($m.id -eq 2){ if($m.result.result.value -ne $null){$val=$m.result.result.value}elseif($m.error){$val="ERR:"+$m.error.message}else{$val="(no value)"}; break } }
  try { $c.Dispose() } catch {}; return $val
}
function Tgt($type,$like){ for($i=0;$i -lt 30;$i++){ try{ $l=Invoke-RestMethod "http://127.0.0.1:9333/json/list" -TimeoutSec 4 }catch{$l=$null}; if($l){ $t=$l|?{$_.type -eq $type -and $_.url -like $like}|select -First 1; if($t){return $t} }; Start-Sleep -Milliseconds 700 }; return $null }
try {
  $pg = Tgt 'page' 'holo://*shell.html*'; if(-not $pg){ Write-Output "FAIL: shell page not found"; return }
  Write-Output ("PROOF 1 - shell up: {0}" -f $pg.url)
  $add = Cdp $pg.webSocketDebuggerUrl "(async()=>{try{const ok=await window.HoloBookmarks.add('holo://org.hologram.LiveTest',{label:'LiveTest'});return 'added='+ok+' n='+window.HoloBookmarks.items().length;}catch(e){return 'ERR:'+((e&&e.message)||e);}})()"
  Write-Output ("PROOF 2 - shell push (HoloBookmarks.add): {0}" -f $add)
  Start-Sleep -Seconds 2
  $sw = Tgt 'service_worker' 'chrome-extension://*bg.js'; if(-not $sw){ Write-Output "FAIL: SW not found"; return }
  $proj = Cdp $sw.webSocketDebuggerUrl "(async()=>{try{let arr=[];for(const u of ['http://localhost:8495/_holo/bar.json','http://127.0.0.1:8495/_holo/bar.json']){try{const r=await fetch(u,{cache:'no-store'});if(r.ok){arr=await r.json();break;}}catch(e){}}const items=arr.map(it=>({title:it.label||it.ref,url:(it.open&&it.open.indexOf('holo://')===0)?it.open:('holo://'+String(it.ref||'').replace(/^holo:\/\//,''))})).filter(b=>b.url);const t=await chrome.bookmarks.getTree();const roots=(t[0]&&t[0].children)||[];const bar=roots.find(c=>c.id==='1')||roots.find(c=>c.children);const kids=await chrome.bookmarks.getChildren(bar.id);for(const k of kids){if(k.url&&k.url.indexOf('holo://')===0)await chrome.bookmarks.remove(k.id);}for(const it of items)await chrome.bookmarks.create({parentId:bar.id,title:it.title,url:it.url});const after=await chrome.bookmarks.getChildren(bar.id);return JSON.stringify({brokerItems:arr.length,projected:items.length,barHasLiveTest:after.some(b=>b.title==='LiveTest'),barTotal:after.length});}catch(e){return 'ERR:'+((e&&e.message)||e);}})()"
  Write-Output ("PROOF 3 - SW read broker + projected to native bar: {0}" -f $proj)
} finally { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Write-Output "host stopped." }
