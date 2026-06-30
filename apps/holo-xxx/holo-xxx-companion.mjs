// holo-xxx-companion.mjs — Q-powered semantic intent for Holo XXX (AURA Phase C).
//
// Q (the on-device LLM) EXPANDS a free-text/voice mood into concrete adult-video category keywords; the existing
// matchCategories() then GROUNDS those keywords in the real 443-category Atlas. So Q decides the meaning, the
// proven matcher decides the slugs — Q can't hallucinate a category that doesn't exist. This is a smart router
// over discovery, not a new content path.
//
// chat() is INJECTED: the app passes a thin wrapper over createHoloModelBrain (on-device, WebGPU); the witness
// passes a mock. PRIVACY: the only thing handed to Q is the mood text — never titles, performers, history, or any
// network signal. FAIL-SOFT: no brain / no WebGPU / slow / malformed reply → expand() returns null and the caller
// uses the raw text with matchCategories (today's behavior). Q strictly improves discovery; it never blocks it.

const SYSTEM = "You translate a viewer's mood into adult-video browsing keywords. Reply with ONLY 6 to 10 short, "
  + "comma-separated category keywords or short phrases that match the request. No sentences, no preamble, no "
  + "numbering. Example — input: 'something slow and tender, POV' -> sensual, romantic, passionate, softcore, "
  + "slow, intimate, pov, lovemaking, girlfriend, kissing";

// parse Q's free text into a clean keyword list (defensive: models add preamble/quotes/bullets/newlines).
export function parseKeywords(txt) {
  return String(txt || "")
    .replace(/^[\s\S]*?:\s*/, (m) => (m.length < 40 ? "" : m))     // drop a short "Keywords:" style lead-in
    .split(/[,\n;•\-]+/)
    .map((s) => s.trim().toLowerCase().replace(/^["'\d.\)\s]+|["'.\s]+$/g, "").replace(/[^a-z0-9 ]/g, "").trim())
    .filter((s) => s.length > 1 && s.length <= 28 && !/^(input|output|keywords|categories|here are|sure)$/.test(s))
    .filter((s, i, a) => a.indexOf(s) === i)                       // dedup
    .slice(0, 12);
}

// REFINE (C2): a multi-turn follow-up ("slower", "nothing rough", "more like that") adjusts the PRIOR keywords
// rather than starting over — Q sees the prior mood + prior keywords + the adjustment, and respects negations.
const SYSTEM_REFINE = "You refine a viewer's adult-video browsing keywords from a follow-up adjustment. Given the "
  + "previous mood, the previous keywords, and the new adjustment, reply with ONLY 6 to 10 short, comma-separated "
  + "category keywords reflecting the adjustment. RESPECT negations (e.g. 'nothing rough' must drop rough/hardcore). "
  + "No sentences, no preamble, no numbering.";

export function createCompanion({ chat = null, timeoutMs = 9000 } = {}) {
  // shared: run a chat history → cleaned keywords | null. Bounded so a cold/slow brain never stalls the UI.
  async function ask(history) {
    if (!chat) return null;
    try {
      const res = await Promise.race([
        Promise.resolve(chat(history, { maxTokens: 64 })),
        new Promise((r) => setTimeout(() => r("__timeout__"), timeoutMs)),
      ]);
      if (!res || res === "__timeout__") return null;
      const txt = typeof res === "string" ? res : (res.text || res.content || res.reply || res.message || "");
      const kws = parseKeywords(txt);
      return kws.length ? kws : null;
    } catch (_) { return null; }
  }
  // expand(mood) → [keywords] | null
  async function expand(mood) {
    if (!mood || !String(mood).trim()) return null;
    return ask([{ role: "system", content: SYSTEM }, { role: "user", content: String(mood).slice(0, 200) }]);
  }
  // refine(prior, adjustment) → [keywords] | null. prior = { mood, keywords }. PRIVACY: only the mood/keywords/
  // adjustment STRINGS are ever handed to Q — never titles, performers, history, or any network signal.
  async function refine(prior = {}, adjustment) {
    if (!adjustment || !String(adjustment).trim()) return null;
    const mood = String(prior.mood || "").slice(0, 160);
    const kws = Array.isArray(prior.keywords) ? prior.keywords.join(", ").slice(0, 200) : "";
    return ask([
      { role: "system", content: SYSTEM_REFINE },
      { role: "user", content: ("mood: " + mood + "\nkeywords: " + kws).slice(0, 360) },
      { role: "user", content: "adjust: " + String(adjustment).slice(0, 120) },
    ]);
  }
  return { expand, refine };
}
