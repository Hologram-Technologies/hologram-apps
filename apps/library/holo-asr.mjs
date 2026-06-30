// holo-asr.mjs — the ASR adapter seam. M1.3 finding: the κ-native Whisper/Moonshine forges emit TEXT ONLY (no
// timings); word/segment timings come from the HF-transformers Whisper fallback via return_timestamps. Forced
// alignment needs TIMINGS, not a perfect transcript (we already have the exact text from Gutenberg), and
// holo-align anchors on the words ASR got right and interpolates the rest — so transformers-Whisper timestamps
// are a sound MVP. This adapter normalizes ANY engine's output to the [{w,t0,t1}] hypothesis holo-align expects,
// so the engine is swappable (transformers now; a timestamp-emitting κ-native forge later) behind one contract.
//
//   createASR({ engine })  — engine.transcribe(audio, { timestamps:"word"|"segment" }) → one of:
//       { chunks:[{ text, timestamp:[t0Sec,t1Sec] }] }      // HF transformers shape (word or segment)
//       { words:[{ w, t0, t1 }] } | { segments:[{ text, t0, t1 }] }   // already-ms shapes
//     .toWords(audio, opts) → [{ w, t0, t1 }]   (ms; segments expand to evenly-spaced words for holo-align)
//
// Pure normalization → Node witnesses it with a fake engine; the real engine is the GPU/WASM edge.

const normTok = (w) => String(w || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9']+/g, " ").trim();

// a transformers "chunk" is { text, timestamp:[startSec, endSec] }. text may be one word (timestamps:"word")
// or a phrase (segment). Split a phrase into words spaced evenly across its [t0,t1] — holo-align then anchors
// the real matches and interpolates, so even segment-level timing yields a usable syncmap.
function chunkToWords(text, t0ms, t1ms) {
  const toks = normTok(text).split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  if (toks.length === 1) return [{ w: toks[0], t0: t0ms, t1: t1ms }];
  const span = Math.max(0, t1ms - t0ms), step = span / toks.length;
  return toks.map((w, i) => ({ w, t0: Math.round(t0ms + i * step), t1: Math.round(t0ms + (i + 1) * step) }));
}

export function normalizeASR(out) {
  if (!out) return [];
  if (Array.isArray(out.words)) return out.words.map((x) => ({ w: normTok(x.w), t0: x.t0, t1: x.t1 })).filter((x) => x.w);
  if (Array.isArray(out.segments)) return out.segments.flatMap((s) => chunkToWords(s.text, s.t0, s.t1));
  if (Array.isArray(out.chunks)) return out.chunks.flatMap((c) => {
    const [a, b] = c.timestamp || c.ts || []; if (a == null) return [];
    return chunkToWords(c.text, Math.round(a * 1000), Math.round((b ?? a) * 1000));   // transformers: seconds → ms
  });
  if (typeof out.text === "string") return [];   // text-only engine (κ-native Whisper/Moonshine): no timings → caller degrades
  return [];
}

export function createASR({ engine } = {}) {
  if (!engine || typeof engine.transcribe !== "function") throw new Error("holo-asr: an engine with transcribe(audio, opts) is required");
  return {
    async toWords(audio, { timestamps = "word" } = {}) {
      const out = await engine.transcribe(audio, { timestamps });
      const words = normalizeASR(out);
      // enforce monotonic, non-overlapping timings (holo-align assumes increasing t0)
      let last = -1;
      return words.filter((x) => x.w).map((x) => { const t0 = Math.max(x.t0, last); last = Math.max(t0, x.t1); return { w: x.w, t0, t1: Math.max(x.t1, t0) }; });
    },
    engine,
  };
}

export default { createASR, normalizeASR };
if (typeof window !== "undefined") window.HoloASR = { createASR, normalizeASR };
