// Node witness for the Taste Console vector core. Run: node holo-xxx-taste-console-witness.mjs
import { AXES, featureOf, scoreScene, rerankPool, blendVector, standingFromAffinity, axesFor } from "./holo-xxx-taste-console.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };
const eq = (name, a, b) => ok(name + " (" + JSON.stringify(a) + " == " + JSON.stringify(b) + ")", JSON.stringify(a) === JSON.stringify(b));

// ── ORTHOGONALITY: no word may appear in more than one axis (so dials never move together) ────────────────────────
const seen = new Map(); let collisions = [];
for (const ax of AXES) for (const w of [...ax.lowTags, ...ax.highTags]) {
  if (seen.has(w)) collisions.push(`${w} (${seen.get(w)} & ${ax.key})`); else seen.set(w, ax.key);
}
ok("axis vocabularies are DISJOINT (no overlap)" + (collisions.length ? " — " + collisions.join(", ") : ""), collisions.length === 0);
ok("8 distinct axes", AXES.length === 8 && new Set(AXES.map((a) => a.key)).size === 8);
ok("every non-novelty axis has both poles populated", AXES.filter((a) => a.key !== "novelty").every((a) => a.lowTags.length && a.highTags.length));

// ── fixtures spanning the poles ──────────────────────────────────────────────────────────────────────────────
const POOL = [
  { id: "a", title: "Romantic gentle lovemaking, slow and sensual", tags: ["romantic", "gentle", "slow", "sensual"] },
  { id: "b", title: "Rough intense hardcore pounding", tags: ["rough", "intense", "hardcore"] },
  { id: "c", title: "Solo toys masturbation", tags: ["solo", "toys"] },
  { id: "d", title: "Group orgy party", tags: ["group", "orgy"] },
  { id: "e", title: "Femdom mistress domination", tags: ["femdom", "domination"] },
  { id: "f", title: "Kinky latex bondage fetish", tags: ["latex", "bondage", "fetish"] },
  { id: "g", title: "Amateur homemade real pov", tags: ["amateur", "homemade", "pov"] },
  { id: "h", title: "Cinematic glamour studio", tags: ["cinematic", "glamour", "studio"] },
  { id: "z", title: "Just a clip", tags: [] },                       // no signal → never moves on its own
];
const idsOf = (arr) => arr.map((x) => x.id).join("");
const top = (arr) => arr[0].id;

// ── featureOf ────────────────────────────────────────────────────────────────────────────────────────────────
const fa = featureOf(POOL[0]);
ok("featureOf extracts tags", fa.tags.has("romantic") && fa.tags.has("gentle"));
ok("featureOf drops stopwords", !fa.tags.has("and") && !fa.tags.has("the"));
ok("featureOf empty scene safe", featureOf(null).n === 0);
ok("featureOf includes __cat", featureOf({ __cat: "sensual-massage" }).tags.has("massage"));

// ── each axis independently re-ranks toward its pole ─────────────────────────────────────────────────────────
ok("Intensity−2 (Gentle) → gentle scene first", top(rerankPool(POOL, { intensity: -2 })) === "a");
ok("Intensity+2 (Intense) → rough scene first", top(rerankPool(POOL, { intensity: 2 })) === "b");
ok("Connection−2 (Romantic) → romantic scene first", top(rerankPool(POOL, { connection: -2 })) === "a");
ok("Pace−2 (Slow) → slow scene first", top(rerankPool(POOL, { pace: -2 })) === "a");
ok("Power+2 (Dominant) → femdom scene first", top(rerankPool(POOL, { power: 2 })) === "e");
ok("Company+2 (Group) → group scene first", top(rerankPool(POOL, { company: 2 })) === "d");
ok("Company−2 (Solo) → solo scene first", top(rerankPool(POOL, { company: -2 })) === "c");
ok("Kink+2 (Kinky) → fetish scene first", top(rerankPool(POOL, { kink: 2 })) === "f");
ok("Aesthetic−2 (Amateur) → amateur scene first", top(rerankPool(POOL, { aesthetic: -2 })) === "g");
ok("Aesthetic+2 (Cinematic) → cinematic scene first", top(rerankPool(POOL, { aesthetic: 2 })) === "h");

// ── independence: nudging one axis does NOT reorder by another's signal ───────────────────────────────────────
// power nudge should not move the kink-only scene 'f' to the very top, and kink nudge should not surface femdom 'e' top.
ok("Power nudge does not top-rank the kink-only scene", top(rerankPool(POOL, { power: 2 })) !== "f");
ok("Kink nudge does not top-rank the power-only scene", top(rerankPool(POOL, { kink: 2 })) !== "e");

