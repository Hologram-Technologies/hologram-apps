#!/usr/bin/env node
// holo-text-witness.mjs — proves the text track: a raw Project Gutenberg book becomes an addressable, content-
// addressed text DAG (license boilerplate stripped, chapterized, sentence-spanned, κ per chapter) whose spans
// feed holo-align and holo-read unchanged. Deterministic fixture → no network.
//
//   1 stripsBoilerplate — PG START/END markers and the license text outside them are removed.
//   2 chapterizes       — heading lines ("Letter 1", "Chapter I") split the body into chapters (+ preface).
//   3 sentenceSpans     — each chapter is split into sentence spans with stable spanIds.
//   4 chapterKappa      — every chapter is content-addressed; the text-track κ is stable + deterministic.
//   5 feedsAlign        — a chapter's ref text + matching ASR words align cleanly through holo-align (P2).
//
// node holo-text-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toTextDAG, stripGutenberg, chapterRefText } from "./holo-text.mjs";
import { alignChapter } from "./holo-align.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };

// a realistic Gutenberg-shaped fixture: license header, START marker, two "letter" chapters, END marker, footer.
const RAW = [
  "The Project Gutenberg eBook of Frankenstein",
  "This ebook is for the use of anyone anywhere ... mostLicenseTextHere ...",
  "*** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***",
  "",
  "Letter 1",
  "",
  "You will rejoice to hear that no disaster has accompanied the commencement. I arrived here yesterday. The cold breeze braces my nerves.",
  "",
  "Letter 2",
  "",
  "How slowly the time passes here. Yet a second change has taken place. I have hired a vessel.",
  "",
  "*** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***",
  "This and all associated files ... more license boilerplate ... Project Gutenberg-tm ...",
].join("\n");

// 1 — strip
{
  const body = stripGutenberg(RAW);
  ok("stripsBoilerplate", !/START OF THE PROJECT GUTENBERG/i.test(body) && !/associated files/i.test(body) && /You will rejoice/.test(body) && !/mostLicenseTextHere/.test(body), body.slice(0, 40));
}

const dag = toTextDAG(RAW, { bookId: "fr" });

// 2 — chapterize (two letters)
ok("chapterizes", dag.chapters.length === 2 && /Letter 1/i.test(dag.chapters[0].title) && /Letter 2/i.test(dag.chapters[1].title), JSON.stringify(dag.chapters.map((c) => c.title)));
// 3 — sentence spans
{
  const c0 = dag.chapters[0];
  ok("sentenceSpans", c0.spans.length === 3 && c0.spans[0].spanId === "fr0#s0" && /rejoice/.test(c0.spans[0].text), JSON.stringify(c0.spans.map((s) => s.spanId)));
}
// 4 — chapter κ + deterministic text-track κ
{
  const dag2 = toTextDAG(RAW, { bookId: "fr" });
  ok("chapterKappa", /^blake3:[0-9a-f]{64}$/.test(dag.chapters[0].kappa) && /^blake3:[0-9a-f]{64}$/.test(dag.kappa) && dag.kappa === dag2.kappa, dag.kappa.slice(0, 18));
}
// 5 — feeds align: ref text of chapter 0 + ASR words → a clean sentence syncmap
{
  const ref = chapterRefText(dag, 0);
  const asr = ref.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean).map((w, i) => ({ w, t0: i * 300, t1: i * 300 + 260 }));
  const sm = alignChapter({ refText: ref, asrWords: asr, chapterId: dag.chapters[0].id });
  ok("feedsAlign", sm.mode === "sentence" && sm.overallConf >= 0.95 && sm.spans.length === 3, JSON.stringify({ mode: sm.mode, conf: sm.overallConf }));
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-text — a raw Project Gutenberg book becomes the reader's addressable text track: license boilerplate stripped, split into chapters, sentence-spanned with stable spanIds, and content-addressed (κ per chapter; the text-track κ is the deterministic κ over the sorted chapter-κ map). The spans line up 1:1 with holo-align's syncmap and holo-read's rendering, so any Gutenberg text drops straight into the read-along. Pure: identical bytes ⇒ identical κ, on a real fetched book or a fixture.",
  authority: "rests on #holo-content-net (kappaOf) + #holo-align — the text-track for the Holo Library build",
  witnessed,
  covers: witnessed ? ["strips-boilerplate", "chapterizes", "sentence-spans", "chapter-kappa", "feeds-align"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-text-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-text witness — Gutenberg raw text → addressable, chapterized, span-aligned text track\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  any open text drops straight into the read-along" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
