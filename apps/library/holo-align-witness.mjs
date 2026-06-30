#!/usr/bin/env node
// holo-align-witness.mjs — proves the forced-alignment kernel: ASR word-timings + known reference text →
// a per-sentence syncmap whose spans track the narration, with honest confidence and — crucially — graceful
// degradation when the audio and text disagree (never a confidently-wrong highlight). And the map is κ-pure.
//
//   1 sentenceSpans   — clean ASR over known text → mode "sentence", one span per sentence, bounds in order.
//   2 timingTracks    — span start/end ms match the ASR words that anchor each sentence (within tolerance).
//   3 gapsInterpolate — a ref word with NO ASR match still gets a monotonic time between its neighbours.
//   4 degradesChapter — garbled/mismatched ASR (low overlap) degrades to mode "chapter", conf reported low.
//   5 textOnly        — no ASR at all → mode "text-only", spans present, times null (readable, not faked).
//   6 kappaPure       — same (text, asr) ⇒ identical syncmap κ; a changed timing ⇒ different κ.
//
// node holo-align-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { alignChapter, sealSyncmap } from "./holo-align.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };

const refText = "The quick brown fox jumps. It leaps over the lazy dog. Then it rests by the river.";
// ASR hypothesis: timings in ms. "leaps" is mis-recognized as "leapt" (a gap to interpolate), rest matches.
const asrWords = [
  { w: "the", t0: 0, t1: 200 }, { w: "quick", t0: 200, t1: 500 }, { w: "brown", t0: 500, t1: 800 }, { w: "fox", t0: 800, t1: 1100 }, { w: "jumps", t0: 1100, t1: 1600 },
  { w: "it", t0: 1700, t1: 1900 }, { w: "leapt", t0: 1900, t1: 2200 }, { w: "over", t0: 2200, t1: 2500 }, { w: "the", t0: 2500, t1: 2700 }, { w: "lazy", t0: 2700, t1: 3000 }, { w: "dog", t0: 3000, t1: 3400 },
  { w: "then", t0: 3500, t1: 3800 }, { w: "it", t0: 3800, t1: 4000 }, { w: "rests", t0: 4000, t1: 4400 }, { w: "by", t0: 4400, t1: 4600 }, { w: "the", t0: 4600, t1: 4800 }, { w: "river", t0: 4800, t1: 5300 },
];

const map = alignChapter({ refText, asrWords, chapterId: "c1" });

// 1
ok("sentenceSpans", map.mode === "sentence" && map.spans.length === 3 &&
  map.spans[0].startMs <= map.spans[1].startMs && map.spans[1].startMs <= map.spans[2].startMs, JSON.stringify({ mode: map.mode, n: map.spans.length }));
// 2 — sentence 0 ("The quick brown fox jumps.") spans ~0..1600; sentence 2 ("Then it rests…") spans ~3500..5300
{
  const s0 = map.spans[0], s2 = map.spans[2];
  ok("timingTracks", Math.abs(s0.startMs - 0) <= 50 && Math.abs(s0.endMs - 1600) <= 50 && Math.abs(s2.startMs - 3500) <= 50 && Math.abs(s2.endMs - 5300) <= 50,
    JSON.stringify({ s0: [s0.startMs, s0.endMs], s2: [s2.startMs, s2.endMs] }));
}
// 3 — sentence 1 ("It leaps over the lazy dog.") — "leaps" had no ASR match (asr said "leapt") yet the sentence
//     is still bounded by its matched neighbours, monotonic, with conf < 1 (one word unmatched).
{
  const s1 = map.spans[1];
  ok("gapsInterpolate", s1.startMs >= map.spans[0].endMs - 1 && s1.endMs <= map.spans[2].startMs + 1 && s1.conf > 0 && s1.conf < 1, JSON.stringify(s1));
}
// 4 — garbled ASR (no shared words) → degrade to chapter, low confidence, no per-sentence highlight
{
  const garbled = [{ w: "zzz", t0: 0, t1: 300 }, { w: "qqq", t0: 300, t1: 700 }, { w: "wxyz", t0: 700, t1: 1200 }];
  const d = alignChapter({ refText, asrWords: garbled, chapterId: "c1" });
  ok("degradesChapter", d.mode === "chapter" && d.spans.length === 1 && d.overallConf < 0.5 && d.spans[0].startMs === 0 && d.spans[0].endMs === 1200, JSON.stringify({ mode: d.mode, conf: d.overallConf }));
}
// 5 — no ASR → text-only, readable, never faked timings
{
  const t = alignChapter({ refText, asrWords: [], chapterId: "c1" });
  ok("textOnly", t.mode === "text-only" && t.spans.length === 3 && t.spans.every((s) => s.startMs === null && s.endMs === null), JSON.stringify({ mode: t.mode }));
}
// 6 — κ purity
{
  const k1 = sealSyncmap(map);
  const k2 = sealSyncmap(alignChapter({ refText, asrWords, chapterId: "c1" }));
  const bumped = JSON.parse(JSON.stringify(map)); bumped.spans[0].endMs += 1;
  const k3 = sealSyncmap(bumped);
  ok("kappaPure", /^blake3:[0-9a-f]{64}$/.test(k1) && k1 === k2 && k1 !== k3, k1.slice(0, 22));
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-align — forced alignment turns separate audio (ASR word-timings) + known text into a per-sentence syncmap that tracks the narration, with honest per-span confidence. Unmatched words interpolate monotonically; when audio and text disagree it DEGRADES to chapter-level rather than emit a confidently-wrong highlight; with no audio it is text-only (never faked). The syncmap is κ-pure: the same (audio,text) yields the same κ, so an alignment is computed once and shared. The ASR model is the only GPU/browser-gated edge; this correctness kernel runs headless.",
  authority: "rests on #holo-blake3 + the Moonshine/Whisper ASR seam — P2 of the Holo Library build (the printing press)",
  witnessed,
  covers: witnessed ? ["sentence-spans", "timing-tracks", "gaps-interpolate", "degrades-chapter", "text-only", "kappa-pure"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-align-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-align witness — the printing press: audio + text → an honest, κ-pure syncmap\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  read-along auto-manufactured; degrades, never lies" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
