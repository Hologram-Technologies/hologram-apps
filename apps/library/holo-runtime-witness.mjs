#!/usr/bin/env node
// holo-runtime-witness.mjs — proves the NEW M1 glue (the parts that are pure and can be witnessed headlessly):
// the ASR adapter, the κ audio-pin, and the section↔chapter map — and that they compose with the existing
// kernels into a manufactured read-along. The only thing left for the in-host session is swapping the fake ASR
// engine + Map store for the real Whisper-on-κ + holo-content-net (the GPU/SW edge).
//
//   1 asrNormalizesTransformers — transformers {chunks:[{text,timestamp:[s,s]}]} → monotonic [{w,t0(ms),t1}].
//   2 asrSegmentExpands          — a segment phrase expands to evenly-spaced words (so segment ts still aligns).
//   3 pinByKappa                 — pin(bytes) gives κ = kappaOf(bytes), dedups; resolveVerified round-trips.
//   4 pinTamperFails             — corrupt a pinned blob → resolveVerified throws (L5 fail-closed).
//   5 chapterMapTitle            — "Letter 1"/"Chapter I" sections map to the right text chapters (roman-aware).
//   6 chapterMapNoForce          — extra/unmatched sections are left UNMATCHED + logged, never forced.
//   7 composeReadAlong           — fake-ASR words + real text chapter → holo-align syncmap → manufactureTitle →
//                                  a verifiable read-along holo-title (the full M1.3/M1.4 chain, sans engines).
//
// node holo-runtime-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createASR, normalizeASR } from "./holo-asr.mjs";
import { createMemStore, pin, resolveVerified } from "./holo-pin.mjs";
import { mapSections, parseHeading } from "./holo-chaptermap.mjs";
import { toTextDAG, chapterRefText } from "./holo-text.mjs";
import { alignChapter } from "./holo-align.mjs";
import { manufactureTitle } from "./holo-library.mjs";
import { kappaOf } from "./holo-kappa.mjs";
import { verifyTitle } from "./holo-title.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };
const te = new TextEncoder();

// 1 + 2 — ASR adapter normalizes the transformers shape (seconds → ms, words monotonic; segment expands)
{
  const fakeEngine = { async transcribe() { return { chunks: [
    { text: "the quick", timestamp: [0.0, 0.6] },     // a 2-word segment → expands evenly
    { text: "brown", timestamp: [0.6, 0.9] },
    { text: "fox", timestamp: [0.9, 1.3] },
  ] }; } };
  const asr = createASR({ engine: fakeEngine });
  const words = await asr.toWords(new Uint8Array([1, 2, 3]), { timestamps: "segment" });
  const mono = words.every((w, i) => i === 0 || w.t0 >= words[i - 1].t0);
  ok("asrNormalizesTransformers", words.length === 4 && words[0].w === "the" && words[0].t0 === 0 && words[2].w === "brown" && mono, JSON.stringify(words.map((w) => [w.w, w.t0])));
  const seg = normalizeASR({ chunks: [{ text: "alpha beta gamma", timestamp: [1, 4] }] });
  ok("asrSegmentExpands", seg.length === 3 && seg[0].t0 === 1000 && seg[2].t1 === 4000 && seg[1].w === "beta", JSON.stringify(seg));
}

// 3 + 4 — κ audio pin + verify + tamper
const store = createMemStore();
{
  const audio = new Uint8Array(512).map((_, i) => (i * 13 + 5) & 0xff);
  const a = pin(store, audio); const b = pin(store, audio);
  const got = resolveVerified(store, a.url);
  ok("pinByKappa", a.kappa === kappaOf(audio) && a.kappa === b.kappa && store.size === 1 && got.length === 512 && Buffer.compare(Buffer.from(got), Buffer.from(audio)) === 0, a.kappa.slice(0, 18));
  const evil = store.get(a.kappa).slice(); evil[0] ^= 0xff; store.set(a.kappa, evil);
  let threw = false; try { resolveVerified(store, a.kappa); } catch (e) { threw = /mismatch|tamper/.test(e.message); }
  ok("pinTamperFails", threw);
}

