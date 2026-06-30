// THE TASTE CONSOLE — a multi-dimensional, on-device taste vector + instant re-rank.
//
// The refine bar used to append ONE word to the query and refetch. This inverts it: refine STEERS a taste vector
// across many continuous bipolar dimensions, and re-ranks an ALREADY-FETCHED candidate pool on-device. A nudge never
// touches the network → sub-frame, "magical" latency. The vector is seeded from the user's on-device taste model
// (byte-free) so a fresh search already feels personal; session nudges adjust away from that center.
//
// Everything here is PURE + node-witnessable: AXES, featureOf, scoreScene, rerankPool, blendVector,
// standingFromAffinity, axesFor. No bytes leave the device; no DOM; no network.

// An ORTHOGONAL basis of taste. Each axis asks a genuinely different question and its low/high vocabularies are
// DISJOINT from every other axis → nudging one dial never drags another. `novelty` is special: it scores against the
// user's affinity (discovery), not tag matching. Degree runs −2..+2.
//   intensity  — how hard?            connection — how much feeling?   pace    — how fast?      power   — who's in control?
//   company    — how many?            kink       — how fetish-specific? aesthetic — how produced? novelty — how adventurous?
export const AXES = [
  { key: "intensity",  low: "Gentle",     high: "Intense",    lowTags: ["gentle", "soft", "sensual", "softcore", "erotic", "tease", "caress", "delicate", "tender"], highTags: ["rough", "hard", "intense", "hardcore", "pounding", "brutal", "deepthroat", "extreme", "savage"] },
  { key: "connection", low: "Romantic",   high: "Carnal",     lowTags: ["romantic", "passionate", "love", "intimate", "lovers", "girlfriend", "affectionate", "cuddle", "devotion"], highTags: ["casual", "anonymous", "hookup", "gonzo", "stranger", "raw", "dirty", "sleazy", "random"] },
  { key: "pace",       low: "Slow",       high: "Fast",       lowTags: ["slow", "edging", "buildup", "gradual", "lingering", "unhurried", "teasing"], highTags: ["fast", "quick", "relentless", "rapid", "frantic", "frenzied", "hurried"] },
  { key: "power",      low: "Submissive", high: "Dominant",   lowTags: ["submissive", "obedient", "bound", "tied", "helpless", "owned", "collared", "spanked", "sub"], highTags: ["dominant", "domination", "femdom", "mistress", "command", "control", "goddess", "dom", "cfnm"] },
  { key: "company",    low: "Solo",       high: "Group",      lowTags: ["solo", "masturbation", "toys", "alone", "self"], highTags: ["group", "threesome", "orgy", "gangbang", "foursome", "party", "swingers", "gang"] },
  { key: "kink",       low: "Vanilla",    high: "Kinky",      lowTags: ["vanilla", "classic", "natural", "straightforward", "conventional"], highTags: ["fetish", "kinky", "bondage", "latex", "leather", "feet", "roleplay", "taboo", "pegging", "bdsm"] },
  { key: "aesthetic",  low: "Amateur",    high: "Cinematic",  lowTags: ["amateur", "homemade", "real", "candid", "leaked", "selfie", "pov", "authentic"], highTags: ["cinematic", "professional", "glamour", "studio", "scripted", "production", "artistic", "polished", "4k"] },
  { key: "novelty",    low: "Familiar",   high: "Surprising", lowTags: [], highTags: [] },   // discovery axis (no tags — uses affinity)
];

const AXIS_BY_KEY = Object.fromEntries(AXES.map((a) => [a.key, a]));
const STOP = new Set(["the", "a", "and", "with", "her", "his", "for", "you", "sex", "video", "scene", "full", "new", "porn", "free", "hd"]);

// featureOf(scene) → { tags:Set<string>, n:number } — cheap sparse features from real metadata (title + tags +
// performers + studio + the category it came from). Lowercased word set, stopwords + short tokens dropped.
export function featureOf(scene) {
  if (!scene) return { tags: new Set(), n: 0 };
  const parts = [];
  if (scene.title) parts.push(scene.title);
  for (const t of (scene.tags || [])) parts.push(t);
  for (const p of (scene.performers || [])) parts.push(p);
  if (scene.studio) parts.push(scene.studio);
  if (scene.__cat) parts.push(String(scene.__cat).replace(/[-_]/g, " "));
  const words = new Set();
  for (const w of parts.join(" ").toLowerCase().split(/[^a-z0-9]+/)) if (w && w.length > 2 && !STOP.has(w)) words.add(w);
  return { tags: words, n: words.size };
}

