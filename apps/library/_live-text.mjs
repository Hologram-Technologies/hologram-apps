#!/usr/bin/env node
// _live-text.mjs — NOT a witness (needs network). Fetches the REAL Frankenstein (Gutenberg id 84), runs it
// through holo-text, and proves the addressable text track is real: chapter count, first/last sentence, κ.
// node _live-text.mjs
import { toTextDAG, chapterRefText } from "./holo-text.mjs";

const URL = "https://www.gutenberg.org/ebooks/84.txt.utf-8";
const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 45000);
const r = await fetch(URL, { signal: ctrl.signal }); clearTimeout(to);
const raw = await r.text();
console.log(`fetched ${URL} — ${raw.length.toLocaleString()} chars, status ${r.status}`);

const dag = toTextDAG(raw, { bookId: "fr84" });
console.log(`\ntext DAG: ${dag.chapters.length} chapters, ${dag.words.toLocaleString()} words`);
console.log(`text-track κ: ${dag.kappa}`);
console.log(`\nchapter titles (first 8):`);
dag.chapters.slice(0, 8).forEach((c, i) => console.log(`  [${i}] ${c.title || "(preface)"} — ${c.spans.length} sentences — ${c.kappa.slice(0, 20)}…`));

const c1 = dag.chapters.find((c) => /letter 1/i.test(c.title)) || dag.chapters[1] || dag.chapters[0];
console.log(`\nchapter "${c1.title}" first sentence:\n  "${c1.spans[0]?.text?.slice(0, 140)}…"`);
console.log(`chapter "${c1.title}" ref-text length: ${chapterRefText(dag, dag.chapters.indexOf(c1)).length} chars`);

// sanity: no PG license text leaked into the body
const leaked = dag.chapters.some((c) => c.spans.some((s) => /project gutenberg/i.test(s.text)));
console.log(`\nlicense boilerplate leaked into spans: ${leaked ? "YES (bug)" : "no ✓"}`);
