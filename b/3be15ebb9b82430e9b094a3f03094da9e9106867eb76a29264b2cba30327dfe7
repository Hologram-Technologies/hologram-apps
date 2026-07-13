// core/voice-out.js — THE canonical Q voice (shared by apps/q, the messenger, and any Q surface). Speaks Q's
// answers on-device with Kokoro-82M and drives the orb's speaking swell from Q's REAL amplitude.
//
// Enhanced over the original singleton: sentence-CHUNKED low-latency synthesis (Q starts talking after the FIRST
// sentence, pipelining synth with playback), an AnalyserNode that broadcasts `holo-q-state {mode:'speaking',
// level}` so ANY orb pulses to Q's voice, a speechSynthesis FLOOR (Q never goes mute), and DUAL loading so it
// works everywhere: fully-local vendored TTS (/usr/lib/holo/voice — no HF, no import map) with the original
// kokoro-js path (/_shared + HF weights) as a fallback. Kokoro loading is DYNAMIC so a missing import map can
// never break this module's load. Original preserved as voice-out.js.pre-converge.bak.
//
// Two APIs, one engine:
//   createVoice({onLevel}) → { speak, stop, warmHD, attachHD, hasHD, speaking }   — rich (messenger orb wiring)
//   ready() · loadVoice(onProgress) · speak(text[,voice]) · stop() · engine()      — backward-compat singleton
//                                                                                     (apps/q q-chat.html etc.)

// HQ-ONLY LAW (operator, 2026-07-13): Q speaks in its beautiful neural voice or it HOLDS — the robotic
// speechSynthesis floor is opt-in only (?osvoice=1, accessibility). A held utterance is parked (latest wins)
// and spoken the instant the HD voice warms, so the first thing you ever hear from Q is already gorgeous.
const _OS_FLOOR = (() => { try { return /[?&]osvoice=1/.test(location.search); } catch (e) { return false; } })();

