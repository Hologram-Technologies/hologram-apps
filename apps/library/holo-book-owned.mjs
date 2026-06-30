// holo-book-owned.mjs — Tier B: the user's OWN audiobooks become editions. The user already has the rights
// (their Jellyfin/Emby/Subsonic/OPDS server, or local files), so these are ingestable and — paired with an open
// Gutenberg text edition of the same work — become a read-along they own. We do NOT rebuild a media-server
// client here; we adapt the existing player source adapters (holo-source-jellyfin.mjs et al.) behind a tiny
// contract, injected so Node witnesses it without a live server:
//   source = { id, name, async search(q) → [{ id, title, authors[], lang, audioUrl?, chapters?[] }] }
//
// createOwnedSource({ source }) → a BookProvider (tier "owned", mediaType "audio").

import { TIER } from "./holo-book.mjs";

export function createOwnedSource({ source } = {}) {
  if (!source || typeof source.search !== "function") throw new Error("holo-book-owned: a source with search(q) is required");
  return {
    id: "owned:" + (source.id || "server"), name: source.name || "My Library", kind: "owned", tier: TIER.OWNED, mediaType: "audio", enabled: true, trust: 6,
    async search(q) {
      let items = []; try { items = (await source.search(q)) || []; } catch { return []; }
      return items.map((it) => ({
        id: "own:" + (it.id || it.title), mediaType: "audio", tier: TIER.OWNED,
        title: it.title || "", authors: it.authors || [], lang: it.lang || "en", year: it.year || null,
        cover: it.cover || null,
        audioUrl: it.audioUrl || null,
        _sections: Array.isArray(it.chapters) ? it.chapters.map((c) => ({ url: c.url || c, sec: +c.sec || 0, title: c.title || "" })) : [],
        license: "Owned",
      })).filter((e) => e.title && (e.audioUrl || e._sections.length));
    },
    // the chapter audio URLs to pin (the user owns these; holo-stream pins them by κ).
    async resolveTracks(ed) {
      if (ed._sections?.length) return ed._sections.map((s) => ({ url: s.url, type: "audio/mpeg", sec: s.sec, title: s.title, httpDirect: true }));
      return ed.audioUrl ? [{ url: ed.audioUrl, type: "audio/mpeg", httpDirect: true }] : [];
    },
  };
}

export default { createOwnedSource };
if (typeof window !== "undefined") window.HoloBookOwned = { createOwnedSource };
