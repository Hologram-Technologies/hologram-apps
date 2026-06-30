// holo-asr-whisper.mjs — the REAL ASR engine for the in-host session, satisfying the holo-asr engine contract
// (transcribe(audio,{timestamps}) → transformers shape). Per the M1.3 finding, timings come from the
// transformers.js Whisper pipeline via return_timestamps. This is the GPU/WASM edge: it cannot run in the
// headless Node witness (it downloads/loads a model and needs WebGPU/WASM), so it is wired but proven only
// in-host. holo-asr.normalizeASR already consumes its {chunks:[{text,timestamp:[s,s]}]} output.
//
//   createWhisperEngine({ transformersUrl, model, device }) → { async transcribe(pcm16k, { timestamps }) }
//     pcm16k = Float32Array mono @16kHz (decode the LibriVox mp3 with Web Audio / holo-sound before calling).
//     transformersUrl = the module to import the pipeline from — inject the OS's vendored/κ-served transformers
//     (or a CDN). model = a Whisper id with timestamp support (e.g. "onnx-community/whisper-base" / "Xenova/whisper-base").
//
// NOTE: prefer the κ-served Whisper model when the host exposes it (holo-onnx-kserve), so weights stream by κ;
// fall back to the transformers default loader. Either way the OUTPUT shape is the same.

const DEFAULT_MODEL = "onnx-community/whisper-base";

export function createWhisperEngine({ transformersUrl = "@huggingface/transformers", model = DEFAULT_MODEL, device } = {}) {
  let asrP = null;                                                     // lazily-built pipeline promise (load once)
  async function getPipe() {
    if (!asrP) asrP = (async () => {
      const tf = await import(transformersUrl);                        // host injects the real module path
      const pipeline = tf.pipeline || (tf.default && tf.default.pipeline);
      if (!pipeline) throw new Error("holo-asr-whisper: transformers module has no pipeline()");
      return pipeline("automatic-speech-recognition", model, device ? { device } : undefined);
    })();
    return asrP;
  }
  return {
    model,
    async transcribe(pcm16k, { timestamps = "word" } = {}) {
      const asr = await getPipe();
      // return_timestamps: 'word' → chunks with word-level [t0,t1]; true → segment-level. chunk_length_s lets
      // Whisper handle audio longer than 30s. Output: { text, chunks:[{ text, timestamp:[startSec, endSec] }] }.
      return asr(pcm16k, {
        return_timestamps: timestamps === "word" ? "word" : true,
        chunk_length_s: 30, stride_length_s: 5,
      });
    },
  };
}

// helper the host can use to turn an mp3 ArrayBuffer into the 16kHz mono Float32 Whisper expects (Web Audio).
export async function decodePcm16k(arrayBuffer, AudioCtx = (typeof window !== "undefined" && (window.OfflineAudioContext || window.webkitOfflineAudioContext))) {
  if (!AudioCtx) throw new Error("holo-asr-whisper: no OfflineAudioContext (call in the host)");
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmp.decodeAudioData(arrayBuffer.slice(0));
  tmp.close?.();
  const off = new AudioCtx(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);                                        // Float32Array mono @16kHz
}

export default { createWhisperEngine, decodePcm16k };
if (typeof window !== "undefined") window.HoloASRWhisper = { createWhisperEngine, decodePcm16k };
