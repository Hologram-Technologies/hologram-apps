param([string]$Url, [string]$JsPath, [int]$WaitSec = 14)
# _cdp-eval.ps1 - open a tab, wait, evaluate a JS file (read raw; ConvertTo-Json escapes it for the wire).
$ErrorActionPreference = "Continue"; $CT = [Threading.CancellationToken]::None
function New-Tab($u) { try { return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { try { return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { return $null } } }
function Eval-Page($wsUrl, $expr) {
  for ($try=0; $try -lt 5; $try++) {
    $ws = New-Object Net.WebSockets.ClientWebSocket
    try { $ws.ConnectAsync([Uri]$wsUrl,$CT).Wait(8000) | Out-Null } catch { Start-Sleep -Milliseconds 800; continue }
    if ($ws.State -ne 'Open') { Start-Sleep -Milliseconds 800; continue }
    $msg = @{ id=1; method="Runtime.evaluate"; params=@{ expression=$expr; awaitPromise=$true; returnByValue=$true } } | ConvertTo-Json -Depth 12 -Compress
    $b=[Text.Encoding]::UTF8.GetBytes($msg); $ws.SendAsync([ArraySegment[byte]]::new($b),'Text',$true,$CT).Wait()
    $buf=New-Object byte[] 262144; $sb=New-Object Text.StringBuilder
    try { do { $rt=$ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$CT); if(-not $rt.Wait(40000)){ $ws.Dispose(); return "ERR:timeout" }; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$rt.Result.Count)) } while(-not $rt.Result.EndOfMessage) } catch { $ws.Dispose(); Start-Sleep -Milliseconds 800; continue }
    $ws.Dispose(); $s=$sb.ToString()
    try { return (($s|ConvertFrom-Json).result.result.value | ConvertTo-Json -Depth 10 -Compress) } catch { return "RAW:"+$s.Substring(0,[Math]::Min(600,$s.Length)) }
  }
  return "ERR:connect"
}
$t = New-Tab $Url
if (-not ($t -and $t.webSocketDebuggerUrl)) { Write-Host "no tab"; exit 1 }
Start-Sleep -Seconds $WaitSec
$expr = Get-Content -Raw $JsPath
Write-Host (Eval-Page $t.webSocketDebuggerUrl $expr)
