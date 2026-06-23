// stream.js — Holo Stream: OBS Studio, hologram-native. The page logic for stream.html.
//
// Drives the _shared/holo-obs.js engine (OBS Scene→Source→Mixer→Record→Stream) entirely on
// browser standards + the platform's existing engines: getDisplayMedia/getUserMedia sources,
// a canvas compositor program output, a Web Audio mixer, MediaRecorder → a content-addressed
// κ clip in the OPFS κ-store, and OBS's two egress paths — the serverless WebRTC mesh
// (HoloRTC → a holo://κ room, reusing Hologram Meet's engine) and WHIP.
//
// Self-contained (injects its own CSS, owns its κ-store). Exposes window.HoloStreamUI (mount /
// watch) + window.holoStream (the live handle, for witnesses + the chrome bar).

(function () {
  "use strict";
  const W = window;
  if (W.HoloStreamUI) return;
  const S = W.HoloStudio;                       // the engine (../../_shared/holo-obs.js)
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const short = (k) => { const [a, h] = String(k || "").split(":"); return h ? a + ":" + h.slice(0, 10) + "…" : (k || ""); };
  const DEFAULT_BROKER = "wss://broker.emqx.io:8084/mqtt";   // same content-blind rendezvous as Hologram Meet

  const CSS = `
  #holo-stream{position:absolute;inset:0;display:flex;flex-direction:column;background:#070b10;
    font:13px ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#d4d4d4}
  #holo-stream .main{flex:1 1 auto;min-height:0;display:flex}
  #holo-stream .rail{flex:0 0 252px;display:flex;flex-direction:column;border-right:1px solid #161c24;background:#0b0f15;overflow:auto}
  #holo-stream .rail h4{margin:0;padding:12px 13px 7px;font:600 11px ui-sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#6e7681;display:flex;align-items:center;gap:8px}
  #holo-stream .rail h4 .sp{margin-left:auto}
  #holo-stream .addbtn{font:12px ui-sans-serif;color:#04121f;background:#2dd4bf;border:0;border-radius:6px;padding:3px 10px;cursor:pointer;font-weight:600}
  #holo-stream .addmenu{display:none;flex-direction:column;margin:0 8px 6px;border:1px solid #20262e;border-radius:8px;overflow:hidden;background:#0d1117}
  #holo-stream .addmenu.on{display:flex}
  #holo-stream .addmenu button{text-align:left;background:transparent;border:0;color:#c9d1d9;padding:9px 12px;cursor:pointer;font:12px ui-sans-serif;display:flex;gap:9px;align-items:center}
  #holo-stream .addmenu button:hover{background:#11342f;color:#7defc9}
  #holo-stream .srcs{list-style:none;margin:0;padding:0 8px 8px;display:flex;flex-direction:column;gap:5px}
  #holo-stream .src{display:flex;align-items:center;gap:7px;padding:7px 8px;border:1px solid #1b2330;border-radius:8px;background:#0d1117}
  #holo-stream .src.hidden-src{opacity:.45}
  #holo-stream .src .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #holo-stream .src .kd{color:#6e7681;font:10px ui-monospace,monospace}
  #holo-stream .src button{background:transparent;border:0;color:#8b949e;cursor:pointer;padding:2px;border-radius:5px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center}
  #holo-stream .src button:hover{color:#fff;background:#1b2330}
  #holo-stream .src button.x:hover{color:#fca5a5}
  #holo-stream .layouts{display:flex;gap:5px;padding:0 10px 12px;flex-wrap:wrap}
  #holo-stream .layouts button{flex:1;min-width:54px;background:#0d1117;border:1px solid #20262e;color:#8b949e;border-radius:7px;padding:6px 0;cursor:pointer;font:11px ui-sans-serif}
  #holo-stream .layouts button.on{background:#11342f;border-color:#2dd4bf;color:#2dd4bf}
  #holo-stream .stage{flex:1 1 auto;min-width:0;display:flex;align-items:center;justify-content:center;position:relative;background:radial-gradient(120% 120% at 50% 20%,#0b1016,#05070a 72%);padding:16px}
  #holo-stream video.program{max-width:100%;max-height:100%;width:auto;background:#000;border:1px solid #1b2330;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);aspect-ratio:16/9}
  #holo-stream .badge{position:absolute;top:24px;left:24px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:80%}
  #holo-stream .chip{display:inline-flex;align-items:center;gap:6px;background:#0d1117cc;border:1px solid #28323d;border-radius:999px;padding:4px 11px;font:11px ui-monospace,monospace;color:#9fb0bd}
  #holo-stream .chip .dot{width:8px;height:8px;border-radius:50%;background:#6e7681}
  #holo-stream .chip.rec .dot{background:#f85149;animation:hstr-pulse 1.2s infinite}
  #holo-stream .chip.live .dot{background:#3fb950;animation:hstr-pulse 1.2s infinite}
  @keyframes hstr-pulse{50%{opacity:.35}}
  #holo-stream .empty{position:absolute;color:#3a4452;font:600 14px ui-sans-serif;text-align:center;max-width:380px;line-height:1.5}
  #holo-stream .ctrl{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 13px;border-top:1px solid #161c24;background:#0b0f15;flex-wrap:wrap}
  #holo-stream .ctrl label{color:#6e7681}
  #holo-stream .ctrl select{font:12px ui-sans-serif;color:#c9d1d9;background:#0d1117;border:1px solid #20262e;border-radius:6px;padding:5px 7px;cursor:pointer}
  #holo-stream .ctrl .sp{margin-left:auto}
  #holo-stream .ctrl button{font:12px ui-sans-serif;color:#c9d1d9;background:#161b22;border:1px solid #28323d;border-radius:7px;padding:7px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
  #holo-stream .ctrl button:hover{border-color:#3a4452;color:#fff}
  #holo-stream .ctrl button.rec{border-color:#5c2222;color:#fca5a5}
  #holo-stream .ctrl button.rec.on{background:#f85149;border-color:#f85149;color:#fff}
  #holo-stream .ctrl button.live{border-color:#1d4427;color:#7ee787}
  #holo-stream .ctrl button.live.on{background:#238636;border-color:#238636;color:#fff}
  #holo-stream .ctrl .time{font:12px ui-monospace,monospace;color:#8b949e;min-width:46px}
  #holo-stream .mix{padding:2px 10px 14px;display:flex;flex-direction:column;gap:7px}
  #holo-stream .mix .m{display:flex;align-items:center;gap:7px;font:11px ui-sans-serif;color:#8b949e}
  #holo-stream .mix .m input[type=range]{flex:1;accent-color:#2dd4bf}
  @media (max-width:680px){ #holo-stream .main{flex-direction:column} #holo-stream .rail{flex-basis:auto;max-height:44%} }`;

  const ICON = { display: "🖵", window: "🗔", holospace: "◫", camera: "📷", mic: "🎙" };
  const glyph = (k) => ICON[k] || "●";

  let studio = null, root = null, timer = null, addOpen = false, viewMesh = null, watching = false;
  const $id = (id) => document.getElementById(id);
  function setBar(part, text, cls) { const e = $id(part); if (!e) return; if (text != null) e.textContent = text; if (cls != null) e.className = cls; }

  function injectCSS() { if (document.getElementById("holo-stream-css")) return; const s = el("style"); s.id = "holo-stream-css"; s.textContent = CSS; document.head.appendChild(s); }

  function mount(container) {
    injectCSS();
    if (!S) { container.innerHTML = '<div style="padding:24px;color:#fca5a5">Holo Stream engine (../../_shared/holo-obs.js) not loaded.</div>'; return; }
    root = el("div"); root.id = "holo-stream";
    root.innerHTML = `
      <div class="main">
        <div class="rail">
          <h4>Sources <span class="sp"></span><button class="addbtn" id="hsAdd">+ Add</button></h4>
          <div class="addmenu" id="hsAddMenu">
            <button data-k="display">🖵 Display Capture</button>
            <button data-k="holospace">◫ Holospace (this tab)</button>
            <button data-k="camera">📷 Video Capture Device</button>
            <button data-k="mic">🎙 Audio Input Capture</button>
          </div>
          <ul class="srcs" id="hsSrcs"></ul>
          <h4>Layout</h4>
          <div class="layouts" id="hsLayouts"></div>
          <h4>Audio Mixer</h4>
          <div class="mix" id="hsMix"></div>
        </div>
        <div class="stage">
          <div class="badge" id="hsBadge"></div>
          <video class="program" id="hsProgram" autoplay muted playsinline></video>
          <div class="empty" id="hsEmpty">Add a source — a Display, this Holospace, your Camera or Mic — then Record or Go&nbsp;Live. Every recording is content-addressed (holo://κ); a live room is a serverless holo://κ.</div>
        </div>
      </div>
      <div class="ctrl">
        <label>Base</label>
        <select id="hsBase"><option value="1080p">1080p</option><option value="720p" selected>720p</option><option value="480p">480p</option></select>
        <select id="hsFps"><option value="60">60 fps</option><option value="30" selected>30 fps</option><option value="24">24 fps</option></select>
        <button class="rec" id="hsRec">● Record</button>
        <span class="time" id="hsTime">0:00</span>
        <span class="sp"></span>
        <button class="live" id="hsLive">◉ Go Live</button>
        <button class="live" id="hsChannel" title="Go live as a public Owncast channel with a creator coin — viewers watch, chat & trade your coin; every trade pays you">📡 Channel</button>
        <button id="hsWhip" title="Stream to a WHIP ingest (OBS's WebRTC output protocol)">WHIP…</button>
      </div>`;
    container.appendChild(root);
    studio = S.create({ base: "720p", fps: 30, layout: "pip", on: onEvent });
    wire(); renderLayouts(); renderSources();
    W.holoStream.ready = true;
    try { parent !== window && parent.postMessage({ type: "holo-stream-ready" }, "*"); } catch {}
  }

  function startProgram() { try { const ps = studio.start(); const v = $id("hsProgram"); v.srcObject = ps; v.play().catch(() => {}); } catch (e) { toast("compositor: " + (e.message || e)); } }
  function restartProgram() { if (studio.running) { try { studio.stop(); } catch {} } startProgram(); renderSources(); }

  function wire() {
    const add = $id("hsAdd"), menu = $id("hsAddMenu");
    add.onclick = () => { addOpen = !addOpen; menu.classList.toggle("on", addOpen); };
    menu.querySelectorAll("button").forEach((b) => b.onclick = async () => { addOpen = false; menu.classList.remove("on"); await addSource(b.dataset.k); });
    $id("hsBase").onchange = (e) => { studio.base = e.target.value; restartProgram(); };
    $id("hsFps").onchange = (e) => { studio.fps = +e.target.value; restartProgram(); };
    $id("hsRec").onclick = toggleRecord;
    $id("hsLive").onclick = toggleLive;
    $id("hsChannel").onclick = toggleChannel;
    $id("hsWhip").onclick = goWhip;
  }

  // ── Go Live as Channel (Owncast) — segment the program into a content-addressed LL-HLS
  //    stream, launch a pump.fun-style creator coin, and broadcast on a channel bus. Viewers
  //    open channel.html?c=<id> to watch + chat + trade the coin; every trade pays the streamer.
  let channel = null;
  async function toggleChannel() {
    const btn = $id("hsChannel");
    if (channel) { stopChannel(); btn.classList.remove("on"); btn.textContent = "📡 Channel"; setBadge(); setBar("stat", ""); return; }
    if (!studio.scene.sources.length) return toast("add a source first");
    const O = W.HoloOwncast, Pp = W.HoloPump;
    if (!O || !Pp) return toast("channel engine not loaded");
    try {
      if (!studio.running) startProgram();
      const kp = await Pp.keypair();
      const id = (await O.kappa(new TextEncoder().encode(kp.address + ":" + Date.now()))).split(":")[1].slice(0, 40);
      const bus = new BroadcastChannel("holo-channel:" + id);
      const coin = await Pp.createCoin({ name: "Stream Coin", ticker: "STREAM", creator: kp.address, channel: id });
      const seg = new O.Segmenter({ segmentMs: 2000, maxSegments: 8 });
      channel = { id, bus, kp, coin, seg, init: null, segments: [], title: "Live on Holo Stream", name: "Holo Stream" };
      seg.onSegment = (s) => {
        const msg = { t: "seg", kind: s.kind, kappa: s.kappa, mime: seg.mime, seq: s.seq, buf: s.bytes.buffer.slice(0) };
        if (s.kind === "init") channel.init = { kappa: s.kappa, bytes: s.bytes };
        else { channel.segments.push({ kappa: s.kappa, bytes: s.bytes, seq: s.seq }); while (channel.segments.length > 8) channel.segments.shift(); }
        try { bus.postMessage(msg, [msg.buf]); } catch { bus.postMessage(msg); }
      };
      bus.onmessage = async (e) => {
        const m = e.data; if (!m || !m.t) return;
        if (m.t === "hello") catchup();
        else if (m.t === "trade") { if (await coin.add(m.ev)) renderChannel(); }
        else if (m.t === "presence") { channel._viewers = channel._viewers || new Map(); channel._viewers.set(m.id, Date.now()); renderChannel(); }
      };
      function catchup() {
        bus.postMessage({ t: "coin", meta: coin.meta });
        bus.postMessage({ t: "status", online: true, title: channel.title, name: channel.name, coin: coin.meta });
        if (channel.init) { const b = channel.init.bytes; bus.postMessage({ t: "seg", kind: "init", kappa: channel.init.kappa, mime: seg.mime, buf: b.buffer.slice(0) }); }
        for (const s of channel.segments) bus.postMessage({ t: "seg", kind: "media", kappa: s.kappa, mime: seg.mime, seq: s.seq, buf: s.bytes.buffer.slice(0) });
      }
      channel.catchup = catchup;
      seg.start(studio.programStream);
      channel.statusT = setInterval(() => bus.postMessage({ t: "status", online: true, title: channel.title, name: channel.name, coin: coin.meta }), 3000);
      btn.classList.add("on"); btn.textContent = "■ End Channel"; setBadge("live");
      const link = location.origin + location.pathname.replace(/stream\.html$/, "channel.html") + "?c=" + id;
      channel.link = link; W.holoStream.channel = channel;
      try { await navigator.clipboard.writeText(link); } catch {}
      renderChannel();
      toast("● LIVE channel + $STREAM coin launched — watch/trade link copied (every trade pays you)");
    } catch (e) { toast("channel failed: " + (e.message || e)); channel = null; }
  }
  function renderChannel() {
    if (!channel) return;
    const now = Date.now(); let v = 0; if (channel._viewers) for (const [, t] of channel._viewers) if (now - t < 9000) v++;
    setBar("stat", "📡 LIVE · 👁 " + v + " · earned ◎" + channel.coin.creatorEarnings.toFixed(4) + " · $" + channel.coin.meta.ticker + " mcap ◎" + Math.round(channel.coin.marketCap()).toLocaleString());
  }
  function stopChannel() { if (!channel) return; try { channel.seg.stop(); } catch {} clearInterval(channel.statusT); try { channel.bus.postMessage({ t: "status", online: false }); channel.bus.close(); } catch {} channel = null; }

  async function addSource(kind) {
    try {
      if (!studio.running) startProgram();
      await studio.addSource(kind, {});
      $id("hsEmpty").style.display = "none";
      renderSources(); setBar("stat", studio.scene.sources.length + " source(s)"); toast(kind + " added");
    } catch (e) { if (e && e.name === "NotAllowedError") return; toast("could not add " + kind + ": " + (e.message || e)); }
  }

  function renderLayouts() {
    const wrap = $id("hsLayouts"); wrap.innerHTML = "";
    for (const name of Object.keys(S.LAYOUTS)) { const b = el("button", studio.layout === name ? "on" : "", name === "pip" ? "PiP" : name[0].toUpperCase() + name.slice(1)); b.onclick = () => { studio.setLayout(name); renderLayouts(); }; wrap.appendChild(b); }
  }
  function renderSources() {
    const list = $id("hsSrcs"); if (!list) return; list.innerHTML = "";
    for (const s of studio.scene.sources) {
      const li = el("li", "src" + (s.visible === false ? " hidden-src" : ""));
      li.innerHTML = `<span>${glyph(s.kind)}</span><span class="nm" title="${s.name}">${s.name}</span><span class="kd">${s.kind}</span>`;
      const eye = el("button", "", s.visible === false ? "🚫" : "👁"); eye.title = "show/hide"; eye.onclick = () => { studio.setVisible(s.id, s.visible === false); renderSources(); };
      const up = el("button", "", "↑"); up.title = "bring forward"; up.onclick = () => { studio.raise(s.id, -1); renderSources(); };
      const x = el("button", "x", "✕"); x.title = "remove"; x.onclick = () => { studio.removeSource(s.id); renderSources(); };
      li.append(eye, up, x); list.appendChild(li);
    }
    renderMixer();
  }
  function renderMixer() {
    const mix = $id("hsMix"); if (!mix) return; mix.innerHTML = "";
    const audio = studio.scene.sources.filter((s) => s.stream && s.stream.getAudioTracks && s.stream.getAudioTracks().length);
    if (!audio.length) { mix.innerHTML = '<div style="color:#3a4452;font-size:11px">no audio sources</div>'; return; }
    for (const s of audio) {
      const row = el("div", "m");
      const mute = el("button", "", s.muted ? "🔇" : "🔊"); mute.style.cssText = "background:transparent;border:0;color:#8b949e;cursor:pointer";
      mute.onclick = () => { studio.setMuted(s.id, !s.muted); renderMixer(); };
      const rng = el("input"); rng.type = "range"; rng.min = 0; rng.max = 150; rng.value = Math.round((s.gain || 1) * 100); rng.oninput = (e) => studio.setGain(s.id, e.target.value / 100);
      const lbl = el("span"); lbl.textContent = s.name; lbl.style.cssText = "flex:0 0 64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      row.append(mute, lbl, rng); mix.appendChild(row);
    }
  }

  // ── record → content-addressed κ clip in the OPFS κ-store (Law 3/5) ─────────────────
  async function storeDir() { const r = await navigator.storage.getDirectory(); return r.getDirectoryHandle("holo-stream", { create: true }); }
  async function putInStore(kappa, bytes, ext) {
    try { const dir = await storeDir(); const name = kappa.replace(":", "_") + "." + ext;
      const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(bytes); await w.close();
      let lib = []; try { const lf = await (await dir.getFileHandle("library.json")).getFile(); lib = JSON.parse(await lf.text()); } catch {}
      if (!lib.some((e) => e.kappa === kappa)) { lib.unshift({ kappa, name, size: bytes.length, at: Date.now() }); const lw = await (await dir.getFileHandle("library.json", { create: true })).createWritable(); await lw.write(JSON.stringify(lib)); await lw.close(); }
    } catch {}
  }
  async function verifyStore(kappa, ext) { try { const dir = await storeDir(); const f = await (await dir.getFileHandle(kappa.replace(":", "_") + "." + ext)).getFile(); return (await S.kappa(new Uint8Array(await f.arrayBuffer()))) === kappa; } catch { return null; } }

  async function toggleRecord() {
    const btn = $id("hsRec");
    if (!studio.recording) {
      if (!studio.scene.sources.length) return toast("add a source first");
      studio.record(); btn.classList.add("on"); btn.textContent = "■ Stop"; startTimer();
    } else {
      stopTimer(); btn.classList.remove("on"); btn.textContent = "● Record";
      const out = await studio.stopRecord(); if (!out) return;
      const ext = out.mime.includes("mp4") ? "mp4" : "webm";
      await putInStore(out.kappa, out.bytes, ext);
      setBar("kaddr", "holo://" + out.kappa); setBar("ver", "✓ κ verified", "ver ok"); if (W.HoloTeleport) HoloTeleport.stamp(out.kappa);
      downloadBlob(out.blob, "holo-stream-" + out.kappa.split(":")[1].slice(0, 12) + "." + ext);
      W.holoStream.lastRecording = out;
      toast("recorded · " + Math.round(out.duration) + "s · κ-store + download · holo://" + short(out.kappa));
    }
  }

  // ── go live over the serverless mesh (HoloRTC) → a holo://κ room link ───────────────
  async function toggleLive() {
    const btn = $id("hsLive");
    if (studio.live.mesh) { studio.stopLiveMesh(); btn.classList.remove("on"); btn.textContent = "◉ Go Live"; setBadge(); setBar("stat", ""); return; }
    if (!studio.scene.sources.length) return toast("add a source first");
    try {
      const { BrokerKappaSync } = await import("./holo-broker-sync.mjs");
      const sync = new BrokerKappaSync(DEFAULT_BROKER); try { await sync.ready; } catch {}
      const _sb = new Uint8Array(24); crypto.getRandomValues(_sb);   // CSPRNG room secret — never Math.random (unforgeable capability)
      const secret = Array.from(_sb, (b) => b.toString(16).padStart(2, "0")).join("");
      await studio.goLiveMesh({ secret, sync, name: "Holo Stream", quality: "auto" });
      btn.classList.add("on"); btn.textContent = "■ Stop Live"; setBadge("live");
      const link = location.origin + location.pathname + "?watch=1#k=" + secret + "&r=" + encodeURIComponent(DEFAULT_BROKER);
      W.holoStream.watchLink = link; setBar("kaddr", "holo://" + short("sha256:" + secret)); setBar("stat", "● LIVE — watch link copied");
      try { await navigator.clipboard.writeText(link); } catch {}
      toast("● LIVE over the serverless mesh — watch link copied (holo://room)");
    } catch (e) { toast("go live failed: " + (e.message || e)); }
  }

  async function goWhip() {
    const endpoint = prompt("WHIP ingest URL (OBS WebRTC output — e.g. https://…/whip):"); if (!endpoint) return;
    const token = (prompt("Bearer token (optional):") || "").trim();
    try { if (!studio.scene.sources.length) return toast("add a source first"); await studio.goLiveWhip(endpoint.trim(), token); setBadge("live"); setBar("stat", "● LIVE via WHIP"); toast("● LIVE via WHIP → " + endpoint); }
    catch (e) { toast("WHIP failed: " + (e.message || e)); }
  }

  // ── viewer mode: join a room and render the live program (2-peer round-trip) ────────
  async function watch(secret, relay) {
    injectCSS(); watching = true;
    if (!root) mount(document.getElementById("stage") || document.body);
    try {
      const { BrokerKappaSync } = await import("./holo-broker-sync.mjs");
      const mod = await import("./holo-kappa-sync.mjs").catch(() => ({}));
      const sync = (relay && relay.startsWith("ws") && mod.WsKappaSync) ? new mod.WsKappaSync(relay) : new BrokerKappaSync(relay || DEFAULT_BROKER);
      try { await sync.ready; } catch {}
      const v = $id("hsProgram");
      viewMesh = await W.HoloRTC.join({ secret, sync, name: "Viewer", audio: false, video: false, ontrack: (peer, stream) => { if (v) { v.srcObject = stream; v.muted = false; v.play().catch(() => {}); $id("hsEmpty").style.display = "none"; } } });
      setBadge("live"); setBar("stat", "watching live"); toast("watching live room");
    } catch (e) { toast("watch failed: " + (e.message || e)); }
  }

  // ── badges + timer ──────────────────────────────────────────────────────────────────
  function setBadge(state) {
    const b = $id("hsBadge"); if (!b) return; b.innerHTML = "";
    if (studio && studio.recording) b.appendChild(chip("rec", "REC"));
    if (state === "live" || (studio && (studio.live.mesh || studio.live.whip)) || viewMesh || channel) b.appendChild(chip("live", "LIVE"));
  }
  function chip(cls, text) { const c = el("span", "chip " + cls); c.innerHTML = `<span class="dot"></span>${text}`; return c; }
  function startTimer() { const t0 = Date.now(); setBadge(); setBar("ver", "", "ver"); timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $id("hsTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }, 500); }
  function stopTimer() { clearInterval(timer); timer = null; setBadge(); }

  function onEvent(ev) { if (ev === "sources") renderSources(); if (ev === "live") setBadge("live"); if (ev === "record") setBadge(); }
  function downloadBlob(blob, name) { const a = el("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  function toast(m) { try { W.HoloTeleport && W.HoloTeleport.toast ? W.HoloTeleport.toast(m) : console.log("[stream]", m); } catch { console.log("[stream]", m); } }

  W.holoStream = { get studio() { return studio; }, mount, watch, verifyStore, putInStore, lastRecording: null, watchLink: "", ready: false };
  W.HoloStreamUI = { mount, watch, get studio() { return studio; } };
})();
