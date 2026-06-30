// holo-xxx-catalog.mjs — the PLANETARY catalogue: turn the open web's metadata DBs (StashDB / ThePornDB) into a
// huge, instantly-explorable wall of κ-addressed INDEX entries. The honest split this whole app rests on:
//   • metadata (title, performers, studio, tags, cover) → imported at scale, instantly browsable. NO bytes.
//   • bytes → never bulk-fetched here; an index entry becomes streamable only when the USER acquires it
//     (holo-xxx-acquire, their machine, their call) or ingests a source they're entitled to (holo-xxx-queue).
// Every entry this module produces is mediaType:"meta" — byte-free by construction (holo-scene-manifest enforces
// it downstream). A planetary index, not a redistributor.
//
// Pure ESM, fetch/paging injected → Node witnesses the scale. Covers stay content-addressable (the importer keeps
// the source URL; pinCover in holo-xxx-config turns it into a /.holo κ on first view — the Lightspeed pattern).

// importCatalog({ fetchPage, pages, perPage, onPage }) → a flat array of meta scenes across `pages` pages.
// fetchPage(pageIndex) → [edition] (the caller wires StashDB/TPDB paging; the StashDB GraphQL `page` arg). A page
// that errors is skipped (the import never aborts on one bad page). Dedups by id so overlapping pages don't double.
export async function importCatalog({ fetchPage, pages = 10, onPage = null } = {}) {
  if (typeof fetchPage !== "function") throw new Error("holo-xxx-catalog: fetchPage(page) required");
  const out = [], seen = new Set();
  for (let p = 0; p < pages; p++) {
    let batch = [];
    try { batch = (await fetchPage(p)) || []; } catch { batch = []; }
    for (const ed of batch) {
      const id = ed.id || (ed.title + ":" + (ed.date || ""));
      if (seen.has(id)) continue; seen.add(id);
      out.push({ ...ed, mediaType: "meta" });                 // byte-free by construction (an index entry)
    }
    if (onPage) onPage(p, out.length);
    if (!batch.length) break;                                  // ran past the last page
  }
  return out;
}

// ── offline demo: synthesize a HUGE, varied catalogue so the wall is real without a key or a network. Deterministic
// (seeded by index — no Math.random, which the runtime forbids), wide category spread so the facets look planetary. ─
const STUDIOS = ["Aurora Films", "Velvet Reel", "Noir House", "Open Catalogue", "Skyline", "Lumen", "Cobalt", "Ember", "Atlas", "Indigo"];
const TAGS = ["4K", "60fps", "HD", "Solo", "Couple", "Group", "POV", "Vintage", "Amateur", "Studio", "Cinematic", "Outdoor", "Story", "Behind the Scenes", "VR", "Compilation", "Classic", "Documentary", "Short", "Feature"];
const FIRST = ["Aria", "Bella", "Cleo", "Dara", "Eve", "Faye", "Gia", "Hana", "Iris", "Juno", "Kira", "Lena", "Mara", "Nyx", "Opal", "Pia", "Quinn", "Rae", "Sol", "Tess"];
const WORDS = ["Midnight", "Velvet", "Golden", "Crimson", "Silent", "Electric", "Paper", "Glass", "Neon", "Wild", "Slow", "Bright", "Hidden", "Lost", "First", "Last", "Open", "Secret", "Distant", "Quiet"];
const NOUNS = ["Hours", "Tide", "Garden", "Rooms", "Light", "Summer", "Letters", "Mirage", "Echoes", "Drift", "Bloom", "Static", "Harbor", "Embers", "Signal", "Horizon", "Current", "Reverie", "Vesper", "Lantern"];
const PLACES = ["Lisbon", "the North", "Room 9", "the Coast", "Marfa", "Kyoto", "the Pier", "Dusk", "the Loft", "Berlin", "the Dunes", "Vega", "the Attic", "Soho", "the Bay", "Oslo", "the Hills", "Noon", "the Wire", "Mars"];
const pick = (arr, n) => arr[n % arr.length];

export function generateDemoCatalog(n = 1500) {
  const scenes = [];
  for (let i = 0; i < n; i++) {
    // three axes (word × noun × place) → ~8k unique titles, so n entries stay mostly distinct after sceneKey dedup.
    const base = `${pick(WORDS, i * 7 + 1)} ${pick(NOUNS, i * 13 + 3)}`;
    const title = i % 3 === 0 ? `${base} of ${pick(PLACES, i * 5 + 2)}` : i % 3 === 1 ? `${base}, vol. ${1 + (i % 9)}` : base;
    const nperf = 1 + (i % 3);
    const performers = Array.from({ length: nperf }, (_, j) => pick(FIRST, i * 5 + j * 3) + " " + String.fromCharCode(65 + ((i + j) % 26)) + ".");
    const ntags = 3 + (i % 4);
    const tags = Array.from({ length: ntags }, (_, j) => pick(TAGS, i * 3 + j * 7));
    const year = 2015 + (i % 11);
    scenes.push({
      id: "demo:" + i, mediaType: "meta",
      title, performers, studio: pick(STUDIOS, i + (i >> 2)),
      date: `${year}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      tags: [...new Set(tags)], cover: null, duration: 300 + (i % 90) * 30,
    });
  }
  return scenes;
}

export default { importCatalog, generateDemoCatalog };
if (typeof window !== "undefined") window.HoloXxxCatalog = { importCatalog, generateDemoCatalog };
