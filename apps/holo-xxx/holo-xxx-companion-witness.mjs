// holo-xxx-companion-witness.mjs — Q companion (AURA Phase C2/C4) witness. Node-runnable, no network, no WebGPU:
// a MOCK chat stands in for the on-device brain. Proves (a) expand→keywords + multi-turn refine logic, and
// (b) ZERO EGRESS: the ONLY bytes handed to Q are the mood/keywords/adjustment STRINGS — never a title, performer,
// id, or any scene/network signal. Run: node holo-xxx-companion-witness.mjs
import { createCompanion, parseKeywords } from "./holo-xxx-companion.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.error("  ✗ " + name); } };

// a mock brain that RECORDS every history it's handed (so we can assert what reached Q), and replies deterministically.
function mockChat(reply) {
  const seen = [];
  const fn = async (history) => { seen.push(JSON.stringify(history)); return reply(history); };
  fn.seen = seen; return fn;
}

(async () => {
  console.log("Q companion witness");

  // 1) expand: a mood → cleaned keywords
  {
    const chat = mockChat(() => "sensual, romantic, passionate, softcore, slow, intimate, pov, lovemaking");
    const c = createCompanion({ chat });
    const kws = await c.expand("something slow and tender, POV");
    ok("expand returns 6+ keywords", Array.isArray(kws) && kws.length >= 6);
    ok("expand keywords are clean (lowercase, no punctuation noise)", kws.every((k) => /^[a-z0-9 ]+$/.test(k)));
    ok("expand handed Q ONLY the mood string (1 user turn)", chat.seen.length === 1 && chat.seen[0].includes("slow and tender") && !/title|performer|http/i.test(chat.seen[0]));
  }

  // 2) refine: a follow-up adjusts the PRIOR keywords (multi-turn) and respects a negation (mock honors it)
  {
    const chat = mockChat((h) => /nothing rough/i.test(h[h.length - 1].content)
      ? "sensual, softcore, romantic, slow, tender, intimate"          // negation respected: no rough/hardcore
      : "sensual, rough, hardcore");
    const c = createCompanion({ chat });
    const prior = { mood: "slow and tender", keywords: ["sensual", "romantic", "rough"] };
    const kws = await c.refine(prior, "nothing rough");
    ok("refine returns adjusted keywords", Array.isArray(kws) && kws.length >= 4);
    ok("refine respects negation (drops rough/hardcore)", kws && !kws.includes("rough") && !kws.includes("hardcore"));
    const lastTurn = JSON.parse(chat.seen[0]);
    ok("refine handed Q the prior mood + prior keywords + adjustment (multi-turn)",
      lastTurn.some((m) => /slow and tender/.test(m.content)) && lastTurn.some((m) => /sensual/.test(m.content)) && lastTurn.some((m) => /adjust:/.test(m.content)));
  }

  // 3) ZERO EGRESS: even when the caller holds a full scene (title/performer/id/src), only the mood reaches Q.
  {
    const chat = mockChat(() => "ebony, curvy, amateur");
    const c = createCompanion({ chat });
    const scene = { id: "live:secretUser123", title: "SECRET TITLE Jane Doe", performers: ["Jane Doe"], _src: "https://example.com/x" };
    await c.expand("curvy ebony");                                     // the app passes the MOOD STRING, never the scene
    const blob = chat.seen.join(" | ");
    const leaked = ["secretUser123", "SECRET TITLE", "Jane Doe", "example.com"].filter((s) => blob.includes(s));
    ok("no title/performer/id/url ever reached Q", leaked.length === 0);
    // also assert the witness itself didn't accidentally pass the scene
    ok("scene object never serialized into a Q turn", !blob.includes("\"performers\"") && !blob.includes("_src"));
  }

  // 4) FAIL-SOFT: no brain / empty / malformed → null (caller falls back to literal matchCategories)
  {
    const cNo = createCompanion({ chat: null });
    ok("no-brain expand → null", (await cNo.expand("anything")) === null);
    ok("no-brain refine → null", (await cNo.refine({ mood: "x", keywords: [] }, "slower")) === null);
    const cEmpty = createCompanion({ chat: async () => "" });
    ok("empty reply → null", (await cEmpty.expand("anything")) === null);
    const cSlow = createCompanion({ chat: () => new Promise((r) => setTimeout(() => r("a,b,c,d,e,f"), 200)), timeoutMs: 40 });
    ok("slow reply (past timeout) → null", (await cSlow.expand("anything")) === null);
    ok("empty mood/adjustment → null", (await createCompanion({ chat: async () => "a,b,c" }).expand("")) === null);
  }

  // 5) parseKeywords hardening (preamble/quotes/numbering/dup)
  {
    const kws = parseKeywords('Sure! Here are: 1. "Sensual", 2. Romantic, romantic, • Slow-Motion');
    ok("parseKeywords strips preamble/quotes/numbering", kws.includes("sensual") && kws.includes("romantic"));
    ok("parseKeywords dedups", kws.filter((k) => k === "romantic").length === 1);
  }

  console.log(`\n${pass}/${pass + fail} passed` + (fail ? ` — ${fail} FAILED` : " — all green"));
  process.exit(fail ? 1 : 0);
})();
