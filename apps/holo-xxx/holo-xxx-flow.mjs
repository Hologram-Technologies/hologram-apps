// HOLO FLOW — the lean-back engine. One button → an infinite, self-tuning stream ranked by the user's live taste
// vector, learning from every reaction. PURE + node-witnessable: no DOM, no network. The host wires it to the player
// (autoplay-advance, pre-resolve) and to the providers (refill). Reuses the orthogonal Taste Console basis so a Flow
// nudge and a search nudge mean the same thing.
import { AXES, featureOf, rerankPool } from "./holo-xxx-taste-console.mjs";

const clamp2 = (v) => Math.max(-2, Math.min(2, Math.round(v * 1000) / 1000));
const idOf = (s) => (s && (s.id || s._src)) || null;

// weight of a reaction → how strongly it should move the taste vector (sign = like/dislike).
// skip is graded by how far the user got (a 2s bail is a stronger "no" than a near-complete skip).
export function reactionWeight(type, dwellMs, durationSec) {
  switch (type) {
    case "more":     return 2.2;
    case "save":     return 1.6;
    case "replay":   return 1.5;
    case "complete": return 1.0;
    case "leanIn":   return 0.8;     // unmute / fullscreen
    case "less":     return -2.2;
    case "skip": {                    // ratio 0 (instant bail) → −1.4 ; ratio ~1 (watched most) → ~0
      const ratio = durationSec ? Math.min(1, (dwellMs || 0) / (durationSec * 1000)) : 0.25;
      return -1.4 * (1 - ratio);
    }
    default: return 0;
  }
}

export function createFlow(opts = {}) {
  let pool = (opts.pool || []).slice();
  let base = { ...(opts.vector || {}) };     // external taste vector (standing ⊗ console session)
  let affinity = opts.affinity || {};
  const learned = {};                        // reaction-derived bias, decays over time (session memory)
  const repeatWindow = opts.repeatWindow || 15;
  const refillAt = opts.refillAt || 6;       // refill when fewer than this many unplayed remain
  const played = new Set();                  // ids already served (avoid repeats until the pool loops)
  const recent = [];                         // last-N ids (hard no-immediate-repeat window)
  let loopRound = 0;

  const eff = () => { const v = {}; for (const ax of AXES) v[ax.key] = clamp2((base[ax.key] || 0) + (learned[ax.key] || 0)); return v; };
  const inRecent = (id) => recent.includes(id);
  const remember = (id) => { recent.push(id); while (recent.length > repeatWindow) recent.shift(); };

  function rankedUnplayed() {
    let live = pool.filter((s) => { const id = idOf(s); return id && !played.has(id); });
    if (!live.length && pool.length) {        // exhausted → LOOP: forget all but the recent window, reshuffle by vector
      loopRound++; played.clear(); for (const id of recent) played.add(id);
      live = pool.filter((s) => { const id = idOf(s); return id && !played.has(id); });
      if (!live.length) live = pool.slice();
    }
    return rerankPool(live, eff(), { affinity });
  }

  return {
    // advance: the next scene to play (marks it played, honors the no-repeat window)
    next() {
      const ranked = rankedUnplayed(); if (!ranked.length) return null;
      const pick = ranked.find((s) => !inRecent(idOf(s))) || ranked[0];
      const id = idOf(pick); if (id) { played.add(id); remember(id); }
      return pick;
    },
    // look ahead WITHOUT advancing → the host pre-resolves these so transitions never stall
    peek(n = 2) {
      const ranked = rankedUnplayed();
      return ranked.filter((s) => !inRecent(idOf(s))).slice(0, n);
    },
    // fold a reaction into the live taste vector. Returns the signal so the host can persist strong positives.
    react(ev) {
      if (!ev || !ev.scene) return null;
      const w = reactionWeight(ev.type, ev.dwellMs, ev.duration); if (!w) return { scene: ev.scene, weight: 0, positive: false };
      const f = featureOf(ev.scene);
      for (const k in learned) learned[k] *= 0.88;                 // global decay → recent taste outweighs old
      for (const ax of AXES) {
        if (ax.key === "novelty") continue;
        let hi = 0, lo = 0;
        for (const t of ax.highTags) if (f.tags.has(t)) hi++;
        for (const t of ax.lowTags) if (f.tags.has(t)) lo++;
        const net = hi - lo; if (!net) continue;
        learned[ax.key] = clamp2((learned[ax.key] || 0) + Math.sign(net) * w * 0.3);
      }
      return { scene: ev.scene, weight: w, positive: w > 0 };
    },
    retune(vector) { base = { ...(vector || {}) }; },             // console nudge → re-aim the remaining queue
    setAffinity(a) { affinity = a || {}; },
    addToPool(rows) {                                             // refill from deeper provider pages (dedup by id)
      const have = new Set(pool.map(idOf));
      let added = 0; for (const r of rows || []) { const id = idOf(r); if (id && !have.has(id)) { have.add(id); pool.push(r); added++; } }
      return added;
    },
    needsRefill() { let n = 0; for (const s of pool) { const id = idOf(s); if (id && !played.has(id)) n++; if (n >= refillAt) return false; } return true; },
    size() { return pool.length; },
    vector() { return eff(); },
    stats() { return { pool: pool.length, played: played.size, loopRound, vector: eff(), learned: { ...learned } }; },
  };
}

export default { createFlow, reactionWeight };
if (typeof window !== "undefined") window.HoloFlow = { createFlow, reactionWeight };
