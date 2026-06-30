#!/usr/bin/env node
// holo-manufacture-witness.mjs — proves the LIVE pipeline orchestration headlessly (fake ASR engine + Map
// store stand in for in-host Whisper + holo-content-net). It is the exact flow the host runs; only the two
// injected stubs differ. Confirms: text→DAG, audio pinned by κ, sections↔chapters mapped, chapter aligned
// LAZILY (eager first chapter, rest on demand), title sealed + verifiable + read-along, and re-sealing after
// aligning more chapters extends coverage (the syncmap κ is honest about how much is aligned).
//
//   1 buildsDag        — Gutenberg text → chapters with spans.
//   2 pinsAudioByKappa  — each section pinned; pins carry κ = kappaOf(bytes).
//   3 mapsSections      — sections pair to chapters by title.
//   4 lazyAlign         — only eagerChapters aligned up front; alignChapter(i) aligns more on demand.
//   5 sealsReadAlong    — title() seals a verifiable public-domain holo-title with readalong + the κ playlist.
//   6 coverageGrows     — aligning another chapter then re-sealing changes the syncmap κ (more coverage).
//
// node holo-manufacture-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createManufacture } from "./holo-manufacture.mjs";
import { createASR } from "./holo-asr.mjs";
import { createMemStore } from "./holo-pin.mjs";
import { kappaOf } from "./holo-kappa.mjs";
import { verifyTitle, RIGHTS } from "./holo-title.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };
const te = new TextEncoder();

// a fake Whisper engine: "transcribes" by emitting the chapter's own words (the host swaps in real Whisper).
// It reads the section's bytes (which we encode as the chapter text) so each chapter gets matching words.
const fakeEngine = {
  async transcribe(pcm) {
    const text = new TextDecoder().decode(pcm);
    const toks = text.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
    return { chunks: toks.map((w, i) => ({ text: w, timestamp: [i * 0.3, i * 0.3 + 0.25] })) };
  },
};
const asr = createASR({ engine: fakeEngine });
const store = createMemStore();
const man = createManufacture({ asr, store });

const RAW = ["*** START OF THE PROJECT GUTENBERG EBOOK X ***", "",
  "Letter 1", "", "You will rejoice to hear this. The cold breeze braces me.", "",
  "Letter 2", "", "How slowly the time passes here. I have hired a vessel.", "",
  "*** END OF THE PROJECT GUTENBERG EBOOK X ***"].join("\n");
// each section's "audio" bytes are the chapter text (so the fake ASR returns matching words).
const sections = [
  { title: "Letter 1", audioBytes: te.encode("You will rejoice to hear this The cold breeze braces me"), sec: 30 },
  { title: "Letter 2", audioBytes: te.encode("How slowly the time passes here I have hired a vessel"), sec: 28 },
];

const built = await man.build({ title: "Frankenstein", authors: ["Mary Shelley"], lang: "en" }, { gutenbergText: RAW, sections, eagerChapters: 1 });

// 1
ok("buildsDag", built.dag.chapters.length === 2 && built.dag.chapters[0].spans.length >= 1 && /rejoice/.test(built.dag.chapters[0].spans[0].text), JSON.stringify(built.dag.chapters.map((c) => c.title)));
// 2
ok("pinsAudioByKappa", built.pins.length === 2 && built.pins[0].kappa === kappaOf(sections[0].audioBytes) && store.size === 2, built.pins[0].kappa.slice(0, 18));
// 3
ok("mapsSections", built.map.pairs.length === 2 && built.map.pairs.every((p) => p.how === "title"), JSON.stringify(built.map.pairs.map((p) => [p.sectionIndex, p.chapterId])));
// 4 — only chapter 0 aligned eagerly; chapter 1 aligns on demand
{
  const before = built.state.aligned;
  const sm1 = await built.alignChapter(1);
  ok("lazyAlign", before === 1 && built.state.aligned === 2 && sm1 && sm1.mode === "sentence" && sm1.overallConf >= 0.9, JSON.stringify({ before, after: built.state.aligned, mode: sm1 && sm1.mode }));
}
// 5 — seal a verifiable read-along title
let t1;
{
  const out = built.title();
  t1 = out.sealed;
  ok("sealsReadAlong", verifyTitle(t1) && t1.rights.class === RIGHTS.PUBLIC_DOMAIN && t1.modes.readalong && out.playlist.length === 2 && out.spans.length >= 2, JSON.stringify({ readalong: t1.modes.readalong, spans: out.spans.length, aligned: out.alignedCount }));
}
// 6 — coverage is honest: the eager-1-chapter title vs the both-chapters title differ in syncmap κ
{
  const fresh = await man.build({ title: "Frankenstein", authors: ["Mary Shelley"], lang: "en" }, { gutenbergText: RAW, sections, eagerChapters: 1 });
  const oneChapKappa = fresh.title().sealed.syncmap;
  await fresh.alignChapter(1);
  const twoChapKappa = fresh.title().sealed.syncmap;
  ok("coverageGrows", oneChapKappa && twoChapKappa && oneChapKappa !== twoChapKappa, JSON.stringify({ one: oneChapKappa.slice(0, 16), two: twoChapKappa.slice(0, 16) }));
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-manufacture — the live in-host pipeline, witnessed headlessly with injected stubs: a discovered work's Gutenberg text → holo-text DAG; LibriVox sections pinned by κ (holo-pin); sections↔chapters mapped (holo-chaptermap); each chapter aligned LAZILY via the real ASR adapter (holo-asr) → holo-align, so chapter one is read-along-ready fast and the rest align on demand; title() seals a verifiable public-domain holo-title (audio = κ playlist, text = DAG κ, syncmap = κ over aligned chapters, honest about coverage). The ONLY in-host swaps are the Whisper engine (holo-asr-whisper) and the content-net store — every other step is proven here.",
  authority: "rests on #holo-text + #holo-pin + #holo-chaptermap + #holo-asr + #holo-align + #holo-title — the M1 live pipeline",
  witnessed,
  covers: witnessed ? ["builds-dag", "pins-audio-by-kappa", "maps-sections", "lazy-align", "seals-read-along", "coverage-grows"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-manufacture-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-manufacture witness — the live pipeline, proven headless (swap fake ASR+store for Whisper+content-net)\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  M1 is now drop-in: real engine + store are the only remaining wires" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