// 5 + 6 — chapter map (build real text chapters from a Gutenberg-shaped fixture)
const RAW = ["*** START OF THE PROJECT GUTENBERG EBOOK X ***", "", "Letter 1", "", "A. B. C.", "", "Letter 2", "", "D. E. F.", "", "Chapter 1", "", "G. H. I.", "", "*** END OF THE PROJECT GUTENBERG EBOOK X ***"].join("\n");
const dag = toTextDAG(RAW, { bookId: "x" });
{
  const sections = [{ title: "Letter 1" }, { title: "Letter II" }, { title: "Chapter I" }];   // II/I roman, must still map
  const { pairs } = mapSections(sections, dag.chapters);
  const byId = Object.fromEntries(pairs.map((p) => [p.sectionIndex, p.chapterId]));
  ok("chapterMapTitle",
    parseHeading("Chapter I").num === 1 && pairs.length === 3 && pairs.every((p) => p.how === "title") &&
    byId[0] === dag.chapters[0].id && byId[2] === dag.chapters[2].id,
    JSON.stringify(pairs.map((p) => [p.sectionIndex, p.chapterId, p.how])));
}
{
  const sections = [{ title: "Credits" }, { title: "Letter 1" }, { title: "Letter 2" }, { title: "Chapter 1" }];  // extra "Credits"
  const { pairs, unmatched, log } = mapSections(sections, dag.chapters);
  ok("chapterMapNoForce", unmatched.length === 1 && sections[unmatched[0]].title === "Credits" && pairs.length === 3 && log.some((l) => /unmatched/.test(l)), JSON.stringify({ unmatched, pairs: pairs.length }));
}

// 7 — full compose: fake-ASR words for chapter 0 + its real text → align → manufacture a read-along title
{
  const ref = chapterRefText(dag, 0);                                  // "A. B. C." → sentences
  const asrWords = ref.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean).map((w, i) => ({ w, t0: i * 300, t1: i * 300 + 250 }));
  const sm = alignChapter({ refText: ref, asrWords, chapterId: dag.chapters[0].id });
  const audioBytes = new Uint8Array(256).map((_, i) => (i * 7) & 0xff);
  const { title } = manufactureTitle({
    work: { title: "Fixture Work", authors: ["Public Domain"], lang: "en" },
    audioBytes, textBytes: te.encode(ref), asrWords, chapterId: dag.chapters[0].id,
    sources: [{ library: "LibriVox", mediaType: "audio" }, { library: "Project Gutenberg", mediaType: "text" }],
  });
  ok("composeReadAlong", sm.mode === "sentence" && verifyTitle(title) && title.modes.readalong && title.audio === kappaOf(audioBytes), JSON.stringify({ smMode: sm.mode, readalong: title.modes.readalong }));
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-runtime (M1 glue) — the new wiring that the in-host session needs, witnessed headlessly: the ASR adapter normalizes transformers-Whisper {chunks:[{text,timestamp}]} (and segment/word shapes) to holo-align's [{w,t0,t1}] (M1.3 finding: κ-native forges are text-only, transformers timestamps are the MVP source); holo-pin content-addresses audio and verifies on resolve (fail-closed, L5); holo-chaptermap pairs LibriVox sections to text chapters by parsed (type,number) — roman-aware — and leaves ambiguous ones UNMATCHED rather than forcing a wrong pair. Together with the existing kernels they compose into a verifiable read-along title. Only the real ASR engine + content-net store (GPU/SW edge) remain for the live host session.",
  authority: "rests on #holo-asr + #holo-pin + #holo-chaptermap + #holo-align + #holo-library — M1 runtime glue",
  witnessed,
  covers: witnessed ? ["asr-normalizes-transformers", "asr-segment-expands", "pin-by-kappa", "pin-tamper-fails", "chapter-map-title", "chapter-map-no-force", "compose-read-along"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-runtime-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-runtime witness — M1 glue (ASR adapter, κ-pin, chapter-map) composes into a read-along\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  in-host session is now pure wiring: swap fake ASR + Map for Whisper + content-net" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
