#!/usr/bin/env node
// holo-read-witness.mjs — proves the reader kernel: one absolute-ms cursor shared by listening and reading, so
// switching modality keeps your place and costs NO IO, plus seek-by-tap and full-text search resolve to the
// same timeline. This is the witnessed core of the "seamless switch" — the UI just binds <audio> to it.
//
//   1 flattenTimeline  — per-chapter syncmaps fold into one absolute timeline (chapter 2 follows chapter 1).
//   2 msRoundTrip      — spanToMs(i) → ms; msToSpan(ms) → i; round-trips for every span.
//   3 switchKeepsPlace — listen at ms X → switch to read → read shows msToSpan(X); switch back → ms unchanged.
//   4 switchZeroIO     — switchModality is synchronous and calls the injected io ZERO times (no re-fetch).
//   5 seekByTap        — tapping a line returns its startMs, and msToSpan(thatMs) returns the same span.
//   6 searchSeekable   — search("river") returns the span carrying it, with a startMs to jump to.
//   7 boundsClamp      — ms before the first / after the last span clamp to span 0 / the last span.
//
// node holo-read-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createReader, flattenSyncmaps } from "./holo-read.mjs";
import { alignChapter } from "./holo-align.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };

// build two real chapter syncmaps via the P2 kernel, then flatten into one timeline.
const ch1 = alignChapter({ refText: "The quick brown fox jumps. It leaps over the lazy dog.", chapterId: "c1", asrWords: [
  { w: "the", t0: 0, t1: 200 }, { w: "quick", t0: 200, t1: 500 }, { w: "brown", t0: 500, t1: 800 }, { w: "fox", t0: 800, t1: 1100 }, { w: "jumps", t0: 1100, t1: 1600 },
  { w: "it", t0: 1700, t1: 1900 }, { w: "leaps", t0: 1900, t1: 2200 }, { w: "over", t0: 2200, t1: 2500 }, { w: "the", t0: 2500, t1: 2700 }, { w: "lazy", t0: 2700, t1: 3000 }, { w: "dog", t0: 3000, t1: 3400 } ] });
const ch2 = alignChapter({ refText: "Then it rests by the river. The river is calm.", chapterId: "c2", asrWords: [
  { w: "then", t0: 0, t1: 300 }, { w: "it", t0: 300, t1: 500 }, { w: "rests", t0: 500, t1: 900 }, { w: "by", t0: 900, t1: 1100 }, { w: "the", t0: 1100, t1: 1300 }, { w: "river", t0: 1300, t1: 1800 },
  { w: "the", t0: 1900, t1: 2100 }, { w: "river", t0: 2100, t1: 2500 }, { w: "is", t0: 2500, t1: 2700 }, { w: "calm", t0: 2700, t1: 3200 } ] });

const flat = flattenSyncmaps([{ chapterId: "c1", spans: ch1.spans, durationMs: 3500 }, { chapterId: "c2", spans: ch2.spans }]);

// 1 — chapter 2's spans are offset past chapter 1's duration (3500ms)
{
  const c2first = flat.find((s) => s.chapter === "c2");
  ok("flattenTimeline", flat.length === 4 && c2first && c2first.startMs >= 3500, JSON.stringify(flat.map((s) => [s.chapter, s.startMs])));
}

const io = { calls: 0, fetch() { this.calls++; return Promise.resolve(null); } };
const reader = createReader(flat, { io });

// 2 — ms round-trip for every span
{
  let good = true;
  reader.spans.forEach((s, i) => { if (reader.spanToMs(i) !== s.startMs) good = false; if (reader.msToSpan(s.startMs) !== i) good = false; });
  ok("msRoundTrip", good);
}
// 3 — switch keeps place
{
  const X = reader.spans[2].startMs + 40;                   // mid-span-2 (chapter 2, first sentence)
  const reading = reader.switchModality({ ms: X, mode: "listen" }, "read");
  const back = reader.switchModality(reading, "listen");
  ok("switchKeepsPlace", reading.mode === "read" && reading.i === reader.msToSpan(X) && back.mode === "listen" && back.ms === X, JSON.stringify({ X, readingI: reading.i, expect: reader.msToSpan(X), backMs: back.ms }));
}
// 4 — the switch is synchronous and performs ZERO io
{
  io.calls = 0;
  const r = reader.switchModality({ ms: 1234 }, "read");
  const isSync = !(r instanceof Promise) && typeof r === "object";
  ok("switchZeroIO", isSync && io.calls === 0, JSON.stringify({ isSync, ioCalls: io.calls }));
}
// 5 — seek by tap (tap a line → its ms → same span)
{
  const target = reader.spans[1];
  const ms = reader.seekToSpan(target.spanId);
  ok("seekByTap", ms === target.startMs && reader.spans[reader.msToSpan(ms)].spanId === target.spanId, JSON.stringify({ spanId: target.spanId, ms }));
}
// 6 — search resolves to a seekable span
{
  const hits = reader.search("river");
  ok("searchSeekable", hits.length >= 1 && /river/i.test(hits[0].snippet) && typeof hits[0].startMs === "number", JSON.stringify(hits.map((h) => [h.spanId, h.startMs])));
}
// 7 — bounds clamp
{
  ok("boundsClamp", reader.msToSpan(-999) === 0 && reader.msToSpan(9_999_999) === reader.spans.length - 1);
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-read — listening and reading share ONE absolute-ms cursor; both modes are pure functions of it. Switching modality keeps the ms position and re-derives the span synchronously with ZERO io — that is the 'switch mid-sentence with zero re-fetch' guarantee, proven with an io spy. Per-chapter syncmaps flatten into one timeline; tap-a-line seeks audio; full-text search resolves to seekable spans. The UI merely binds <audio>.currentTime to this kernel.",
  authority: "rests on #holo-align (syncmap) — P3 of the Holo Library build (the reader)",
  witnessed,
  covers: witnessed ? ["flatten-timeline", "ms-round-trip", "switch-keeps-place", "switch-zero-io", "seek-by-tap", "search-seekable", "bounds-clamp"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-read-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-read witness — one cursor, two modes, instant switch, zero re-fetch\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  listen↔read is a pure cursor flip; the magic is free" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
