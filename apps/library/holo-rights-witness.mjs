#!/usr/bin/env node
// holo-rights-witness.mjs — proves Tier B + Tier C integration and the rights boundary, end to end. This is the
// difference between an index and a pirate, and it must hold in CODE.
//
//   1 ownedReadAlong   — a user's OWN audiobook (Tier B) + an open Gutenberg text (Tier A) merge into one work;
//                        planWork ingests both → a USER_OWNED title that can read along (a Jellyfin audiobook
//                        becomes a read-along, owning the audio, borrowing the public-domain text).
//   2 commercialIndex  — an Audible-like result (Tier C) is metadata-only: planWork marks it NOT ingestable and
//                        surfaces a link-out; assembleFromPlan yields a metadata-only index CARD (no track κ).
//   3 ingestTripwire   — assertIngestAllowed() THROWS on a commercial edition (refuses to pin its bytes).
//   4 sealBackstop     — even if a caller tries, sealing a metadata-only title with an audio κ THROWS.
//   5 mostRestrictive  — a work with BOTH an owned audio and a commercial duplicate ingests the owned copy,
//                        links out the commercial, and the title is USER_OWNED (never pirates the commercial).
//   6 honestLog        — planWork.log names exactly what was ingested vs linked-out (no silent boundary-cross).
//
// node holo-rights-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBookHub } from "./holo-book.mjs";
import { createGutenberg } from "./holo-book-gutenberg.mjs";
import { createOwnedSource } from "./holo-book-owned.mjs";
import { createCommercialCatalog } from "./holo-book-commercial.mjs";
import { planWork, assembleFromPlan, ingestPolicy, assertIngestAllowed } from "./holo-rights.mjs";
import { verifyTitle, RIGHTS, sealTitle } from "./holo-title.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };
const K = (h) => "blake3:" + h.repeat(64).slice(0, 64);

// ── injected sources ────────────────────────────────────────────────────────────────────────────────────────
// Tier B: a Jellyfin-like server the user owns, holding an audiobook of "The Time Machine".
const myServer = { id: "jellyfin-home", name: "My Jellyfin", async search() {
  return [{ id: "tm-1", title: "The Time Machine", authors: ["H. G. Wells"], lang: "en",
    chapters: [{ url: "https://home.lan/audiobooks/tm/01.mp3", sec: 1200, title: "I" }, { url: "https://home.lan/audiobooks/tm/02.mp3", sec: 1300, title: "II" }] }];
} };
// Tier A: Gutenberg text of the same work.
const GB_JSON = { results: [{ id: 35, title: "The Time Machine", languages: ["en"], authors: [{ name: "Wells, H. G. (Herbert George)" }],
  formats: { "text/plain; charset=utf-8": "https://gutenberg.example/35.txt", "image/jpeg": "https://gutenberg.example/35.cover.jpg" } }] };
// Tier C: an Audible-like commercial catalog returning the same title + a buy link (and a different commercial-only book).
const AUD_JSON = { products: [
  { asin: "B001", title: "The Time Machine", authors: [{ name: "H. G. Wells" }], language: "en", cover: "https://audible.example/tm.jpg", buyUrl: "https://audible.example/pd/B001" },
  { asin: "B002", title: "Project Hail Mary", authors: [{ name: "Andy Weir" }], language: "en", cover: "https://audible.example/phm.jpg", buyUrl: "https://audible.example/pd/B002" } ] };

const owned = createOwnedSource({ source: myServer });
const gb = createGutenberg({ fetch: async () => ({ ok: true, status: 200, json: async () => GB_JSON }) });
const audible = createCommercialCatalog({ id: "audible", name: "Audible", fetch: async () => ({ ok: true, status: 200, json: async () => AUD_JSON }), endpoint: (q) => "https://audible.example/search?q=" + encodeURIComponent(q) });

const hub = createBookHub();
hub.register(owned); hub.register(gb); hub.register(audible);
const works = await hub.findWorks("The Time Machine");
const tm = works.find((w) => /time machine/.test(w.key));
const phm = works.find((w) => /hail mary/.test(w.key));

