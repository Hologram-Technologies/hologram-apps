// holo-tts-bridge.mjs — P6: close the last gap. Many public-domain TEXTS (Project Gutenberg) have no LibriVox
// recording. Holo's κ-native TTS (Kokoro, via holo-voice.js / holo-onnx-kserve) can narrate them — and because
// the synthesizer EMITS the word timings as it speaks, the syncmap is GROUND TRUTH: "self-alignment" is exact,
// no ASR guesswork. So a text-only work becomes a high-confidence read-along you own. The synthesized narration
// flows through the SAME real-κ pipeline (manufactureTitle), so it shares + opens on a fresh device like any
// other holo-title. Provenance marks the audio as synthetic (Holo TTS), license stays public-domain, derived.
//
//   narrateTitle({ work, textBytes, tts }) → { title, syncmap, blobs }
//     tts = { async synthesize(text) → { audioBytes:Uint8Array, words:[{w,t0,t1}] } }   (Kokoro, injected)
//
// Pure orchestration → Node witnesses it with an injected TTS; the real engine is the GPU/ONNX edge.

import { manufactureTitle } from "./holo-library.mjs";
import { RIGHTS } from "./holo-title.mjs";

const td = new TextDecoder();

export async function narrateTitle({ work, textBytes, tts, ttsName = "Holo TTS (Kokoro)", sources = [], chapterId = "c1" } = {}) {
  if (!tts || typeof tts.synthesize !== "function") throw new Error("holo-tts-bridge: a tts with synthesize(text) is required");
  const text = td.decode(textBytes);
  const { audioBytes, words } = await tts.synthesize(text);
  if (!audioBytes || !Array.isArray(words)) throw new Error("holo-tts-bridge: tts must return { audioBytes, words[] }");
  // the TTS word timings ARE the alignment — feed them as the (exact) hypothesis. manufactureTitle pins the
  // audio bytes to real κ, builds the syncmap, and seals a derived public-domain title.
  return manufactureTitle({
    work, audioBytes, textBytes, asrWords: words, chapterId,
    rightsClass: RIGHTS.PUBLIC_DOMAIN,
    sources: [...sources, { library: ttsName, mediaType: "narration", synthetic: true }],
  });
}

export default { narrateTitle };
if (typeof window !== "undefined") window.HoloTTSBridge = { narrateTitle };
