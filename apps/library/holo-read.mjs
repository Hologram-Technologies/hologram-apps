// holo-read.mjs — the reader kernel: ONE timeline cursor shared by listening and reading. The whole "seamless
// switch" magic reduces to a single invariant: the cursor is an absolute audio-ms position, and BOTH modes are
// pure functions of it. Listening advances ms; reading highlights the span at ms; flipping modality keeps ms
// and re-derives the span — so the switch never re-fetches and never loses your place. The text+syncmap tracks
// are tiny and cache-resident, so read-along costs ~nothing over plain listening. Pure ESM → Node witnesses the
// cursor math; the UI (holo-read-ui.mjs) just binds <audio>.currentTime to this cursor.
//
//   createReader(spans /* sorted, absolute ms */, { io } = {})
//     .msToSpan(ms) → index    .spanToMs(i|spanId) → startMs    .cursorAt(ms) → { ms, i, spanId, text }
//     .switchModality(cursor, to) → { mode, ms, i, spanId }     (SYNCHRONOUS, performs NO io)
//     .seekToSpan(spanId) → ms   .search(q) → [{ i, spanId, startMs, snippet }]
//
// spans flatten a book's per-chapter syncmaps into one timeline; flattenSyncmaps() builds that with chapter
// offsets so chapter 2's ms continue after chapter 1.

// fold per-chapter syncmaps (each starting near 0) into one absolute timeline using chapter audio durations.
export function flattenSyncmaps(chapterMaps /* [{chapterId, spans, durationMs?}] */) {
  const out = []; let offset = 0;
  for (const cm of chapterMaps) {
    let maxEnd = 0;
    for (const s of cm.spans) {
      const startMs = (s.startMs ?? 0) + offset, endMs = (s.endMs ?? s.startMs ?? 0) + offset;
      out.push({ spanId: s.spanId, text: s.text, startMs, endMs, conf: s.conf ?? 0, chapter: cm.chapterId });
      maxEnd = Math.max(maxEnd, endMs);
    }
    offset = cm.durationMs ? offset + cm.durationMs : maxEnd;
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export function createReader(spans = [], { io = null } = {}) {
  const S = [...spans].sort((a, b) => a.startMs - b.startMs);
  const byId = new Map(S.map((s, i) => [s.spanId, i]));

  // binary search: the last span whose startMs ≤ ms (clamped to [0, last]). Pure, O(log n), no IO.
  function msToSpan(ms) {
    if (!S.length) return -1;
    if (ms <= S[0].startMs) return 0;
    let lo = 0, hi = S.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (S[mid].startMs <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  const spanToMs = (ref) => { const i = typeof ref === "number" ? ref : byId.get(ref); return i == null || i < 0 ? 0 : S[i].startMs; };
  const cursorAt = (ms) => { const i = msToSpan(ms); const s = S[i] || null; return { ms, i, spanId: s ? s.spanId : null, text: s ? s.text : "" }; };

  // the switch: position is the cursor's ms; the new mode re-derives its view from it. Returns synchronously and
  // touches NO io — proven in the witness with an io spy. THIS is "switch mid-sentence with zero re-fetch".
  function switchModality(cursor, to) {
    const ms = typeof cursor === "number" ? cursor : (cursor && cursor.ms) || 0;
    const i = msToSpan(ms);
    return { mode: to, ms, i, spanId: S[i] ? S[i].spanId : null };
  }
  const seekToSpan = (spanId) => spanToMs(spanId);

  // full-text search → seekable hits (tap a result, listen jumps there).
  function search(q) {
    const needle = String(q || "").toLowerCase().trim(); if (!needle) return [];
    const hits = [];
    for (let i = 0; i < S.length; i++) {
      const text = S[i].text || ""; const at = text.toLowerCase().indexOf(needle);
      if (at >= 0) hits.push({ i, spanId: S[i].spanId, startMs: S[i].startMs, snippet: text.slice(Math.max(0, at - 24), at + needle.length + 24).trim() });
    }
    return hits;
  }

  return { spans: S, msToSpan, spanToMs, cursorAt, switchModality, seekToSpan, search, _io: io };
}

export default { createReader, flattenSyncmaps };
if (typeof window !== "undefined") window.HoloRead = { createReader, flattenSyncmaps };
