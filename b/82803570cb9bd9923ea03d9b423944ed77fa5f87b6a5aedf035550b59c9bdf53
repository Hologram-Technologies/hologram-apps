// holo-media-index.mjs — the LEAN κ-resolver index (K0 of HOLO-TV-KAPPA-NATIVE-PROMPT.md).
//
// The hub's ONLY data layer: resolve the media-index by its κ, then cards by theirs — verify-or-refuse
// at every hop (Law L5), warm-Map cached so a re-resolve is a synchronous µs hit with zero egress.
// No catalogs, no adapters, no trust in paths: media-index.json carries only the index κ (a pointer of
// convenience); every byte painted traces to a hash. Pure ESM; identical in the browser and Node ≥20
// (inject `load` to read from disk in a witness, default `load` fetches the origin-b store rung ../../b/<hex>).
//
//   const MI = makeMediaIndex();
//   await MI.open();                     // pointer → index κ → verified index
//   MI.rows()                           // [{label, kind, cards:[hex…]}]
//   await MI.card(hex)                  // verified card | null (REFUSED)   — warm: µs, no fetch
//   await MI.artURL(card)               // object URL of the verified art blob | null
//   MI.stats()                          // { warm, loads, refused }

import { verifyCard, sha256hex } from "./holo-media-card.mjs";

export function makeMediaIndex({ base, load, pointer } = {}) {
  const B = base || new URL("../../b/", import.meta.url);              // origin-b store rung (root + /Q/ safe)
  const P = pointer || new URL("./media-index.json", import.meta.url); // the κ pointer (path = convenience only)
  // Default loader: CacheStorage-first (0-egress revisits + OFFLINE browse), then the origin-b rung — the
  // fetched bytes are cached RAW; verification happens on EVERY read above this layer, so a poisoned cache
  // entry refuses exactly like a poisoned fetch (Law L5 is not delegated to the cache).
  const CACHE = "holo-media-b";
  const _hasCaches = typeof caches !== "undefined";
  const _load = load || (async (hex) => {
    const url = new URL(hex, B);
    if (_hasCaches) { try { const hit = await (await caches.open(CACHE)).match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch {} }
    const r = await fetch(url); if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (_hasCaches) { try { await (await caches.open(CACHE)).put(url, new Response(bytes.slice())); } catch {} }
    return bytes;
  });
  const warm = new Map();                                              // hex → verified parsed card (µs tier)
  const artWarm = new Map();                                           // hex → object URL of verified art
  const stats = { warm: 0, loads: 0, refused: 0 };
  let index = null;

  async function object(hex) {                                         // verified JSON object by κ (card or index)
    hex = String(hex || "").replace(/^sha256:/, "");
    if (warm.has(hex)) { stats.warm++; return warm.get(hex); }
    const bytes = await _load(hex); stats.loads++;
    if (!bytes) return null;
    const obj = await verifyCard(bytes, hex);                          // re-derive or REFUSE
    if (!obj) { stats.refused++; return null; }
    warm.set(hex, obj);
    return obj;
  }

  return {
    async open() {
      // Pointer: network-first (a re-mint propagates), CacheStorage-fallback (offline still opens).
      const p = (typeof P === "object" && P.kappa) ? P : await (async () => {
        try { const r = await fetch(P, { cache: "no-cache" }); if (r.ok) { if (_hasCaches) { try { await (await caches.open(CACHE)).put(P, r.clone()); } catch {} } return await r.json(); } } catch {}
        if (_hasCaches) { try { const hit = await (await caches.open(CACHE)).match(P); if (hit) return await hit.json(); } catch {} }
        return null;
      })();
      if (!p || !p.kappa) throw new Error("media-index pointer unavailable");
      index = await object(p.kappa);
      if (!index || index.kind !== "media-index") { index = null; throw new Error("media-index REFUSED (κ mismatch or missing)"); }
      return index;
    },
    rows: () => (index ? index.rows : []),
    card: (hex) => object(hex),
    async artBytes(card) {                                             // verified raw art bytes | null
      const k = card && card.art && card.art.kappa; if (!k) return null;
      const hex = String(k).replace(/^sha256:/, "");
      const bytes = await _load(hex);
      if (!bytes || (await sha256hex(bytes)) !== hex) { stats.refused += bytes ? 1 : 0; return null; }
      return bytes;
    },
    async artURL(card) {                                               // browser convenience: verified blob → object URL
      const k = card && card.art && card.art.kappa; if (!k) return null;
      const hex = String(k).replace(/^sha256:/, "");
      if (artWarm.has(hex)) { stats.warm++; return artWarm.get(hex); }
      const bytes = await this.artBytes(card); if (!bytes) return null;
      const url = URL.createObjectURL(new Blob([bytes], { type: (card.art.type || "image/png") }));
      artWarm.set(hex, url);
      return url;
    },
    stats: () => ({ ...stats }),
  };
}
