// holo-align.mjs — the printing press. Forced alignment turns SEPARATE audio and KNOWN text into a syncmap:
// the κ-track that lets you read along while you listen. Input is the audio's ASR hypothesis (words + ms
// timings, produced by holo-moonshine-ear / Whisper on κ) and the reference text (from Gutenberg). Output is a
// per-sentence span map with start/end ms and a per-span CONFIDENCE. The hard rule: never present a
// confidently-wrong highlight — when the audio and text don't agree (abridged edition, wrong recording), the
// map DEGRADES to chapter-level instead of lying. Pure ESM → Node witnesses the alignment exactly; the ASR
// itself is the only browser/GPU-gated edge.
//
//   alignChapter({ refText, asrWords:[{w,t0,t1}], chapterId?, threshold? })
//     → { mode:"sentence"|"chapter"|"text-only", spans:[{ i, spanId, text, startMs, endMs, conf }], overallConf }
//   sealSyncmap(syncmap) → "blake3:…"  (κ-pure: same (audio,text) ⇒ same κ ⇒ cacheable + shareable)

import { blake3hex } from "./holo-kappa.mjs";
const enc = new TextEncoder();

const normTok = (w) => String(w || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9']+/g, "");

// split text into sentences (keep original text for display), then words (normalized for matching).
function tokenizeRef(refText) {
  const sentences = String(refText || "").replace(/\s+/g, " ").trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((s) => s.trim()).filter(Boolean);
  const words = [];                                          // { norm, sent }
  sentences.forEach((sent, si) => {
    for (const raw of sent.split(/\s+/)) { const n = normTok(raw); if (n) words.push({ norm: n, sent: si }); }
  });
  return { sentences, words };
}

// monotonic greedy anchor match: for each ref word, take the earliest UNUSED asr word with the same token that
// lies at/after the last match. O(n) with a per-token cursor; keeps the alignment strictly increasing in time.
function anchorMatch(refWords, asrToks) {
  const byTok = new Map();                                   // token → sorted asr indices
  asrToks.forEach((t, i) => { if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(i); });
  const cursor = new Map();                                  // token → next index into its list to try
  let lastAsr = -1;
  const match = new Array(refWords.length).fill(-1);
  for (let r = 0; r < refWords.length; r++) {
    const tok = refWords[r].norm;
    const list = byTok.get(tok); if (!list) continue;
    let c = cursor.get(tok) || 0;
    while (c < list.length && list[c] <= lastAsr) c++;
    if (c < list.length) { match[r] = list[c]; lastAsr = list[c]; cursor.set(tok, c + 1); }
  }
  return match;                                              // match[r] = asr index or -1
}

// assign a time to every ref word: anchored words take their asr time; gaps interpolate; ends clamp.
function timeRefWords(refWords, match, asrWords) {
  const n = refWords.length;
  const t0 = new Array(n).fill(null), t1 = new Array(n).fill(null), anchored = new Array(n).fill(false);
  const anchors = [];
  for (let r = 0; r < n; r++) if (match[r] >= 0) { const a = asrWords[match[r]]; t0[r] = a.t0; t1[r] = a.t1; anchored[r] = true; anchors.push(r); }
  if (!anchors.length) return { t0, t1, anchored, anchors };
  // leading / trailing clamp
  for (let r = 0; r < anchors[0]; r++) { t0[r] = t1[r] = t0[anchors[0]]; }
  const last = anchors[anchors.length - 1];
  for (let r = last + 1; r < n; r++) { t0[r] = t1[r] = t1[last]; }
  // interior gaps: spread evenly across the time between the bracketing anchors
  for (let k = 0; k < anchors.length - 1; k++) {
    const p = anchors[k], q = anchors[k + 1];
    if (q - p <= 1) continue;
    const span = Math.max(0, t0[q] - t1[p]); const steps = q - p;
    for (let r = p + 1; r < q; r++) { const t = t1[p] + (span * (r - p)) / steps; t0[r] = t1[r] = t; }
  }
  return { t0, t1, anchored, anchors };
}

export function alignChapter({ refText, asrWords = [], chapterId = "ch", threshold = 0.5 } = {}) {
  const { sentences, words } = tokenizeRef(refText);
  const asr = (asrWords || []).filter((a) => a && a.w != null);
  const asrToks = asr.map((a) => normTok(a.w));

  // no audio hypothesis → text-only map (readable, never claims sync).
  if (!asr.length || !words.length) {
    return {
      mode: "text-only",
      spans: sentences.map((text, i) => ({ i, spanId: `${chapterId}#s${i}`, text, startMs: null, endMs: null, conf: 0 })),
      overallConf: 0,
    };
  }

  const match = anchorMatch(words, asrToks);
  const anchoredCount = match.filter((m) => m >= 0).length;
  const overallConf = anchoredCount / words.length;
  const { t0, t1, anchors } = timeRefWords(words, match, asr);

  // disagreement → degrade to chapter-level rather than emit a wrong word/sentence highlight.
  if (overallConf < threshold || !anchors.length) {
    return {
      mode: "chapter",
      spans: [{ i: 0, spanId: `${chapterId}#all`, text: sentences.join(" "), startMs: asr[0].t0, endMs: asr[asr.length - 1].t1, conf: +overallConf.toFixed(3) }],
      overallConf: +overallConf.toFixed(3),
    };
  }

  // per-sentence spans: bounds from member words, confidence = matched fraction within the sentence.
  const agg = sentences.map(() => ({ start: Infinity, end: -Infinity, total: 0, matched: 0 }));
  words.forEach((w, r) => { const s = agg[w.sent]; s.total++; if (match[r] >= 0) s.matched++; if (t0[r] != null) { s.start = Math.min(s.start, t0[r]); s.end = Math.max(s.end, t1[r]); } });
  let prevEnd = asr[0].t0;
  const spans = sentences.map((text, i) => {
    const a = agg[i];
    const startMs = isFinite(a.start) ? Math.round(a.start) : prevEnd;
    const endMs = isFinite(a.end) ? Math.round(a.end) : startMs;
    prevEnd = endMs;
    return { i, spanId: `${chapterId}#s${i}`, text, startMs, endMs, conf: a.total ? +(a.matched / a.total).toFixed(3) : 0 };
  });
  return { mode: "sentence", spans, overallConf: +overallConf.toFixed(3) };
}

// align a whole book chapter-by-chapter (keeps memory bounded + lets the title become readable progressively).
export function alignBook(chapters /* [{id, refText, asrWords}] */, opts = {}) {
  return chapters.map((c) => ({ chapterId: c.id, ...alignChapter({ refText: c.refText, asrWords: c.asrWords, chapterId: c.id, ...opts }) }));
}

function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
// κ-pure seal: identical (audio, text) ⇒ identical syncmap ⇒ identical κ, so an alignment computed once is
// content-addressed and shareable — never recomputed for the same pair.
export function sealSyncmap(syncmap) { return "blake3:" + blake3hex(enc.encode(canonical(syncmap))); }

export default { alignChapter, alignBook, sealSyncmap };
if (typeof window !== "undefined") window.HoloAlign = { alignChapter, alignBook, sealSyncmap };
