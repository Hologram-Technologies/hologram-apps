// Node witness for the Holo Flow engine. Run: node holo-xxx-flow-witness.mjs
import { createFlow, reactionWeight } from "./holo-xxx-flow.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

const POOL = [
  { id: "gentle1", title: "Sensual gentle romantic", tags: ["sensual", "gentle", "romantic"] },
  { id: "gentle2", title: "Soft intimate lovemaking", tags: ["soft", "intimate", "passionate"] },
  { id: "rough1", title: "Rough hardcore intense", tags: ["rough", "hardcore", "intense"] },
  { id: "rough2", title: "Brutal pounding", tags: ["brutal", "pounding"] },
  { id: "group1", title: "Group orgy party", tags: ["group", "orgy"] },
  { id: "solo1", title: "Solo toys", tags: ["solo", "toys"] },
];

// ── reactionWeight ───────────────────────────────────────────────────────────────────────────────────────────
ok("more is strongly positive", reactionWeight("more") > 1.5);
ok("less is strongly negative", reactionWeight("less") < -1.5);
ok("complete positive", reactionWeight("complete") > 0);
ok("instant skip more negative than late skip", reactionWeight("skip", 1000, 60) < reactionWeight("skip", 50000, 60));
ok("near-complete skip ≈ neutral", Math.abs(reactionWeight("skip", 58000, 60)) < 0.2);

// ── ranking honors the vector ────────────────────────────────────────────────────────────────────────────────
{
  const f = createFlow({ pool: POOL, vector: { intensity: 2 } });   // steer Intense
  ok("Intense vector → first pick is a rough scene", f.next().id.startsWith("rough"));
}
{
  const f = createFlow({ pool: POOL, vector: { intensity: -2 } });  // steer Gentle
  ok("Gentle vector → first pick is a gentle scene", f.next().id.startsWith("gentle"));
}
{
  const f = createFlow({ pool: POOL, vector: { company: 2 } });
  ok("Group vector → first pick is the group scene", f.next().id === "group1");
}

// ── no immediate repeats; full coverage before reuse ─────────────────────────────────────────────────────────
{
  const f = createFlow({ pool: POOL, vector: {} });
  const seen = []; for (let i = 0; i < POOL.length; i++) { const s = f.next(); seen.push(s.id); }
  ok("serves every scene once before repeating", new Set(seen).size === POOL.length);
  const next = f.next();                                            // pool exhausted → must LOOP, not return null
  ok("loops endlessly (never returns null when pool non-empty)", !!next);
  ok("loop does not immediately repeat the most recent", next.id !== seen[seen.length - 1]);
}

// ── peek mirrors upcoming picks (for pre-resolve) ────────────────────────────────────────────────────────────
{
  const f = createFlow({ pool: POOL, vector: { intensity: 2 } });
  const peeked = f.peek(2).map((s) => s.id);
  const a = f.next().id;
  ok("peek[0] equals the next served scene", peeked[0] === a);
}

// ── reactions move the vector the right way ──────────────────────────────────────────────────────────────────
{
  const f = createFlow({ pool: POOL, vector: {} });
  f.react({ type: "more", scene: POOL[2] });                       // love a ROUGH scene
  ok("liking rough pushes intensity positive", f.vector().intensity > 0);
  const f2 = createFlow({ pool: POOL, vector: {} });
  f2.react({ type: "less", scene: POOL[2] });                      // dislike a rough scene
  ok("disliking rough pushes intensity negative", f2.vector().intensity < 0);
  const f3 = createFlow({ pool: POOL, vector: {} });
  f3.react({ type: "more", scene: POOL[0] });                      // love a GENTLE scene
  ok("liking gentle pushes intensity negative", f3.vector().intensity < 0);
}

// ── reactions actually change what plays next ────────────────────────────────────────────────────────────────
{
  const f = createFlow({ pool: POOL, vector: {} });
  for (let i = 0; i < 4; i++) f.react({ type: "more", scene: POOL[2] });   // repeatedly love rough
  const g = createFlow({ pool: POOL, vector: {} });
  g.retune(f.vector());
  ok("learned taste steers the next pick toward rough", g.next().id.startsWith("rough"));
}

// ── refill / addToPool ───────────────────────────────────────────────────────────────────────────────────────
{
  const f = createFlow({ pool: POOL.slice(0, 5), vector: {}, refillAt: 3 });
  ok("not needing refill when pool is full", f.needsRefill() === false);
  f.next(); f.next(); f.next();                                    // 2 unplayed left (<3)
  ok("needs refill once unplayed drops below threshold", f.needsRefill() === true);
  const added = f.addToPool([{ id: "new1", title: "Fresh", tags: [] }, POOL[0]]);
  ok("addToPool dedups (only the genuinely new one added)", added === 1);
}

// ── retune ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const f = createFlow({ pool: POOL, vector: { intensity: -2 } });
  f.retune({ intensity: 2 });
  ok("retune re-aims the queue", f.next().id.startsWith("rough"));
}

console.log(`\nHolo Flow witness: ${pass}/${pass + fail} passed` + (fail ? `  (${fail} FAILED)` : "  ALL PASS"));
process.exit(fail ? 1 : 0);