// 1 — owned audio + open text → USER_OWNED read-along
{
  const plan = planWork(tm);
  const title = assembleFromPlan(tm, plan, { audioKappa: K("a"), textKappa: K("b"), syncmapKappa: K("c"), coverKappa: K("d") });
  ok("ownedReadAlong",
    plan.rightsClass === RIGHTS.USER_OWNED && plan.canReadAlong &&
    plan.audio._tier === "owned" && plan.text._tier === "open" &&
    verifyTitle(title) && title.modes.readalong && title.rights.class === RIGHTS.USER_OWNED,
    JSON.stringify({ rights: plan.rightsClass, readalong: plan.canReadAlong, audioTier: plan.audio?._tier }));
}

// 2 — commercial-only work → metadata-only index card with a link-out, no bytes
{
  const plan = planWork(phm);
  const card = assembleFromPlan(phm, plan, { coverKappa: null });
  ok("commercialIndex",
    plan.rightsClass === RIGHTS.METADATA_ONLY && !plan.audio && !plan.text &&
    plan.linkOuts.length === 1 && /audible\.example\/pd\/B002/.test(plan.linkOuts[0].url) &&
    verifyTitle(card) && card.rights.class === RIGHTS.METADATA_ONLY && !card.audio && !card.text &&
    (card.provenance.sources[0] || {}).url === plan.linkOuts[0].url,
    JSON.stringify({ rights: plan.rightsClass, linkOuts: plan.linkOuts.map((l) => l.url) }));
}

// 3 — ingest tripwire on a commercial edition
{
  const commercialEd = phm.meta.find((e) => e._tier === "commercial");
  const openEd = tm.text.find((e) => e._tier === "open");
  let threw = false; try { assertIngestAllowed(commercialEd); } catch (e) { threw = /never ingest|index/.test(e.message); }
  ok("ingestTripwire", threw && ingestPolicy(commercialEd).ingestable === false && ingestPolicy(openEd).ingestable === true);
}

// 4 — seal backstop: a metadata-only title can never be handed a track κ
{
  let threw = false;
  try { sealTitle({ work: { title: "x", authors: [], lang: "en" }, audio: K("a"), rights: { class: RIGHTS.METADATA_ONLY } }); }
  catch (e) { threw = /metadata-only/.test(e.message); }
  ok("sealBackstop", threw);
}

// 5 — most-restrictive: owned audio wins over a commercial duplicate; commercial is linked-out, title USER_OWNED
{
  // tm currently has owned audio + open text; inject a commercial audio-duplicate into the work to test selection
  const tm2 = { ...tm, audio: [...tm.audio, { id: "com:audible:tm", mediaType: "audio", _tier: "commercial", _providerName: "Audible", _trust: 2, title: "The Time Machine", linkOut: "https://audible.example/pd/B001" }] };
  const plan = planWork(tm2);
  ok("mostRestrictive",
    plan.audio._tier === "owned" && plan.rightsClass === RIGHTS.USER_OWNED &&
    plan.linkOuts.some((l) => /B001/.test(l.url)),
    JSON.stringify({ chosen: plan.audio?._providerName, rights: plan.rightsClass }));
}

// 6 — honest log
{
  const plan = planWork(tm);
  const joined = plan.log.join(" | ");
  ok("honestLog", /ingest audio ← My Jellyfin \(owned\)/.test(joined) && /ingest text ← Project Gutenberg \(open\)/.test(joined) && /link-out only ← Audible/.test(joined), joined);
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-rights — Tier B (user-owned) and Tier C (commercial) integration with the ingest boundary enforced in code. A user's own audiobook + an open text merge into a USER_OWNED read-along. Commercial catalogs are metadata-only: planWork refuses to ingest them and surfaces a link-out, assembleFromPlan builds an index card with no track κ, assertIngestAllowed throws before any byte-pin, and the holo-title seal is the backstop. A title's rights class is the most restrictive of its ingested tracks; an owned copy always wins over a commercial duplicate. The log names exactly what was ingested vs linked-out — no silent boundary-crossing. Holo Library is the index, never the pirate.",
  authority: "rests on #holo-title (rights) + #holo-book (tiers) — P4 of the Holo Library build",
  witnessed,
  covers: witnessed ? ["owned-read-along", "commercial-index", "ingest-tripwire", "seal-backstop", "most-restrictive", "honest-log"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-rights-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-rights witness — own what you own, index the rest, never pirate\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  Tier B reads along; Tier C is indexed + linked-out, never ingested" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
