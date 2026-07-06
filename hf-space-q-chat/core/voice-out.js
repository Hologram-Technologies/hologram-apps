// core/voice-out.js — Q's beautiful voice: Kokoro-82M neural TTS, on-device and serverless. The text is
// synthesized ENTIRELY in the browser; only the model WEIGHTS stream from HuggingFace on first use, then
// cache offline. kokoro.js imports "@huggingface/transformers" + "phonemizer" as bare specifiers; the page's
// import map points them at the vendored copies (no CDN, no server).
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "../vendor/kokoro/kokoro.js";

let _tts = null, _loading = null, _ctx = null, _cur = null, _queue = [], _draining = false;

export function ready() { return !!_tts; }
export function engine() { return _tts ? "kokoro-wasm" : null; }   // the LIVE neural engine (null = not loaded → caller uses the OS voice)

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
    // WASM + q8: warm, natural, ~86 MB (cached after first use), and avoids the ORT-WebGPU TTS kernel issue.
    _tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "wasm", progress_callback: onProgress });
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
