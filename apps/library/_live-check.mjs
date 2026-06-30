#!/usr/bin/env node
// _live-check.mjs — NOT a deterministic witness (needs network). Validates the Tier-A adapters against the REAL
// public APIs and proves the hub merges real LibriVox + Gutenberg + Open Library responses into one work.
// node _live-check.mjs
import { createBookHub, manufacturable } from "./holo-book.mjs";
import { createLibriVox } from "./holo-book-librivox.mjs";
import { createGutenberg } from "./holo-book-gutenberg.mjs";
import { createOpenLibrary } from "./holo-book-openlibrary.mjs";

const f = (...a) => fetch(...a);
const lv = createLibriVox({ fetch: f }), gb = createGutenberg({ fetch: f }), ol = createOpenLibrary({ fetch: f });
const log = (...a) => console.log(...a);

for (const [name, p, q] of [["LibriVox", lv, "Frankenstein"], ["Gutenberg", gb, "Frankenstein Shelley"], ["Open Library", ol, "Frankenstein Shelley"]]) {
  try { const r = await p.search(q); log(`\n${name}: ${r.length} hits`); if (r[0]) log(`  ↳ "${r[0].title}" — ${(r[0].authors || []).join(", ")} [${r[0].mediaType}]${r[0].textUrl ? " text:" + r[0].textUrl : ""}${r[0].cover ? " cover:✓" : ""}${r[0]._sections ? " sections:" + r[0]._sections.length : ""}`); }
  catch (e) { log(`\n${name}: FAIL ${e.message}`); }
}

const hub = createBookHub();
hub.register(lv); hub.register(gb); hub.register(ol);
const works = await hub.findWorks("Frankenstein");
log(`\n── hub.findWorks("Frankenstein") → ${works.length} works ──`);
const top = works.slice(0, 5);
for (const w of top) log(`  ${manufacturable(w) ? "★" : " "} "${w.title}" — audio:${w.audio.length} text:${w.text.length} meta:${w.meta.length} cover:${w.cover ? "✓" : "✗"} sources:[${w.sources.join(", ")}]`);
const frank = works.find((w) => manufacturable(w) && /frankenstein/i.test(w.title));
log(`\nMANUFACTURABLE Frankenstein work: ${frank ? "YES — audio+text both present, ready to align" : "no (audio/text not both found in top results)"}`);
if (frank) log(`  audio ← ${frank.audio[0]?._providerName}, text ← ${frank.text[0]?._providerName} (${frank.text[0]?.textUrl})`);
