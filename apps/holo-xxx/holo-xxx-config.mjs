// holo-xxx-config.mjs — discovery wiring: where the StashDB key comes from, and the κ-cache that makes repeat
// navigation instant. Both are INJECTED, never embedded — the kernels stay pure and Node-witnessable.
//
// Key resolution order (first hit wins; null → the StashDB provider self-disables and the hub runs on owned
// content only, so a keyless user still has a working app):
//   1. window.HOLO_XXX_STASHDB_KEY        — the OS settings surface injects it at mount (the production path;
//                                            in the OS this is read from the Holo Pass vault on unlock, so the
//                                            key itself lives encrypted at rest, never in app code or the closure).
//   2. localStorage "holo.xxx.stashdb.key"— a user who pasted their own key into the app's settings.
//   3. process.env.HOLO_XXX_STASHDB_KEY    — Node (witness / CLI) path.
//
// The vault is the real home (openVault → entry "stashdb"); we don't call it here because a low-sensitivity search
// key shouldn't force a biometric step-up just to browse. The OS settings surface bridges vault → window at unlock.

export function resolveStashKey() {
  if (typeof window !== "undefined") {
    if (window.HOLO_XXX_STASHDB_KEY) return window.HOLO_XXX_STASHDB_KEY;
    try { const k = localStorage.getItem("holo.xxx.stashdb.key"); if (k) return k; } catch (_) {}
  }
  if (typeof process !== "undefined" && process.env && process.env.HOLO_XXX_STASHDB_KEY) return process.env.HOLO_XXX_STASHDB_KEY;
  return null;
}

// createKappaCache — a content-addressed through-cache with the OS {through(key, fetcher) → {body}} shape (the
// same interface holo-sponsorblock and the book providers accept). A repeat query returns instantly (hit:true)
// without a second round-trip — the low-latency-navigation requirement. An optional `store` persists across mounts
// (OS: holo-opfs-kappastore); without it the cache is per-session in-memory.
export function createKappaCache({ store = null } = {}) {
  const mem = new Map();
  return {
    async through(key, fetcher) {
      if (mem.has(key)) return { body: mem.get(key), hit: true };
      if (store) { try { const v = await store.get(key); if (v != null) { mem.set(key, v); return { body: v, hit: true }; } } catch (_) {} }
      const body = await fetcher();
      mem.set(key, body);
      if (store) { try { await store.put(key, body); } catch (_) {} }
      return { body, hit: false };
    },
    _size() { return mem.size; },
  };
}

// pinCover(url, { fetch, kappaOf, store }) → { kappa, src } — content-address a catalogue cover. On first sight we
// fetch the remote bytes, derive their κ, and (if a store is present) pin them; thereafter the grid renders the
// cover from /.holo/sha256/<hex> — served from the κ-store, no re-fetch from the origin (the Lightspeed pattern:
// project a remote asset onto a local κ once, then it's content, not a location). Returns the original url as src
// when bytes can't be fetched, so the grid still renders.
export async function pinCover(url, { fetch: f, kappaOf, store = null } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!url || !doFetch || !kappaOf) return { kappa: null, src: url };
  try {
    const bytes = new Uint8Array(await (await doFetch(url)).arrayBuffer());
    const kappa = kappaOf(bytes);
    if (store) { try { await store.put(kappa, bytes); } catch (_) {} }
    const hex = String(kappa).split(":").pop();
    return { kappa, src: "/.holo/sha256/" + hex };
  } catch (_) { return { kappa: null, src: url }; }   // origin unreachable → fall back to the remote URL
}

export default { resolveStashKey, createKappaCache, pinCover };
if (typeof window !== "undefined") window.HoloXxxConfig = { resolveStashKey, createKappaCache, pinCover };
