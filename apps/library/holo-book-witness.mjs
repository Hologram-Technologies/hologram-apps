#!/usr/bin/env node
// holo-book-witness.mjs — proves the heart of Holo Library's discovery: a work's audio and text live in
// DIFFERENT open libraries, and the hub MERGES them into one work, then assembles a synced holo-title — with
// NO publisher and NO manual authoring. Uses injected (canned) fetch so the federation is witnessed in Node.
//
//   1 librivoxAudio    — LibriVox normalizes to an audio edition (chapters resolvable).
//   2 gutenbergText    — Gutenberg normalizes to a text edition with a plain-text locator.
//   3 openlibraryMeta  — Open Library contributes metadata + a cover, mediaType "meta" (never playable).
//   4 worksMerge       — all three "Frankenstein / Shelley" editions collapse to ONE work (audio+text+cover);
//                        an unrelated book stays a separate work; manufacturable work sorts first.
//   5 assembleTitle    — the merged work → a sealed public-domain holo-title that verifies, with provenance
//                        naming BOTH source libraries and a cover.
//
// node holo-book-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBookHub, assembleTitle, manufacturable, workKey } from "./holo-book.mjs";
import { createLibriVox } from "./holo-book-librivox.mjs";
import { createGutenberg } from "./holo-book-gutenberg.mjs";
import { createOpenLibrary } from "./holo-book-openlibrary.mjs";
import { verifyTitle, RIGHTS } from "./holo-title.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };

// ── canned API payloads (the three libraries, all returning a Frankenstein edition by Mary Shelley) ─────────
const LV_JSON = { books: [{ id: 59, title: "Frankenstein", language: "English",
  authors: [{ first_name: "Mary Wollstonecraft", last_name: "Shelley" }],
  url_iarchive: "https://archive.org/details/frankenstein_shelley_librivox",
  sections: [{ title: "Letter 1", listen_url: "https://ia.example/ch01.mp3", playtime: "600" }, { title: "Chapter 1", listen_url: "https://ia.example/ch02.mp3", playtime: "720" }] }] };
const GB_JSON = { results: [{ id: 84, title: "Frankenstein; Or, The Modern Prometheus", languages: ["en"],
  authors: [{ name: "Shelley, Mary Wollstonecraft" }],
  formats: { "text/plain; charset=utf-8": "https://gutenberg.example/84.txt", "image/jpeg": "https://gutenberg.example/84.cover.jpg" } }] };
const OL_JSON = { docs: [{ key: "/works/OL450063W", title: "Frankenstein", author_name: ["Mary Shelley"], first_publish_year: 1818, cover_i: 12345, language: ["eng"] },
  { key: "/works/OL999W", title: "Dracula", author_name: ["Bram Stoker"], first_publish_year: 1897, cover_i: 67890, language: ["eng"] }] };

const lvFetch = async () => ({ ok: true, status: 200, json: async () => LV_JSON });
const gbFetch = async () => ({ ok: true, status: 200, json: async () => GB_JSON });
const olFetch = async () => ({ ok: true, status: 200, json: async () => OL_JSON });

const lv = createLibriVox({ fetch: lvFetch });
const gb = createGutenberg({ fetch: gbFetch });
const ol = createOpenLibrary({ fetch: olFetch });

// 1
{ const eds = await lv.search("Frankenstein"); const e = eds[0];
  ok("librivoxAudio", e && e.mediaType === "audio" && e.title === "Frankenstein" && e.authors[0] === "Mary Wollstonecraft Shelley" && e._sections.length === 2, JSON.stringify(e && { mt: e.mediaType, a: e.authors })); }
// 2
{ const eds = await gb.search("Frankenstein Shelley"); const e = eds[0];
  ok("gutenbergText", e && e.mediaType === "text" && /84\.txt$/.test(e.textUrl) && e.authors[0] === "Shelley, Mary Wollstonecraft", JSON.stringify(e && { mt: e.mediaType, url: e.textUrl })); }
// 3
{ const eds = await ol.search("Frankenstein"); const e = eds[0];
  ok("openlibraryMeta", e && e.mediaType === "meta" && e.year === 1818 && /12345-L\.jpg$/.test(e.cover) && !e.textUrl, JSON.stringify(e && { mt: e.mediaType, cover: e.cover })); }

// 4 — the merge
const hub = createBookHub();
hub.register(lv); hub.register(gb); hub.register(ol);
const works = await hub.findWorks("Frankenstein");
{
  const frank = works.find((w) => /frankenstein/.test(w.key));
  const dracula = works.find((w) => /dracula/.test(w.key));
  ok("worksMerge",
    frank && frank.audio.length === 1 && frank.text.length === 1 && frank.meta.length === 1 &&
    /12345-L\.jpg$/.test(frank.cover || "") && frank.sources.length === 3 &&
    manufacturable(frank) === 1 && works[0] === frank &&        // manufacturable work sorts first
    dracula && manufacturable(dracula) === 0,                    // unrelated book stays separate, not manufacturable
    JSON.stringify({ workCount: works.length, frankKey: frank && frank.key, sources: frank && frank.sources }));
}

// 5 — assemble a synced title from the merged work (κ values stand in for runtime-pinned bytes)
{
  const frank = works[0];
  const K = (h) => "blake3:" + h.repeat(64).slice(0, 64);
  const title = assembleTitle(frank, {
    audioEdition: frank.audio[0], textEdition: frank.text[0],
    audioKappa: K("a"), textKappa: K("b"), syncmapKappa: K("c"), coverKappa: K("d"),
  });
  const libs = (title.provenance.sources || []).map((s) => s.library);
  ok("assembleTitle",
    verifyTitle(title) && title.rights.class === RIGHTS.PUBLIC_DOMAIN && title.modes.readalong &&
    libs.includes("LibriVox") && libs.includes("Project Gutenberg") && title.work.cover === K("d") &&
    title.provenance.derived === true,
    JSON.stringify({ kappa: title.kappa.slice(0, 22), libs, modes: title.modes }));
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-book — Holo Library's discovery merges a work's tracks across DIFFERENT open libraries: LibriVox (audio) + Project Gutenberg (text) + Open Library (metadata/cover) collapse, by a normalized work key, into ONE work. A manufacturable work (audio AND text present) sorts first and assembles into a sealed public-domain holo-title — no publisher, no manual authoring. The open web is the catalog.",
  authority: "rests on #holo-source (SourceProvider federation pattern) + #holo-title — P1 of the Holo Library build",
  witnessed,
  covers: witnessed ? ["librivox-audio", "gutenberg-text", "openlibrary-meta", "works-merge", "assemble-title"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-book-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-book witness — audio + text from different open libraries → one owned, synced work\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  the open web is the catalog; a title is auto-manufactured from it" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
