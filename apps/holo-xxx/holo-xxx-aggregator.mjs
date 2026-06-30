// holo-xxx-aggregator.mjs — the AlohaTube MODEL as a SceneProvider. AlohaTube aggregates a metadata INDEX and
// resolves the source's stream on demand; it hosts nothing. This provider does the same: every entry is
// mediaType:"meta" (byte-free) and carries a resolvable SOURCE URL in `_src`. On play the app resolves `_src`
// natively (holo-xxx-hls for a direct m3u8, or the host /sc/vstream + yt-dlp route) — origin → viewer, on demand.
//
// Two backends behind one shape (dependency-injected fetch → in the OS this is the host fetch PROXY, so a
// holo:// page can read a third-party host without a CORS wall):
//   backend = { async browse(page) → [ {id,title,performers,studio,date,tags,cover,duration,_src} ], categories?() }
//   • StashDB/TPDB (createStashDB.browse) supplies clean art+tags; _src from the scene's source urls.
//   • a generic category crawler turns a listing page into the same shape (respect robots + rate-limit).
//
// The OS NEVER bulk-downloads the catalogue and NEVER peer-broadcasts a resolved scene (holo-xxx-peer's rights
// gate serves user-owned / public-domain only). Resolution is the user's on-demand action.

export function createAggregator({ id = "builtin:aggregator", name = "Catalogue", backend, perPage = 24 } = {}) {
  const live = !!(backend && typeof backend.browse === "function");
  const norm = (s) => ({ ...s, mediaType: "meta" });                 // byte-free index entry; _src carries the source
  return {
    id, name, kind: "open", mediaType: "meta", trust: 5, enabled: live,
    async search(q) { if (!live || !backend.search) return []; try { return (await backend.search(q)).map(norm); } catch { return []; } },
    async browse(page = 0) { if (!live) return []; try { return (await backend.browse(page, perPage)).map(norm); } catch { return []; } },
    async categories() { try { return backend.categories ? await backend.categories() : []; } catch { return []; } },
  };
}

// stashBackend(provider) — adapt a StashDB provider (createStashDB) to the aggregator backend shape. Its browse()
// already pages newest scenes; we forward _src from the scene's urls when present (real source page → resolvable).
export function stashBackend(provider) {
  return {
    async browse(page) { const rows = await provider.browse(page); return rows.map((s) => ({ ...s, _src: s._src || (s.urls && s.urls[0]) || null })); },
    async search(q) { return provider.search(q); },
  };
}

// demoBackend({ playlists }) — a varied, category-spanning catalogue where a handful of entries carry a LOCAL m3u8
// `_src` (resolve-on-play proof with real fMP4 — no external dependency, no CORS). Stands in for a live AlohaTube /
// StashDB import so the pipeline is demonstrable and witnessable end to end. `playlists` = [{ title, src, tags }].
export function demoBackend({ playlists = [] } = {}) {
  const CATS = ["Amateur", "Couple", "Solo", "POV", "Cinematic", "Vintage", "HD", "4K", "Story", "Studio", "Outdoor", "Classic"];
  return {
    async browse(page, per = 24) {
      if (page > 0) return [];                                        // single demo page (a real backend pages on)
      return playlists.map((p, i) => ({
        id: "agg:" + i, title: p.title, performers: ["Demo Performer " + String.fromCharCode(65 + i)],
        studio: "Open Catalogue", date: (2016 + (i % 9)) + "-0" + (1 + (i % 8)) + "-12",
        tags: p.tags || [CATS[i % CATS.length], CATS[(i + 3) % CATS.length], i % 2 ? "4K" : "HD"],
        cover: null, duration: 240 + i * 30, _src: p.src,            // ← the resolvable source (a local m3u8 here)
      }));
    },
    async categories() { return CATS; },
  };
}

export default { createAggregator, stashBackend, demoBackend };
if (typeof window !== "undefined") window.HoloXxxAggregator = { createAggregator, stashBackend, demoBackend };
