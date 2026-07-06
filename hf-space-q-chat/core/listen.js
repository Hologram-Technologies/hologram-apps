// core/listen.js — on-device speech-to-text (Q's ear). The microphone PCM is transcribed ENTIRELY in the
// browser by Whisper-tiny (transformers.js, ORT-WASM) — no audio EVER leaves the device, no server. Only the
// model WEIGHTS stream from HuggingFace on first use, then cache offline. The runtime is vendored.
import { pipeline, AutoModel, Tensor, env } from "../vendor/transformers/transformers.js";

const MODEL = "onnx-community/whisper-tiny";   // ~40 MB q8; streams from HF, runs on-device
let _pipe = null, _loading = null;

// RELIABILITY: the vendored ORT wasm is the THREADED build, which needs SharedArrayBuffer / cross-origin
// isolation. Brave Shields (and some setups) disable that. So when isolation is ABSENT, run ORT single-thread
// on the main thread (no worker, no SAB) so on-device listening still works instead of failing. Threads +
// worker when isolation IS present (fast + smooth).
function _configOrt(env) {
  try {
    const wasm = new URL("../vendor/transformers/", import.meta.url).href;   // vendored ORT wasm — no CDN
    const isolated = (typeof self !== "undefined" && self.crossOriginIsolated) && (typeof SharedArrayBuffer !== "undefined");
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = wasm;
      env.backends.onnx.wasm.numThreads = isolated ? Math.min(4, (navigator.hardwareConcurrency || 2)) : 1;
      env.backends.onnx.wasm.proxy = isolated;
    }
  } catch {}
}

// Load the recognizer once. Runtime is vendored; only the model comes from HF (allowRemoteModels).
export async function loadEar(onProgress) {
  if (_pipe) return _pipe;
  if (_loading) return _loading;
  _loading = (async () => {
    env.allowRemoteModels = true;      // weights stream from HuggingFace…
    env.allowLocalModels = false;      // …not from disk
    _configOrt(env);
    _pipe = await pipeline("automatic-speech-recognition", MODEL, {
      device: "wasm", dtype: "q8",
      progress_callback: (p) => { try { onProgress && onProgress(p); } catch {} },
    });
    return _pipe;
  })().catch((e) => { _loading = null; throw e; });
  return _loading;
}

// Transcribe a Float32Array of mono PCM at 16 kHz → plain text.
export async function transcribe(pcm16k, onProgress) {
  const pipe = await loadEar(onProgress);
  const r = await pipe(pcm16k, { language: "en", task: "transcribe", chunk_length_s: 30 });
  return ((Array.isArray(r) ? r.map((x) => x.text).join(" ") : (r && r.text)) || "").trim();
}

