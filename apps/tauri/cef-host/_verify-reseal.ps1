# _verify-reseal.ps1 — boot the host on the freshly-resealed dist and prove (via CDP) that the new
# rail/extension-proxy files are served VERIFIED (200) through the κ-route at the live anchor c80fc60f,
# and a bogus path is still refused. Confirms the reseal didn't fail-close the host.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
$env:HOLO_OS_DIR = $dist
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "launched pid $($proc.Id) on dist"

function Get-PageTarget {
  for ($i=0; $i -lt 40; $i++) {
    try { $list = Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/list" -TimeoutSec 3
      $pg = $list | Where-Object { $_.type -eq 'page' -and $_.url -like 'holo://*' } | Select-Object -First 1
      if ($pg) { return $pg } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Invoke-CdpEval { param($wsUrl, $expression)
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
  $msg = @{ id=1; method="Runtime.evaluate"; params=@{ expression=$expression; awaitPromise=$true; returnByValue=$true } } | ConvertTo-Json -Depth 8 -Compress
  $b = [System.Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([System.ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()
  $buf = New-Object byte[] 131072; $sb = New-Object System.Text.StringBuilder
  do { $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); $r.Wait()
    [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count)) } while (-not $r.Result.EndOfMessage)
  $ws.Dispose(); return ($sb.ToString() | ConvertFrom-Json)
}
try {
  $pg = Get-PageTarget
  if (-not $pg) { throw "no holo page target - host fail-closed on the resealed dist?" }
  Write-Host "PROOF 1 - OS booted on resealed dist: $($pg.url)"
  $ws = $pg.webSocketDebuggerUrl
  $strand = Invoke-CdpEval $ws "(async()=>{const r=await fetch('holo://os/_shared/holo-bar-strand.mjs');return r.status+' len='+(await r.text()).length;})()"
  Write-Host "PROOF 2 - NEW E4 module served+verified: $($strand.result.result.value)"
  $ext = Invoke-CdpEval $ws "(async()=>{const r=await fetch('holo://os/usr/share/frame/extensions.html');const t=await r.text();return r.status+' hasPin='+/data-pin/.test(t);})()"
  Write-Host "PROOF 3 - extensions.html (pin button) served: $($ext.result.result.value)"
  $shell = Invoke-CdpEval $ws "(async()=>{const r=await fetch('holo://os/shell.html');const t=await r.text();return r.status+' hasExtaction='+/holo:extaction/.test(t)+' hasBars='+/window.HoloBars/.test(t);})()"
  Write-Host "PROOF 4 - shell.html (proxy+E4) served:       $($shell.result.result.value)"
  $bogus = Invoke-CdpEval $ws "(async()=>{try{const r=await fetch('holo://os/__not_pinned__.js');return r.status;}catch(e){return 'neterr';}})()"
  Write-Host "PROOF 5 - bogus path refused:                 $($bogus.result.result.value)"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
