# _cdp-media-probe.ps1 — Phase 0 of Universal Media. Boot the host, attach over CDP :9333, and measure
# the ENGINE's real media capabilities (codecs + EME/Widevine). These are engine-global, so we read them
# off the guaranteed-booting holo://os page — no network, isolating the engine from page-load/egress.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $here "build\Release\holo_cef_host.exe"
$dist = Join-Path (Split-Path -Parent $here) "dist"
if (-not (Test-Path $exe))  { throw "host not built: $exe" }
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
  $buf = New-Object byte[] 262144
  $sb = New-Object System.Text.StringBuilder
  do {
    $r = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buf), $ct); $r.Wait()
    [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$r.Result.Count))
  } while (-not $r.Result.EndOfMessage)
  $ws.Dispose()
  return ($sb.ToString() | ConvertFrom-Json)
}

$probe = @'
(async () => {
  const v = document.createElement('video');
  const a = document.createElement('audio');
  const ct = (e,t) => { const r = e.canPlayType(t); return r === '' ? 'no' : r; };
  const mse = (t) => (window.MediaSource && MediaSource.isTypeSupported(t)) ? 'yes' : 'no';
  async function eme(ks){ try { await navigator.requestMediaKeySystemAccess(ks, [{
      initDataTypes:['cenc'],
      videoCapabilities:[{contentType:'video/mp4; codecs="avc1.640028"'}],
      audioCapabilities:[{contentType:'audio/mp4; codecs="mp4a.40.2"'}] }]);
    return 'available'; } catch(e){ return 'reject:'+e.name; } }
  return {
    ua: navigator.userAgent,
    canPlay: {
      h264: ct(v,'video/mp4; codecs="avc1.640028"'),
      aac:  ct(a,'audio/mp4; codecs="mp4a.40.2"'),
      mp3:  ct(a,'audio/mpeg'),
      hevc: ct(v,'video/mp4; codecs="hvc1.1.6.L93.B0"'),
      av1:  ct(v,'video/mp4; codecs="av01.0.05M.08"'),
      vp9:  ct(v,'video/webm; codecs="vp9"'),
      opus: ct(a,'audio/webm; codecs="opus"')
    },
    mse: {
      h264: mse('video/mp4; codecs="avc1.640028"'),
      aac:  mse('audio/mp4; codecs="mp4a.40.2"'),
      hevc: mse('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      av1:  mse('video/mp4; codecs="av01.0.05M.08"'),
      vp9:  mse('video/webm; codecs="vp9"')
    },
    eme: { widevine: await eme('com.widevine.alpha'), clearkey: await eme('org.w3.clearkey') }
  };
})()
'@

try {
  $pg = Get-PageTarget
  if (-not $pg) { throw "no holo page target on CDP - host did not boot the OS" }
  Write-Host "booted: $($pg.url)"
  $res = Invoke-CdpEval $pg.webSocketDebuggerUrl $probe
  $val = $res.result.result.value
  if ($null -eq $val) { Write-Host "EVAL ERROR:"; $res | ConvertTo-Json -Depth 10 }
  else {
    Write-Host "===== ENGINE MEDIA CAPABILITY ====="
    Write-Host "UA: $($val.ua)"
    Write-Host "canPlayType: $($val.canPlay | ConvertTo-Json -Compress)"
    Write-Host "MSE.isTypeSupported: $($val.mse | ConvertTo-Json -Compress)"
    Write-Host "EME: $($val.eme | ConvertTo-Json -Compress)"
  }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "host stopped."
}