export function createVoice(opts = {}) {
  const onLevel = typeof opts.onLevel === "function" ? opts.onLevel : function () {};
  let raf = 0, lvl = 0, tgt = 0, active = false, cur = null, hd = null, ac = null, node = null, curSrc = null, parked = null;

  function pump() {
    if (!active) return;
    lvl += (tgt - lvl) * 0.28; tgt *= 0.90;                 // attack fast, decay smooth → a living pulse
    try { onLevel(Math.max(0, Math.min(1, lvl))); } catch (e) {}
    raf = requestAnimationFrame(pump);
  }
  function begin() { if (active) return; active = true; lvl = 0; tgt = 0; raf = requestAnimationFrame(pump); }
  function finish() { active = false; if (raf) cancelAnimationFrame(raf); raf = 0; try { onLevel(0); } catch (e) {} }

  // play ONE synthesized chunk through Web Audio; an AnalyserNode drives the orb with Q's real amplitude.
  function playBuffer(out) {
    return new Promise((res) => {
      if (!out || !out.audio || !active) { res(false); return; }
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const start = () => {
        const buf = ac.createBuffer(1, out.audio.length, out.sampling_rate || 24000);
        buf.getChannelData(0).set(out.audio);
        const srcN = ac.createBufferSource(); srcN.buffer = buf; curSrc = srcN;
        node = ac.createAnalyser(); node.fftSize = 512; node.smoothingTimeConstant = 0.6;
        const bins = new Uint8Array(node.frequencyBinCount);
        srcN.connect(node); node.connect(ac.destination);
        const meter = () => { if (!active) return; node.getByteFrequencyData(bins); let s = 0; for (let i = 0; i < bins.length; i++) s += bins[i]; tgt = Math.min(1, (s / bins.length) / 90 * 1.6); requestAnimationFrame(meter); };
        requestAnimationFrame(meter);
        let done = false; const finishOne = () => { if (done) return; done = true; if (curSrc === srcN) curSrc = null; res(true); };
        srcN.onended = finishOne;
        const durMs = (out.audio.length / (out.sampling_rate || 24000)) * 1000;
        setTimeout(finishOne, durMs + 500);                 // safety: resolve even if onended never fires → can't hang
        try { srcN.start(); } catch (e) { finishOne(); }
      };
      if (ac.state === "suspended") ac.resume().then(start, start); else start();
    });
  }
  // HD path — LOW LATENCY: split into sentences and PIPELINE synth with playback (synth i+1 while i plays).
  function sentences(text) { return (String(text).match(/[^.!?…]+[.!?…]+(?:["')\]]+)?|[^.!?…]+$/g) || [text]).map((s) => s.trim()).filter(Boolean); }
  async function speakHD(text) {
    const parts = sentences(text); if (!parts.length) return false;
    begin();
    let next = hd.synth(parts[0]);
    let spokeAny = false;
    for (let i = 0; i < parts.length && active; i++) {
      let out; try { out = await next; } catch (e) { if (i === 0 && !spokeAny) { finish(); throw e; } break; }
      next = (i + 1 < parts.length) ? Promise.resolve(hd.synth(parts[i + 1])).catch(() => null) : null;
      if (out && out.audio) { await playBuffer(out); spokeAny = true; }
    }
    finish();
    return spokeAny;
  }

  // Floor: speechSynthesis. The orb pulses on each word boundary → tracks Q's real cadence (never a sine).
  function speakSpeech(text) {
    return new Promise((res) => {
      const synth = typeof window !== "undefined" && window.speechSynthesis;
      if (!synth) { res(false); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.02;
      u.onstart = () => { begin(); tgt = 0.55; };
      u.onboundary = () => { tgt = Math.min(1, tgt + 0.5); };
      u.onend = () => { finish(); cur = null; res(true); };
      u.onerror = () => { finish(); cur = null; res(false); };
      cur = u;
      try { synth.cancel(); synth.speak(u); } catch (e) { finish(); res(false); }
    });
  }

  function stop() {
    active = false;
    try { if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    try { if (curSrc) curSrc.stop(); } catch (e) {} curSrc = null;
    try { if (node) node.disconnect(); } catch (e) {}
    finish(); cur = null;
  }

  async function speak(text) {
    text = String(text || "").trim(); if (!text) return false;
    stop();
    if (hd) { try { return await speakHD(text); } catch (e) { /* HD errored mid-utterance → floor only if opted in */ } }
    if (_OS_FLOOR) return speakSpeech(text);   // accessibility floor, explicit opt-in only
    parked = text; return false;               // HQ-or-hold: spoken beautifully the moment HD warms (latest wins)
  }

  // warm the ON-DEVICE HD voice. Plan A = fully-local vendored createTTS (messenger/OS: no HF, no import map);
  // Plan B = the original kokoro-js path (apps/q: /_shared + HF weights, needs the page import map). DYNAMIC
  // imports throughout so a missing import map never breaks module load. Guarded → any failure leaves the floor.
  let warming = null;
  function warmHD(o) {
    o = o || {};
    if (hd) return Promise.resolve(true);
    if (warming) return warming;
    warming = (async () => {
      const gpu = typeof navigator !== "undefined" && !!navigator.gpu;
      // Plan A — vendored createTTS (holo-voice-tts.mjs), fully local
      try {
        // subpath-robust import: the web deploy serves this module under /Q/… so a ROOT-absolute
        // /usr/…/holo-voice-tts.mjs resolves to a stub — try the root path AND one resolved RELATIVE to this
        // module (…/apps/q/core → /usr/…), so the fully-local GPU-tiered engine is reachable off-root too.
        const _ttsUrls = [o.ttsUrl, "/usr/lib/holo/voice/holo-voice-tts.mjs"].filter(Boolean);
        try { _ttsUrls.push(new URL("../../../usr/lib/holo/voice/holo-voice-tts.mjs", import.meta.url).href); } catch (e) {}
        let mod = null;
        for (const u of _ttsUrls) { try { const m = await import(/* @vite-ignore */ u); if (m && m.createTTS) { mod = m; break; } } catch (e) {} }
        if (mod && mod.createTTS) {
          const plans = gpu ? [{ device: "webgpu", dtype: "fp16", preferWebGPU: true }, { device: "wasm", dtype: "q8" }] : [{ device: "wasm", dtype: "q8" }];
          for (const p of plans) {
            try { const e = mod.createTTS(p); await e.load(o.onProgress); try { await e.synth("Hi."); } catch (e2) {} hd = e; return true; } catch (e2) {}
          }
        }
      } catch (e) {}
      // Plan B — original kokoro-js (needs @huggingface/transformers import map; works in apps/q).
      // RESILIENT IMPORT: the vendored kokoro.js is served by the shell service worker, whose first-hit
      // resolution can race (a cold `import()` 404s with ERR_ABORTED while a warm fetch of the SAME url is
      // 200). So we try a small set of candidate urls — root-absolute (the published location) plus one
      // resolved RELATIVE to this module (covers a /Q subpath deploy) — and RETRY once after a short warm
      // delay. Any failure still falls through to the speechSynthesis floor; this can only add reachability.
      try {
        const _koUrls = ["/_shared/voice/vendor/kokoro/kokoro.js"];   // published location first (live + native host)
        try { _koUrls.push(new URL("../../../_shared/voice/vendor/kokoro/kokoro.js", import.meta.url).href); } catch (e) {}   // subpath co-publish fallback
        const _importKo = async () => { for (const u of _koUrls) { try { const mod = await import(/* @vite-ignore */ u); if (mod && mod.KokoroTTS) return mod; } catch (e) {} } return null; };
        let ko = await _importKo();
        if (!ko) { await new Promise((r) => setTimeout(r, 500)); ko = await _importKo(); }   // warm the SW, retry once
        if (!ko) throw new Error("kokoro.js unresolved");
        // kokoro.js RE-EXPORTS its transformers env — use it directly. The bare "@huggingface/transformers"
        // import-map entry is ROOT-absolute, which is a dead URL on a /Q mount without the root SW (the map
        // was the last root-absolute dependency killing this plan on the live site).
        const tf = ko.env ? ko : await import(/* @vite-ignore */ "@huggingface/transformers");
        const env = tf.env, KokoroTTS = ko.KokoroTTS;
        env.allowRemoteModels = true; env.allowLocalModels = false;
        // EVICTED-TREE LAW (live /Q): do NOT override wasmPaths or set proxy here. ort's proxy worker is a
        // blob worker whose fetches BYPASS the service worker — and the vendored transformers dir is an
        // evicted tree (real network 404s; only SW-rescued page-context fetches reach it). Defaults resolve
        // the wasm relative to transformers.js and fetch it from the PAGE context, where the rescue serves
        // it verified; webgpu carries the heavy math. This exact config is live-proven (fp16 ready in 24s).
        // HIGHER-QUALITY VOICE: on a WebGPU device stream the fp16 weights and synth on the GPU — far warmer
        // and more natural than the q8/wasm floor, and quicker to speak. Fall back to q8/wasm without WebGPU,
        // or if the GPU load fails, so higher quality never costs reliability.
        const _mk = async (dtype, device) => {
          const t = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype, device, progress_callback: o.onProgress });
          return { synth: (text) => t.generate(String(text), { voice: "af_heart" }) };
        };
        try { hd = gpu ? await _mk("fp16", "webgpu") : await _mk("q8", "wasm"); }
        catch (e3) { hd = await _mk("q8", "wasm"); }
        return true;
      } catch (e) {}
      return false;
    })().catch(() => false)
      .then((ok) => { if (ok && parked) { const t = parked; parked = null; speak(t); } return ok; });   // HD just warmed → speak the held utterance
    return warming;
  }

  return { speak, stop, warmHD, attachHD(engine) { hd = engine || null; }, hasHD() { return !!hd; }, get speaking() { return active; } };
}

// ── backward-compatible SINGLETON API (apps/q q-chat.html, make-chat-space.mjs). Progressive enhancement: warms
// Kokoro in the background, floors on speechSynthesis, and broadcasts `holo-q-state` so the orb pulses to Q. ──
let _singleton = null;
function _s() {
  if (_singleton) return _singleton;
  _singleton = createVoice({ onLevel: (level) => { try { (typeof window !== "undefined" ? window : self).dispatchEvent(new CustomEvent("holo-q-state", { detail: { mode: "speaking", level } })); } catch (e) {} } });
  try { _singleton.warmHD(); } catch (e) {}
  return _singleton;
}
export function ready() { return _s().hasHD(); }
export async function loadVoice(onProgress) { return _s().warmHD({ onProgress }); }
export function speak(text, voice) { return _s().speak(text); }   // voice arg accepted for compat (default af_heart)
export function stop() { try { if (_singleton) _singleton.stop(); } catch (e) {} }
export function engine() { return _s().hasHD() ? "kokoro" : "speechSynthesis"; }

export default createVoice;
