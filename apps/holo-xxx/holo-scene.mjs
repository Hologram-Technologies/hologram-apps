// holo-scene.mjs — the scene hub for Holo XXX. The magic, exactly as in Holo Library: a scene's METADATA (title,
// performers, studio, tags, cover) lives in open community catalogues (StashDB, ThePornDB), while its BYTES live
// wherever the user acquired them (owned files, yt-dlp). The hub merges both into a single "scene" you can then
// manufacture into a sealed κ-object. A SceneProvider yields *editions* tagged by mediaType; the hub groups them
// across providers by a stable scene key (normalized title + studio + date).
//
//   SceneProvider = { id, name, kind, trust, mediaType: "video"|"meta", async search(q) → [edition] }
//   edition       = { id, title, performers[], studio?, date?, tags[], cover?, duration?, mediaType, _src, ...locator }
//   scene         = { key, title, performers[], studio, date, cover, tags[], duration, video[], meta[], sources[] }
//
// Pure ESM, providers inject their own fetch — Node witnesses the merge exactly. streamable() marks scenes whose
// bytes the user actually holds; everything else is an index entry with a "stream/acquire" affordance (ToS line).

// ── scene-key normalization: the join that lets a StashDB metadata entry meet a file the user owns ──────────────
export const normTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const normStudio = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
// date → YYYY (year granularity tolerates re-release dates differing by day across catalogues).
export const yearOf = (d) => (String(d || "").match(/\d{4}/) || [""])[0];
export const sceneKey = (title, studio, date) => `${normTitle(title)}|${normStudio(studio)}|${yearOf(date)}`;

// the three integration tiers. A provider declares its tier; editions inherit it; the rights gate
// (holo-scene-manifest.assertRightsCoherent) reads it to decide what may be owned vs only indexed/linked-out.
export const TIER = Object.freeze({ OPEN: "open", OWNED: "owned", METADATA: "metadata" });
export const tierOfKind = (k) => ({ open: "open", owned: "owned", server: "owned", meta: "metadata", commercial: "metadata" }[k] || "metadata");

export function createSceneHub() {
  const providers = [];
  const register = (p) => { if (p && typeof p.search === "function") providers.push({ enabled: true, trust: 3, ...p }); return p; };
  const enabled = () => providers.filter((p) => p.enabled);
  const setEnabled = (id, on) => { const p = providers.find((x) => x.id === id); if (p) p.enabled = on; };

  // findScenes(q) → scenes merged across every provider, grouped by scene key. A shelf is built per provider so a
  // provider that errors drops its editions, never the whole search (latency floor = the slowest live provider).
  async function findScenes(q) {
    const byKey = new Map();
    for (const p of enabled()) {
      let eds = [];
      try { eds = (await p.search(q)) || []; } catch {}
      for (const ed0 of eds) {
        const ed = { ...ed0, mediaType: ed0.mediaType || p.mediaType, _provider: p.id, _providerName: p.name, _trust: p.trust, _tier: ed0.tier || p.tier || tierOfKind(p.kind) };
        const key = sceneKey(ed.title, ed.studio, ed.date);
        let s = byKey.get(key);
        if (!s) { s = { key, title: ed.title, performers: [], studio: ed.studio || "", date: ed.date || "", cover: null, tags: [], duration: null, video: [], meta: [], sources: [] }; byKey.set(key, s); }
        (ed.mediaType === "video" ? s.video : s.meta).push(ed);
        if (!s.sources.includes(p.name)) s.sources.push(p.name);
        // cover preference: meta (curated catalogue art) wins; first owned cover otherwise.
        if (ed.cover && (!s.cover || ed.mediaType === "meta")) s.cover = ed.cover;
        if (!s.duration && ed.duration) s.duration = ed.duration;
        // union performers + tags across editions (different catalogues spell/cover them differently).
        for (const pf of ed.performers || []) if (!s.performers.some((x) => normTitle(x) === normTitle(pf))) s.performers.push(pf);
        for (const tg of ed.tags || []) if (!s.tags.some((x) => normTitle(x) === normTitle(tg))) s.tags.push(tg);
      }
    }
    // surface scenes the user can actually stream (own the bytes) first, then richer index entries.
    return [...byKey.values()].sort((a, b) => (streamable(b) - streamable(a)) || (b.video.length + b.meta.length) - (a.video.length + a.meta.length));
  }

  // facetsOf(scenes) → the category navigation axis: every tag with a count, hottest first. This is how the
  // catalogue "captures a very wide range of categories" automatically — no hand-maintained taxonomy, the tags
  // ARE the taxonomy, aggregated live from what discovery returned.
  function facetsOf(scenes) {
    const counts = new Map();
    for (const s of scenes) for (const t of s.tags || []) { const k = t.trim(); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  return { register, setEnabled, enabled, findScenes, facetsOf, _providers: providers };
}

// can this scene actually be streamed (the user holds bytes for it), or is it index-only?
export const streamable = (s) => (s.video?.length ? 1 : 0);

export default { createSceneHub, sceneKey, normTitle, normStudio, yearOf, streamable, TIER, tierOfKind };
if (typeof window !== "undefined") window.HoloSceneHub = { createSceneHub, sceneKey, streamable };
