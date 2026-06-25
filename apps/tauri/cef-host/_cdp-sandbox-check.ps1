# _cdp-sandbox-check.ps1 - prove the bootstrap-sandbox port: host boots under bootstrap.exe, and the
# renderer is actually sandboxed (chrome://sandbox). ASCII-only.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$env:HOLO_YTDLP  = "C:\Users\pavel\Desktop\HOLOGRAM\holo-os\system\tools\bin\yt-dlp.exe"
$env:HOLO_CLOSURE_ANCHOR = ""
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue; if ($ff) { $env:HOLO_FFMPEG = $ff.Source }
function Up { try { Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 2 | Out-Null; return $true } catch { return $false } }

# Evaluate a JS expression in a target via its webSocketDebuggerUrl; return the JSON value.
function Eval-Target([string]$wsUrl, [string]$expr) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket; $ct=[System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl,$ct).Wait()
  $b=[System.Text.Encoding]::UTF8.GetBytes((@{id=1;method="Runtime.evaluate";params=@{expression=$expr;returnByValue=$true}}|ConvertTo-Json -Depth 6 -Compress))
  $ws.SendAsync([System.ArraySegment[byte]]::new($b),[System.Net.WebSockets.WebSocketMessageType]::Text,$true,$ct).Wait()
  $buf=New-Object byte[] 131072; $val=$null
  for($k=0;$k -lt 80;$k++){ $sb=New-Object System.Text.StringBuilder; do{ $r=$ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf),$ct);$r.Wait();[void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) }while(-not $r.Result.EndOfMessage); $o=$sb.ToString()|ConvertFrom-Json; if($o.id -eq 1){ $val=$o.result.result.value; break } }
  $ws.Dispose(); return $val
}

Get-Process holo_cef_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id) (this exe IS bootstrap.exe; it must load holo_cef_host.dll + call RunWinMain)"
for ($i=0; $i -lt 120 -and -not (Up); $i++) { Start-Sleep -Milliseconds 500; if ($i % 10 -eq 0) { Write-Host "  ...$([int]($i*0.5))s" } }
if (-not (Up)) {
  $alive = (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) -ne $null
  Write-Host "RESULT: CDP NEVER CAME UP - bootstrap failed to load the DLL or sandbox init crashed (pid alive: $alive)"
  return
}
Write-Host "RESULT: BOOT OK - CDP up, so bootstrap.exe loaded holo_cef_host.dll and RunWinMain ran."
$list = Invoke-RestMethod "http://127.0.0.1:9333/json/list" -TimeoutSec 4
$list | Where-Object { $_.type -eq 'page' } | ForEach-Object { $u=$_.url; if($u.Length -gt 64){$u=$u.Substring(0,64)}; Write-Host ("  page [" + $_.title + "] " + $u) }
$pg = $list | Where-Object { $_.type -eq 'page' -and $_.url -match 'holo://' } | Select-Object -First 1
if ($pg) { Write-Host ("  OS page: " + (Eval-Target $pg.webSocketDebuggerUrl 'JSON.stringify({href:location.href,title:document.title})')) }

# Sandbox status: open chrome://sandbox in a fresh tab and read its verdict line.
Write-Host "--- chrome://sandbox ---"
try {
  $tab = Invoke-RestMethod -Method Put "http://127.0.0.1:9333/json/new?chrome://sandbox" -TimeoutSec 6
  Start-Sleep -Seconds 2
  $txt = Eval-Target $tab.webSocketDebuggerUrl 'document.body?document.body.innerText.replace(/\s+/g," ").slice(0,400):""'
  Write-Host ("  " + $txt)
  if ($txt -match "adequately sandboxed") { Write-Host "RESULT: SANDBOX ACTIVE (chrome://sandbox confirms)." }
  elseif ($txt -match "not.*sandbox|NOT been") { Write-Host "RESULT: NOT sandboxed - investigate." }
  else { Write-Host "RESULT: sandbox page read, verdict text above (inspect)." }
} catch { Write-Host "  chrome://sandbox tab failed: $($_.Exception.Message)" }
Write-Host "(host left running pid $($proc.Id))"
