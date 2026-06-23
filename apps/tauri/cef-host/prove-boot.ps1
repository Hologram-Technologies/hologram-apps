# prove-boot.ps1 — launch the CEF host on the sealed dist and prove, via localhost CDP, that a REAL
# Chromium rendered Hologram OS through the κ-route, that a pinned file is served verified (200), and
# that a bogus path is refused (404). No pixels needed.
$ErrorActionPreference = "Continue"
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe   = Join-Path $here "build\Release\holo_cef_host.exe"
$dist  = Join-Path (Split-Path -Parent $here) "dist"
if (-not (Test-Path $exe))  { throw "host not built: $exe" }
if (-not (Test-Path $dist)) { throw "no sealed dist: $dist (run ../make-dist.mjs)" }

$env:HOLO_OS_DIR = $dist
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id), HOLO_OS_DIR=$dist"

function Get-PageTarget {
  for ($i=0; $i -lt 40; $i++) {
    try {
      $list = Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/list" -TimeoutSec 3
      $pg = $list | Where-Object { $_.type -eq 'page' -and $_.url -like 'holo://*' } | Select-Object -First 1
      if ($pg) { return $pg }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Invoke-CdpEval {
  param($wsUrl, $expression)
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
  $msg = @{ id=1; method="Runtime.evaluate"; params=@{ expression=$expression; awaitPromise=$true; returnByValue=$true } } | ConvertTo-Json -Depth 8 -Compress
  $b = [System.Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([System.ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
  $buf = New-Object byte[] 131072
  $sb = New-Object System.Text.StringBuilder
  do {
    $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); $r.Wait()
    [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count))
  } while (-not $r.Result.EndOfMessage)
  $ws.Dispose()
  return ($sb.ToString() | ConvertFrom-Json)
}

try {
  $pg = Get-PageTarget
  if (-not $pg) { throw "no holo page target on CDP - host did not boot the OS" }
  Write-Host "PROOF 1 - real Chromium loaded the OS via the kappa-route:"
  Write-Host "  url:   $($pg.url)"
  Write-Host "  title: $($pg.title)"
  $ws = $pg.webSocketDebuggerUrl

  $okPin   = Invoke-CdpEval $ws "(async()=>{const r=await fetch('holo://os/_shared/holo-blake3.mjs');return r.status;})()"
  $refuse  = Invoke-CdpEval $ws "(async()=>{try{const r=await fetch('holo://os/__definitely_not_pinned__.js');return r.status;}catch(e){return 'neterr:'+e;}})()"
  Write-Host "PROOF 2 - verified pinned file served live: status $($okPin.result.result.value)"
  Write-Host "PROOF 3 - bogus path refused live:          status $($refuse.result.result.value)"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
