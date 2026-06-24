# _verify-chrome-visible.ps1 — boot the native host straight to the shell (sidestep the biometric login) and
# prove the chrome bars are VISIBLE: the always-present Extensions (puzzle) button + the seeded bookmarks bar.
# Saves a screenshot to _chrome-visible.png for eyes-on confirmation.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$env:HOLO_START_URL = "holo://os/shell.html?desktop=1"
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id) → shell.html"

function Targets { try { Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/list" -TimeoutSec 3 } catch { $null } }
function WaitShell { for ($i=0;$i -lt 50;$i++){ $l=Targets; if($l){ $p=$l|?{$_.type -eq 'page' -and $_.url -like '*shell.html*'}|select -First 1; if($p){return $p} }; Start-Sleep -Milliseconds 500 }; $null }
function Cdp { param($ws,$method,$params)
  $c=New-Object System.Net.WebSockets.ClientWebSocket; $ct=[Threading.CancellationToken]::None
  $c.ConnectAsync([Uri]$ws,$ct).Wait()
  $m=@{id=1;method=$method;params=$params}|ConvertTo-Json -Depth 8 -Compress
  $b=[Text.Encoding]::UTF8.GetBytes($m)
  $c.SendAsync([ArraySegment[byte]]::new($b),[Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait()
  $buf=New-Object byte[] 2097152; $sb=New-Object Text.StringBuilder
  do{ $r=$c.ReceiveAsync([ArraySegment[byte]]::new($buf),$ct);$r.Wait(); [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while(-not $r.Result.EndOfMessage)
  $c.Dispose(); ($sb.ToString()|ConvertFrom-Json)
}
try {
  $pg = WaitShell
  if (-not $pg) { throw "shell did not load (maybe redirected to login)" }
  Write-Host "PROOF 1 - shell loaded: $($pg.url)"
  $ws = $pg.webSocketDebuggerUrl
  Start-Sleep -Seconds 2
  $expr = "(async()=>{await new Promise(r=>setTimeout(r,800));const xb=document.getElementById('rail-ext');const r=xb&&xb.getBoundingClientRect();const o=document.getElementById('omni');const bm=document.getElementById('bookmarkbar');return JSON.stringify({extBtn:!!xb,extVisible:!!(r&&r.width>0),rightOfOmni:(o&&r)?r.x>=o.getBoundingClientRect().right-4:null,bookmarks:bm?bm.childElementCount:0});})()"
  $res = Cdp $ws "Runtime.evaluate" @{ expression=$expr; awaitPromise=$true; returnByValue=$true }
  Write-Host "PROOF 2 - chrome visibility: $($res.result.result.value)"
  # screenshot
  $shot = Cdp $ws "Page.captureScreenshot" @{ format="png" }
  if ($shot.result.data) {
    $out = Join-Path $here "_chrome-visible.png"
    [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($shot.result.data))
    Write-Host "PROOF 3 - screenshot saved → $out ($((Get-Item $out).Length) bytes)"
  } else { Write-Host "PROOF 3 - screenshot: no data" }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
