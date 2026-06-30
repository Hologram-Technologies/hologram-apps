// holo-xxx-aloha.mjs — THE ALOHA ATLAS taxonomy spine. AlohaTube is a pure aggregator whose only real asset is
// its human-curated CATEGORY TAXONOMY (~484 categories at /top/<slug>). We take ONLY that taxonomy — the "shape"
// of the wall — and pour CONTENT into each category from clean source APIs (Eporner et al.) played through the
// native Hologram pipeline. Aloha hosts nothing; we scrape only the public category list (byte-free facts).
//
// fetch is INJECTED (the app passes the DoH-proxy fetch, since aloha is ISP-name-filtered; node-witnessable with a
// mock). parseTaxonomy is pure. The taxonomy is small + stable → cache it as a κ-object and refresh weekly, not
// per-boot. A slug ("big_natural_tits") maps to a source query by underscore→space ("big natural tits").

const ALOHA_HOME = "https://www.alohatube.com/";

// parseTaxonomy(html) → [{ slug, label }] — read the <a href="/top/<slug>">Label</a> category links. Deduped by
// slug, label trimmed. Skips the meta rows (top/new) and combo subcategories are kept (they ARE categories).
export function parseTaxonomy(html) {
  const out = [], seen = new Set();
  const re = /<a\s+href="\/top\/([a-z0-9_]+)"[^>]*>([^<]{1,40})/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const slug = m[1], label = m[2].trim();
    if (!slug || slug === "top" || slug === "new" || seen.has(slug)) continue;
    if (!label || /^\s*$/.test(label)) continue;
    seen.add(slug);
    out.push({ slug, label });
  }
  return out;
}

// slug → a source search query. AlohaTube slugs are underscore-joined words; Eporner's query is plain text.
export const slugToQuery = (slug) => String(slug || "").replace(/_/g, " ").trim();

// fetchTaxonomy({ fetch, cache }) → [{ slug, label, query }] — fetch the aloha homepage through the injected
// (DoH-proxy) fetch, parse, attach the source query. `cache` (optional, the createKappaCache shape) memoizes the
// raw HTML so a repeat call is instant + origin-free (the Lightspeed pattern; the taxonomy is a public fact).
export async function fetchTaxonomy({ fetch: f, cache = null, home = ALOHA_HOME } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) return [];
  let html = "";
  try {
    if (cache) { const { body } = await cache.through("aloha:taxonomy", async () => (await doFetch(home)).text()); html = body; }
    else html = await (await doFetch(home)).text();
  } catch { return []; }
  return parseTaxonomy(html).map((c) => ({ ...c, query: slugToQuery(c.slug) }));
}

// a curated front-of-house ordering: the broad, populous categories first so the wall opens strong, then the long
// tail alphabetically. Pass the parsed taxonomy; returns it reordered (pure, no fetch).
const HEADLINE = ["amateur", "milf", "teen", "anal", "asian", "lesbian", "threesome", "mature", "big_ass", "bbc", "creampie", "pov", "ebony", "latina", "japanese", "hardcore", "blowjob", "interracial", "vintage", "webcam"];
export function orderForWall(cats) {
  const by = new Map(cats.map((c) => [c.slug, c]));
  const head = HEADLINE.map((s) => by.get(s)).filter(Boolean);
  const headSet = new Set(head.map((c) => c.slug));
  const tail = cats.filter((c) => !headSet.has(c.slug)).sort((a, b) => a.label.localeCompare(b.label));
  return [...head, ...tail];
}

// ── INTENT BROWSE (P7 M7.2): "say what you're in the mood for". A free-text intent ("slow intimate asian", "amateur
// pov no talking") collapses the 443-category Atlas into a BESPOKE wall — the categories whose words overlap the
// intent, ranked by overlap. Pure (no fetch, no model) → instant + node-witnessable. MOOD synonyms map soft intent
// words to category vocabulary so "intimate"/"slow" reach the right rails. This is the magic: one sentence → a wall.
const STOP = new Set(["a", "an", "the", "and", "or", "of", "with", "no", "some", "something", "me", "i", "want", "show", "for", "in", "on", "to"]);
const MOOD = { intimate: ["sensual", "passionate", "romantic", "couple", "softcore"], slow: ["sensual", "passionate", "softcore"], quick: ["quickie", "amateur"], rough: ["hardcore", "bdsm", "rough"], fantasy: ["cosplay", "roleplay", "fantasy"], talking: ["joi", "dirty_talk"] };
const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

// matchCategories(intent, cats, n) → the categories whose label/slug/query words best overlap the intent, scored +
// MOOD-synonym expanded. Empty intent → []. A category matching MORE intent words ranks higher; an exact whole-word
// label/slug match gets a bonus so "asian" beats "busty asian" when the intent is just "asian".
export function matchCategories(intent, cats, n = 24) {
  const want = words(intent);
  if (!want.length) return [];
  const expanded = new Set(want);
  for (const w of want) for (const syn of MOOD[w] || []) expanded.add(syn);
  const score = (c) => {
    const cw = new Set([...words(c.label), ...words(c.slug), ...words(c.query)]);
    let s = 0; for (const w of expanded) if (cw.has(w)) s += 1;
    if (want.length === 1 && (c.slug === want[0] || cw.size === 1 && cw.has(want[0]))) s += 2;   // exact single-word
    return s;
  };
  return (cats || []).map((c) => ({ ...c, score: score(c) })).filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.label.length - b.label.length).slice(0, n);
}

export default { parseTaxonomy, slugToQuery, fetchTaxonomy, orderForWall, matchCategories };
if (typeof window !== "undefined") window.HoloXxxAloha = { parseTaxonomy, slugToQuery, fetchTaxonomy, orderForWall, matchCategories };
