// holo-xxx-owned.mjs — Tier B: the user's OWN videos become streamable editions. The user holds these (their
// files, or content they acquired themselves via yt-dlp — the acquisition ToS boundary is the USER's call, never
// the OS's), so they are ingestable: paired with a StashDB metadata edition of the same scene, they become a
// fully-titled κ-object the user owns. We don't rebuild a media server here; we adapt whatever local source the
// runtime supplies behind a tiny contract, injected so Node witnesses it without touching disk or a live server:
//
//   source = { id, name, async search(q) → [{ id, title, performers[], studio?, date?, tags[], cover?,
//                                              duration?, graph }] }   // graph = a holo-media MediaGraph
//
// createOwnedScenes({ source }) → a SceneProvider (tier "owned", mediaType "video"). resolveGraph(ed) hands back
// the MediaGraph the player feeds through openStream() — the bytes are already κ-sealed by the ingest adapter.

import { TIER } from "./holo-scene.mjs";

export function createOwnedScenes({ source } = {}) {
  if (!source || typeof source.search !== "function") throw new Error("holo-xxx-owned: a source with search(q) is required");
  return {
    id: "owned:" + (source.id || "local"), name: source.name || "My Collection", kind: "owned", tier: TIER.OWNED,
    mediaType: "video", enabled: true, trust: 6,
    async search(q) {
      let items = []; try { items = (await source.search(q)) || []; } catch { return []; }
      return items.map((it) => ({
        id: "own:" + (it.id || it.title), mediaType: "video", tier: TIER.OWNED,
        title: it.title || "", performers: it.performers || [], studio: it.studio || "", date: it.date || "",
        tags: it.tags || [], cover: it.cover || null, duration: it.duration || null,
        _graph: it.graph || null,
        license: "Owned",
      })).filter((e) => e.title && e._graph);
    },
    // the MediaGraph the player streams (already κ-sealed by the ingest adapter — bit-exact, no transcode).
    async resolveGraph(ed) { return ed._graph || null; },
  };
}

export default { createOwnedScenes };
if (typeof window !== "undefined") window.HoloXxxOwned = { createOwnedScenes };
