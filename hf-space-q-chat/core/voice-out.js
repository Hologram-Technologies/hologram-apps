// core/voice-out.js — Q's beautiful voice: Kokoro-82M neural TTS, on-device and serverless. The text is
// synthesized ENTIRELY in the browser; only the model WEIGHTS stream from HuggingFace on first use, then
// cache offline. kokoro.js imports "@huggingface/transformers" + "phonemizer" as bare specifiers; the page's
// import map points them at the vendored copies (no CDN, no server).
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "../vendor/kokoro/kokoro.js";

let _tts = null, _loading = null, _ctx = null, _cur = null, _queue = [], _draining = false, _engine = null;
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export function ready() { return !!_tts; }
export function engine() { return _tts ? _engine : null; }   // LIVE engine: "kokoro-webgpu" | "kokoro-wasm" (null = not loaded)

// Probe a loaded engine: synthesize a tiny phrase, confirm the audio is REAL (not silent/NaN — this catches the
// historical ORT-WebGPU TTS kernel bug), and measure synth time. Returns { ok, ms }.
async function _probe(tts) {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();
  const out = await tts.generate("Hello there.", { voice: "af_heart" });
  const ms = now() - t0;
  const a = out && out.audio; if (!a || !a.length) return { ok: false, ms };
  let peak = 0; for (let i = 0; i < a.length; i += 137) { const v = a[i]; if (!Number.isFinite(v)) return { ok: false, ms }; const av = v < 0 ? -v : v; if (av > peak) peak = av; }
  return { ok: peak > 0.005, ms };
}

// Load Kokoro once. Runtime is vendored; only the model streams from HF.
export async function loadVoice(onProgress) {
  if (_tts) return _tts;
  if (_loading) return _loading;
  _loading = (async () => {
    env.allowRemoteModels = true;    // weights stream from HuggingFace…
    env.allowLocalModels = false;    // …not from disk
    try {
      const wasm = new URL("../vendor/kokoro/transformers/", import.meta.url).href;   // vendored ORT wasm, no CDN
      // RELIABILITY (the "robotic on Brave" fix): the vendored ORT wasm is the THREADED build, which needs
      // SharedArrayBuffer / cross-origin isolation. Brave Shields (and some setups) disable that → the threaded
      // path fails → Q silently drops to the robotic OS voice. So when isolation is ABSENT, run ORT single-thread
      // on the main thread (no worker, no SAB) — slower to synthesize, but it's still the NEURAL Kokoro voice.
      const isolated = (typeof self !== "undefined" && self.crossOriginIsolated) && (typeof SharedArrayBuffer !== "undefined");
      if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = wasm;
        env.backends.onnx.wasm.numThreads = isolated ? Math.min(4, (navigator.hardwareConcurrency || 2)) : 1;
        env.backends.onnx.wasm.proxy = isolated;   // worker only when isolated; no-SAB → main thread (max compatibility)
      }
    } catch {}
    const force = (() => { try { return (new URLSearchParams(location.search).get("voice") || "").toLowerCase(); } catch { return ""; } })();   // ?voice=webgpu to opt into the (currently broken) ORT WebGPU path
    // WASM q8 is the DEFAULT (fast to load, reliable, natural). transformers.js's WebGPU Kokoro path currently
    // TIMES OUT on real hardware (ORT-WebGPU TTS kernel issue — measured on Strix Halo 2026-07-06), so it's
    // OPT-IN only (?voice=webgpu) until the κ-native WGSL Kokoro forge lands. The probe + 45s guard keep even the
    // opt-in path from ever hanging the voice.
    if (force === "webgpu" && typeof navigator !== "undefined" && navigator.gpu) {
      // Guard with a timeout: a broken/software GPU can make the load or probe HANG — never let that block the
      // reliable WASM fallback (and thus the voice). 45s covers a real fp16 download + probe; a real GPU is <5s.
      const attempt = (async () => { const g = await KokoroTTS.from_pretrained(MODEL, { dtype: "fp16", device: "webgpu", progress_callback: onProgress }); return { g, p: await _probe(g) }; })();
      const r = await Promise.race([attempt.catch((e) => ({ err: e })), new Promise((res) => setTimeout(() => res({ timeout: true }), 45000))]);
      if (r && r.g && r.p && r.p.ok) { _tts = r.g; _engine = "kokoro-webgpu"; try { console.info(`[Q voice] Kokoro WebGPU ✓ (${Math.round(r.p.ms)}ms/clause)`); } catch {} return _tts; }
      try { console.info(`[Q voice] WebGPU unavailable (${r && r.timeout ? "timeout" : r && r.err ? (r.err.message || r.err) : "bad audio"}) → WASM`); } catch {}
    }
    // Reliable fallback: WASM + q8 (~86 MB, cached), single-thread where there's no SAB (Brave).
    _tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm", progress_callback: onProgress });
    _engine = "kokoro-wasm";
    try { console.info("[Q voice] Kokoro engine: wasm (q8)"); } catch {}
    return _tts;
  })().catch((e) => { _loading = null; throw e; });
  return _loading;
}

function ctx() { if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)(); return _ctx; }

// GAPLESS QUEUE: synthesize each clause and play them back-to-back on ONE AudioContext — no gaps, no overlap.
// This is what makes clause-STREAMING smooth: index.html enqueues each sentence the moment it's generated, so
// Q starts talking almost immediately while the rest of the reply is still being written + synthesized.
async function _play(text) {
  const tts = await loadVoice();
  const out = await tts.generate(String(text), { voice: "af_heart" });
  const c = ctx(); if (c.state === "suspended") { try { await c.resume(); } catch {} }
  const buf = c.createBuffer(1, out.audio.length, out.sampling_rate || 24000); buf.getChannelData(0).set(out.audio);
  const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination); _cur = s;
  await new Promise((res) => { s.onended = () => { if (_cur === s) _cur = null; res(); }; s.start(); });
}
async function _drain() {
  if (_draining) return; _draining = true;
  try { while (_queue.length) { const t = _queue.shift(); try { await _play(t); } catch {} } } finally { _draining = false; }
}
// enqueue(text) — add one clause to the voice queue; it plays as soon as it's synthesized.
export function enqueue(text) { const t = String(text || "").trim(); if (!t) return; _queue.push(t); _drain(); }
export function speak(text) { enqueue(text); }   // one-shot = a queue of one (greeting / demo)
export function speaking() { return _draining || _queue.length > 0 || !!_cur; }
// Barge-in / mute: clear the queue and cut playback immediately.
export function stop() { _queue.length = 0; try { if (_cur) { _cur.onended = null; _cur.stop(); _cur = null; } } catch {} }
