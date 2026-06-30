// holo-xxx-q.mjs — THE PRIVATE CURATOR (P7 M7.1). The whole industry's "for you" requires harvesting your most
// intimate behavior to a server. Hologram inverts it: the taste model is a recency-weighted affinity over YOUR
// watch history, computed and stored ENTIRELY ON DEVICE (IndexedDB, behind the app's biometric seal), never sent
// anywhere. It re-ranks the Aloha Atlas into a "For You" rail. Deterministic + Q-upgradeable: the same signal can
// later feed Q's mux for semantic refinement, but the privacy-winning behavioral core needs no model and no network.
//
// The pure functions (affinityOf / rankCategories / forYou) take the event log + `now` explicitly → node-witnessable.
// The browser store (createTasteStore) persists to IndexedDB; recordWatch appends one tiny event; clearTaste wipes it
// (the user OWNS and can erase the model). No bytes about the user ever leave the device — that is the trust moat.

const HALFLIFE_MS = 14 * 24 * 3600 * 1000;   // affinity half-life: ~2 weeks (recent taste outweighs old)
const TAG_WEIGHT = 0.4;                       // a scene's tags count, but less than the category it was played from
const MAX_EVENTS = 4000;                       // ring-buffer the log (privacy + bound)

// affinityOf(events, now) → { key → score }. Keys: a category slug ("milf"), or a tag ("#asian"). Each watch
// decays by its age. Pure.
export function affinityOf(events, now) {
  const a = Object.create(null);
  for (const e of events || []) {
    const w = Math.pow(0.5, Math.max(0, now - (e.ts || 0)) / HALFLIFE_MS);
    if (e.slug) a[e.slug] = (a[e.slug] || 0) + w;
    for (const t of e.tags || []) {
      // index the whole tag AND each word, so a multi-word tag ("big tits") cross-matches a category query
      // ("big natural tits" → #big, #tits). Tag affinity is weighted below a direct category watch.
      for (const k of ["#" + String(t).toLowerCase(), ...String(t).toLowerCase().split(/\s+/).map((x) => "#" + x)]) a[k] = (a[k] || 0) + w * TAG_WEIGHT;
    }
  }
  return a;
}

// rankCategories(cats, affinity) → cats scored + sorted desc (only those with signal). A category scores on its own
// slug PLUS any tag affinity whose word appears in its query ("big natural tits" picks up #big, #natural, #tits).
export function rankCategories(cats, affinity) {
  const score = (c) => {
    let s = affinity[c.slug] || 0;
    for (const w of String(c.query || c.slug).toLowerCase().split(/\s+/)) if (w) s += (affinity["#" + w] || 0);
    return s;
  };
  return (cats || []).map((c) => ({ ...c, score: score(c) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
}

// forYou(cats, events, now, n) → the top-n Atlas categories for this user (empty if no history → caller falls back).
export function forYou(cats, events, now, n = 8) {
  return rankCategories(cats, affinityOf(events, now)).slice(0, n);
}

// makeEvent(scene, slug) → the tiny byte-free signal we log (NO performer text, NO title — just the taxonomy hooks).
export function makeEvent(scene, slug, now) {
  const tags = ((scene && scene.tags) || []).slice(0, 6);
  return { slug: slug || null, tags, ts: now };
}

// ── browser store: IndexedDB, device-local, wipeable. Same DB family as the κ-cache (CEF blocks OPFS writes). ───
export function createTasteStore({ idb = (typeof indexedDB !== "undefined" ? indexedDB : null), dbName = "holo-xxx-taste", now = () => Date.now() } = {}) {
  let mem = [];                                 // hot copy; IndexedDB is the durable mirror
  const open = () => new Promise((res, rej) => { if (!idb) return res(null); const r = idb.open(dbName, 1); r.onupgradeneeded = () => r.result.createObjectStore("ev", { keyPath: "ts" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function load() { try { const db = await open(); if (!db) return mem; const ev = await new Promise((res) => { const rq = db.transaction("ev").objectStore("ev").getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); }); mem = ev.sort((a, b) => a.ts - b.ts).slice(-MAX_EVENTS); return mem; } catch { return mem; } }
  async function record(scene, slug) { const e = makeEvent(scene, slug, now()); mem.push(e); mem = mem.slice(-MAX_EVENTS); try { const db = await open(); if (db) db.transaction("ev", "readwrite").objectStore("ev").put(e); } catch (_) {} return e; }
  async function clear() { mem = []; try { const db = await open(); if (db) db.transaction("ev", "readwrite").objectStore("ev").clear(); } catch (_) {} }
  return { load, record, clear, events: () => mem.slice(), forYou: (cats, n) => forYou(cats, mem, now(), n), affinity: () => affinityOf(mem, now()) };
}

export default { affinityOf, rankCategories, forYou, makeEvent, createTasteStore };
if (typeof window !== "undefined") window.HoloXxxQ = { affinityOf, rankCategories, forYou, makeEvent, createTasteStore };