// ── degree scales; no-axis identity; unsignaled stays put ────────────────────────────────────────────────────
ok("score scales with degree", scoreScene(featureOf(POOL[1]), { intensity: 2 }) > scoreScene(featureOf(POOL[1]), { intensity: 1 }));
ok("no axis set → score 0", scoreScene(featureOf(POOL[1]), {}) === 0);
ok("unsignaled scene scores 0 under any nudge", scoreScene(featureOf(POOL[8]), { intensity: 2, power: -2, kink: 2 }) === 0);
eq("no active axis → identity order", idsOf(rerankPool(POOL, {})), idsOf(POOL));
ok("rerank is pure (input unchanged)", idsOf(POOL) === "abcdefghz");
ok("empty pool safe", rerankPool([], { intensity: 2 }).length === 0);

// ── multi-axis: simultaneous dimensions compose ──────────────────────────────────────────────────────────────
const multi = rerankPool(POOL, { intensity: -2, connection: -2, pace: -2 });
ok("multi-axis: gentle+romantic+slow scene wins", top(multi) === "a");
const multi2 = rerankPool(POOL, { company: 2, kink: 1 });
ok("multi-axis: group ranks above solo when steering Group+Kinky", multi2.indexOf(multi2.find((x) => x.id === "d")) < multi2.indexOf(multi2.find((x) => x.id === "c")));

// ── novelty / discovery ──────────────────────────────────────────────────────────────────────────────────────
const aff = { "#rough": 5, "#hardcore": 5 };   // user historically likes rough/hardcore
const surprising = rerankPool(POOL, { novelty: 2 }, { affinity: aff });
const familiarOrd = rerankPool(POOL, { novelty: -2 }, { affinity: aff });
ok("Surprising deprioritizes the user's familiar (rough) scene vs Familiar", surprising.indexOf(surprising.find((x) => x.id === "b")) > familiarOrd.indexOf(familiarOrd.find((x) => x.id === "b")));

// ── blendVector ──────────────────────────────────────────────────────────────────────────────────────────────
const bv = blendVector({ intensity: 2 }, { intensity: 1 });
ok("blend clamps to ±2", blendVector({ intensity: 2 }, { intensity: 2 }).intensity === 2);
ok("blend: session-only works", blendVector({}, { company: -1 }).company === -1);
ok("blend covers every axis", AXES.every((ax) => ax.key in bv));

// ── standingFromAffinity ─────────────────────────────────────────────────────────────────────────────────────
ok("standing: rough affinity → +intensity pole", (standingFromAffinity({ "#rough": 4 }).intensity || 0) > 0);
ok("standing: gentle affinity → −intensity pole", (standingFromAffinity({ "#sensual": 4, "#gentle": 2 }).intensity || 0) < 0);
ok("standing: femdom affinity → +power pole", (standingFromAffinity({ "#femdom": 3 }).power || 0) > 0);
ok("standing bounded ±1", Object.values(standingFromAffinity({ "#rough": 999 })).every((v) => Math.abs(v) <= 1));
ok("standing: no signal → empty", Object.keys(standingFromAffinity({})).length === 0);

// ── axesFor (adaptive) ───────────────────────────────────────────────────────────────────────────────────────
ok("axesFor(group) leads with company", axesFor("group", 5)[0].key === "company");
ok("axesFor(asmr) leads with pace", axesFor("asmr", 5)[0].key === "pace");
ok("axesFor(bdsm) leads with power", axesFor("bdsm", 5)[0].key === "power");
ok("axesFor(fetish) leads with kink", axesFor("fetish", 5)[0].key === "kink");
ok("axesFor differs by domain", JSON.stringify(axesFor("group", 5).map((a) => a.key)) !== JSON.stringify(axesFor("bdsm", 5).map((a) => a.key)));
ok("axesFor returns n axes", axesFor("anything", 5).length === 5);
ok("axesFor pads unknown query with canonical axes", axesFor("zzz", 5).length === 5);
ok("axesFor returns axis objects (have low/high)", axesFor("group", 1)[0].low && axesFor("group", 1)[0].high);

console.log(`\nTaste Console witness: ${pass}/${pass + fail} passed` + (fail ? `  (${fail} FAILED)` : "  ALL PASS"));
process.exit(fail ? 1 : 0);
