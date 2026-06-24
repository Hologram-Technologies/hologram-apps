# _cdp-sc-net.ps1 — capture the raw network result of holo://os/sc/vstream so we can see WHAT the route
# returned (status / mime / failure text), independent of media-element quirks.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$env:HOLO_YTDLP  = "C:\Users\pavel\Desktop\HOLOGRAM\holo-os\system\tools\bin\yt-dlp.exe"
$env:HOLO_FFMPEG = "ffmpeg"
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id)"

function Wait-Cdp { for ($i=0;$i -lt 40;$i++){ try { Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 2 | Out-Null; return $true } catch {}; Start-Sleep -Milliseconds 500 }; return $false }
function New-Tab($u) { try { return Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { try { return Invoke-RestMethod -Uri ("http://127.0.0.1:9333/json/new?"+$u) -TimeoutSec 8 } catch { return $null } } }

# Connect, send msgs, then read ALL frames for $seconds and dump any containing $filter.
function CdpCapture($wsUrl, $msgs, $seconds, $filter) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
  foreach ($m in $msgs) {
    $b = [System.Text.Encoding]::UTF8.GetBytes(($m | ConvertTo-Json -Depth 8 -Compress))
    $ws.SendAsync([System.ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
  }
  $buf = New-Object byte[] 262144
  $deadline = (Get-Date).AddSeconds($seconds)
  $hits = @()
  while ((Get-Date) -lt $deadline) {
    try {
      $sb = New-Object System.Text.StringBuilder
      do { $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); if (-not $r.Wait(2000)) { break }; [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while (-not $r.Result.EndOfMessage)
      $s = $sb.ToString()
      if ($s -and ($s -match $filter)) { $hits += $s }
    } catch { break }
  }
  $ws.Dispose(); return $hits
}

try {
  if (-not (Wait-Cdp)) { throw "CDP never came up" }
  $reel = "https://www.youtube.com/watch?v=AOCQp6lAfEE"
  $scUrl = "holo://os/sc/vstream?url=" + [uri]::EscapeDataString($reel) + "&h=480"
  $t = New-Tab "about:blank"
  $ws = $t.webSocketDebuggerUrl
  $msgs = @(@{id=1;method="Network.enable"}, @{id=2;method="Page.enable"}, @{id=3;method="Page.navigate";params=@{url=$scUrl}})
  Write-Host "direct-navigating to the route, capturing its network result (30s)..."
  $hits = CdpCapture $ws $msgs 30 "Network\."
  $reqId = $null
  foreach ($h in $hits) {
    foreach ($obj in @($h | ConvertFrom-Json)) {
      switch ($obj.method) {
        "Network.requestWillBeSent" { if ($obj.params.request.url -match "/sc/vstream") { $reqId = $obj.params.requestId; Write-Host ("REQUEST " + $obj.params.request.url.Substring(0,60) + " id=" + $reqId) } }
        "Network.responseReceived"  { if ($obj.params.response.url -match "/sc/vstream") { Write-Host ("RESP status=" + $obj.params.response.status + " mime=" + $obj.params.response.mimeType + " hdrs=" + ($obj.params.response.headers | ConvertTo-Json -Compress)) } }
        "Network.loadingFailed"     { if ($obj.params.requestId -eq $reqId) { Write-Host ("FAILED err=" + $obj.params.errorText) } }
        "Network.loadingFinished"   { if ($obj.params.requestId -eq $reqId) { Write-Host ("FINISHED bytes=" + $obj.params.encodedDataLength) } }
      }
    }
  }
  if (-not $hits) { Write-Host "no network frames captured" }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