// scoreScene(features, vector, opts) → number. Per active axis: degree · (highHits − lowHits). The `familiar` axis
// adds degree · (novelty−0.5)·2, where novelty is inverse to how much the user's affinity already covers the tags.
// Higher = better fit to the steered taste. opts.affinity is the byte-free on-device taste map ({key|#tag → score}).
export function scoreScene(features, vector, opts = {}) {
  if (!features || !vector) return 0;
  const aff = opts.affinity || {};
  let s = 0;
  for (const ax of AXES) {
    const d = vector[ax.key] || 0; if (!d) continue;
    if (ax.key === "novelty") {
      let known = 0, n = 0;
      for (const w of features.tags) { known += (aff["#" + w] || 0) + (aff[w] || 0); n++; }
      const novelty = n ? 1 / (1 + known) : 0.5;
      s += d * (novelty - 0.5) * 2;
      continue;
    }
    let hi = 0, lo = 0;
    for (const w of ax.highTags) if (features.tags.has(w)) hi++;
    for (const w of ax.lowTags) if (features.tags.has(w)) lo++;
    s += d * (hi - lo);
  }
  return s;
}

// rerankPool(pool, vector, opts) → a NEW array sorted by score desc, stable (original order is the tiebreak so
// unscored scenes keep their relative position). No active axis → a shallow copy (identity order). O(n·tags), <2ms/200.
export function rerankPool(pool, vector, opts = {}) {
  if (!pool || !pool.length) return pool || [];
  const active = AXES.some((ax) => vector && vector[ax.key]);
  if (!active) return pool.slice();
  // memoize features on the scene (they never change) → re-rank stays cheap across repeated nudges on a large pool
  const scored = pool.map((scene, i) => ({ scene, i, sc: scoreScene(scene.__feat || (scene.__feat = featureOf(scene)), vector, opts) }));
  scored.sort((a, b) => (b.sc - a.sc) || (a.i - b.i));
  return scored.map((x) => x.scene);
}

const clamp2 = (v) => Math.max(-2, Math.min(2, Math.round(v * 100) / 100));

// blendVector(standing, session) → clamped [-2..2] merged vector. Session nudges dominate; standing taste is a
// gentle bias (half weight) so a search feels personal before the user touches anything.
export function blendVector(standing = {}, session = {}) {
  const out = {};
  for (const ax of AXES) out[ax.key] = clamp2((standing[ax.key] || 0) * 0.5 + (session[ax.key] || 0));
  return out;
}

// standingFromAffinity(affinity) → a gentle (±1) vector inferred from the on-device taste model: which pole of each
// axis the user gravitates toward, normalized by the axis's total signal.
export function standingFromAffinity(aff = {}) {
  const v = {};
  for (const ax of AXES) {
    if (ax.key === "novelty") continue;
    let hi = 0, lo = 0;
    for (const w of ax.highTags) hi += (aff["#" + w] || 0) + (aff[w] || 0);
    for (const w of ax.lowTags) lo += (aff["#" + w] || 0) + (aff[w] || 0);
    const net = hi - lo, mag = hi + lo;
    if (mag > 0) v[ax.key] = Math.max(-1, Math.min(1, net / mag));
  }
  return v;
}

// axesFor(query, n) → the most relevant axes for a query domain (keyword heuristic; Q can refine later). Always
// returns canonical AXES objects, deduped, padded to n in canonical order.
const DOMAIN_HINTS = {
  group: ["company", "intensity", "kink"], threesome: ["company", "intensity", "connection"], orgy: ["company", "intensity", "kink"],
  asmr: ["pace", "intensity", "connection"], sensual: ["connection", "intensity", "pace"], romantic: ["connection", "pace", "intensity"],
  bdsm: ["power", "kink", "intensity"], bondage: ["kink", "power", "intensity"], fetish: ["kink", "intensity", "aesthetic"],
  femdom: ["power", "intensity", "kink"], solo: ["company", "intensity", "aesthetic"], vr: ["aesthetic", "kink", "company"],
  pov: ["aesthetic", "connection", "company"], massage: ["connection", "pace", "intensity"], amateur: ["aesthetic", "connection", "intensity"],
  lesbian: ["connection", "intensity", "pace"], teen: ["aesthetic", "connection", "intensity"], milf: ["intensity", "power", "connection"],
};
export function axesFor(query, n = 5) {
  const q = (query || "").toLowerCase();
  const picked = [];
  for (const k in DOMAIN_HINTS) if (q.includes(k)) for (const ax of DOMAIN_HINTS[k]) if (!picked.includes(ax)) picked.push(ax);
  for (const ax of AXES) { if (picked.length >= n) break; if (!picked.includes(ax.key)) picked.push(ax.key); }
  return picked.slice(0, n).map((k) => AXIS_BY_KEY[k]);
}

export default { AXES, featureOf, scoreScene, rerankPool, blendVector, standingFromAffinity, axesFor };
if (typeof window !== "undefined") window.HoloTasteConsole = { AXES, featureOf, scoreScene, rerankPool, blendVector, standingFromAffinity, axesFor };