// A press-to-talk capture session: opens the mic at 16 kHz mono (no resample → Whisper's rate).
export function createEar() {
  let ctx = null, stream = null, node = null, src = null, chunks = [], recording = false;
  const available = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  async function start() {
    if (recording) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    src = ctx.createMediaStreamSource(stream); node = ctx.createScriptProcessor(4096, 1, 1);
    chunks = []; recording = true;
    node.onaudioprocess = (e) => { if (recording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    src.connect(node); node.connect(ctx.destination);
  }
  function _teardown() {
    recording = false;
    try { node && node.disconnect(); } catch {} try { src && src.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {} try { ctx && ctx.close(); } catch {}
    node = src = stream = ctx = null;
  }
  function _flat() { let n = 0; for (const c of chunks) n += c.length; const o = new Float32Array(n); let k = 0; for (const c of chunks) { o.set(c, k); k += c.length; } chunks = []; return o; }
  async function stop(onProgress) { if (!recording) return ""; const pcm = _flat(); _teardown(); if (pcm.length < 1600) return ""; return transcribe(pcm, onProgress); }
  function cancel() { chunks = []; _teardown(); }
  return { start, stop, cancel, available, get recording() { return recording; } };
}

// ── HANDS-FREE listening: Silero VAD (MIT, 2 MB) gates so Whisper only runs on real speech. ──
let _vad = null, _vadLoading = null;
export async function loadVAD(onProgress) {
  if (_vad) return _vad;
  if (_vadLoading) return _vadLoading;
  _vadLoading = (async () => {
    env.allowRemoteModels = true; env.allowLocalModels = false;
    _configOrt(env);   // single-thread on the main thread where there's no SAB (Brave Shields) — VAD still runs
    const net = await AutoModel.from_pretrained("onnx-community/silero-vad", { config: { model_type: "custom" }, dtype: "fp32", progress_callback: onProgress });
    const sr = new Tensor("int64", [16000n], []);
    let state = new Tensor("float32", new Float32Array(256), [2, 1, 128]);
    _vad = {
      reset() { state = new Tensor("float32", new Float32Array(256), [2, 1, 128]); },
      async prob(frame512) { const input = new Tensor("float32", frame512, [1, 512]); const out = await net({ input, sr, state }); if (out.stateN) state = out.stateN; const o = out.output && out.output.data; return o && o.length ? o[0] : 0; },
    };
    return _vad;
  })().catch((e) => { _vadLoading = null; throw e; });
  return _vadLoading;
}

function _flatFrames(frames) { let n = 0; for (const f of frames) n += f.length; const o = new Float32Array(n); let k = 0; for (const f of frames) { o.set(f, k); k += f.length; } return o; }

// createHandsFree({ gate, onState, onFinal, onProgress }) — tap once to open; it listens continuously, and each
// time you finish a sentence it transcribes on-device and hands you the text via onFinal(text).
export function createHandsFree(opts = {}) {
  const gate = opts.gate || (() => true), onState = opts.onState || (() => {}), onFinal = opts.onFinal || (() => {}), onProgress = opts.onProgress;
  const FRAME = 512, frameMs = 32;
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  const silenceFrames = Math.round((opts.silenceMs || 700) / frameMs);
  const minSpeechFrames = Math.round((opts.minSpeechMs || 200) / frameMs);
  const prerollMax = opts.prerollFrames || 8;
  let ctx = null, stream = null, node = null, src = null, running = false;
  let queue = [], pumping = false, pending = new Float32Array(0);
  let speaking = false, speechCount = 0, silenceCount = 0, speechBuf = [], preroll = [];
  const available = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  async function pump() {
    if (pumping) return; pumping = true;
    while (running && queue.length) {
      const fr = queue.shift(); let p = 0; try { p = await _vad.prob(fr); } catch { p = 0; }
      const isSpeech = p >= threshold;
      if (!speaking) {
        preroll.push(fr); if (preroll.length > prerollMax) preroll.shift();
        if (isSpeech) { speechCount++; if (speechCount >= 2) { speaking = true; speechBuf = preroll.slice(); preroll = []; silenceCount = 0; onState("speech"); } }
        else speechCount = 0;
      } else {
        speechBuf.push(fr);
        if (isSpeech) silenceCount = 0;
        else if (++silenceCount >= silenceFrames) {
          const spoken = speechBuf.length; speaking = false; silenceCount = 0; speechCount = 0;
          const seg = _flatFrames(speechBuf); speechBuf = [];
          if (spoken >= minSpeechFrames) { onState("thinking"); try { const text = await transcribe(seg); if (running && text) onFinal(text); } catch {} }
          onState(running ? "listening" : "idle");
        }
      }
    }
    pumping = false;
  }

  async function start() {
    if (running) return;
    onState("loading");
    await loadVAD(onProgress); _vad.reset();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    src = ctx.createMediaStreamSource(stream); node = ctx.createScriptProcessor(4096, 1, 1);
    running = true; speaking = false; speechCount = 0; silenceCount = 0; speechBuf = []; preroll = []; pending = new Float32Array(0); queue = [];
    node.onaudioprocess = (e) => {
      if (!running) return;
      // GATE: while Q is thinking or speaking, ignore the mic entirely — so Q never hears its own voice.
      if (gate && !gate()) { pending = new Float32Array(0); queue = []; speaking = false; speechBuf = []; preroll = []; speechCount = 0; silenceCount = 0; return; }
      const d = e.inputBuffer.getChannelData(0);
      const merged = new Float32Array(pending.length + d.length); merged.set(pending); merged.set(d, pending.length);
      let off = 0; while (merged.length - off >= FRAME) { queue.push(merged.slice(off, off + FRAME)); off += FRAME; }
      pending = merged.slice(off); pump();
    };
    src.connect(node); node.connect(ctx.destination);
    onState("listening");
  }
  function stop() {
    running = false; queue = []; speaking = false; speechBuf = []; preroll = [];
    try { node && node.disconnect(); } catch {} try { src && src.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {} try { ctx && ctx.close(); } catch {}
    node = src = stream = ctx = null; onState("idle");
  }
  return { start, stop, available, get running() { return running; } };
}
