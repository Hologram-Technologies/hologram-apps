#!/usr/bin/env python3
# verify-widevine.py — prove DRM/EME on a built Hologram-ungoogled chrome, network-free.
#
# Two-stage proof:
#   1) requestMediaKeySystemAccess('com.widevine.alpha', <vp9>)  → EME *support* compiled in (enable_widevine).
#   2) access.createMediaKeys()                                   → the Widevine CDM .so actually LOADS from the
#                                                                   profile component (runtime provisioning works).
# ClearKey is probed as a control. Old binary (enable_widevine=false) → 'unsupported' (correct "before").
#
# Usage: python3 verify-widevine.py <chrome-binary> <user-data-dir> [port]
import json,subprocess,time,urllib.request,socket,os,signal,base64,struct,sys,threading
from urllib.parse import urlparse
from http.server import HTTPServer,BaseHTTPRequestHandler
BIN=sys.argv[1] if len(sys.argv)>1 else "/home/humuhumu33/uc-build/ungoogled-chromium/build/src/out/Default/chrome"
PROF=sys.argv[2] if len(sys.argv)>2 else "/home/humuhumu33/.holo-uc-profile"
PORT=int(sys.argv[3]) if len(sys.argv)>3 else 9447
# EME requires a SECURE CONTEXT. http://127.0.0.1 is "potentially trustworthy" → secure, no TLS needed.
SRVPORT=PORT+100
class H(BaseHTTPRequestHandler):
  def do_GET(self):
    self.send_response(200);self.send_header("Content-Type","text/html");self.end_headers()
    self.wfile.write(b"<!doctype html><title>wv</title><body>ok</body>")
  def log_message(self,*a):pass
srv=HTTPServer(("127.0.0.1",SRVPORT),H)
threading.Thread(target=srv.serve_forever,daemon=True).start()
PAGE=f"http://127.0.0.1:{SRVPORT}/"
p=subprocess.Popen([BIN,"--headless=new","--no-sandbox","--disable-gpu",
  f"--remote-debugging-port={PORT}",f"--user-data-dir={PROF}",PAGE],
  stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def wsconn(ws):
  u=urlparse(ws);s=socket.create_connection((u.hostname,u.port))
  k=base64.b64encode(os.urandom(16)).decode()
  s.send((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {k}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
  s.recv(4096);return s
def send(s,o):
  d=json.dumps(o).encode()
  h=struct.pack("!BB",0x81,0x80|len(d)) if len(d)<126 else struct.pack("!BBH",0x81,0x80|126,len(d))
  m=os.urandom(4);s.send(h+m+bytes(b^m[i%4] for i,b in enumerate(d)))
def recv(s):
  b=s.recv(2);ln=b[1]&0x7f
  if ln==126:ln=struct.unpack("!H",s.recv(2))[0]
  elif ln==127:ln=struct.unpack("!Q",s.recv(8))[0]
  buf=b""
  while len(buf)<ln:buf+=s.recv(ln-len(buf))
  return json.loads(buf)
EXPR=r'''(async()=>{
  async function probe(ks){
    const cfg=[{initDataTypes:['cenc','keyids','webm'],
      videoCapabilities:[{contentType:'video/webm; codecs="vp9"'}],
      audioCapabilities:[{contentType:'audio/webm; codecs="opus"'}]}];
    try{ const acc=await navigator.requestMediaKeySystemAccess(ks,cfg);
      try{ await acc.createMediaKeys(); return 'CDM-LOADED'; }
      catch(e){ return 'support-only('+e.name+')'; } }
    catch(e){ return 'unsupported('+e.name+')'; }
  }
  return JSON.stringify({loc:location.href,sec:window.isSecureContext,
    hasEME:(typeof navigator.requestMediaKeySystemAccess),
    widevine:await probe('com.widevine.alpha'),clearkey:await probe('org.w3.clearkey'),
    h264:(document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')||'no')});
})()'''
try:
  ws=None
  for _ in range(60):
    try:
      d=json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json",timeout=2))
      for t in d:
        if t.get("type")=="page" and t.get("webSocketDebuggerUrl"):ws=t["webSocketDebuggerUrl"];break
      if ws:break
    except Exception:pass
    time.sleep(0.5)
  if not ws:print("NO_WS");raise SystemExit
  s=wsconn(ws)
  send(s,{"id":10,"method":"Page.enable"})
  send(s,{"id":11,"method":"Page.navigate","params":{"url":PAGE}})  # force the connected target onto the secure origin
  time.sleep(3.5)
  send(s,{"id":1,"method":"Runtime.evaluate","params":{"expression":EXPR,"awaitPromise":True,"returnByValue":True}})
  for _ in range(80):
    m=recv(s)
    if m.get("id")==1:print("WIDEVINE-VERIFY:",m["result"]["result"].get("value"));break
finally:
  p.send_signal(signal.SIGTERM)
