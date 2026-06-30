// holo-xxx-live.mjs — public live-cam rooms (Chaturbate affiliate API), viewed NATIVELY + ad-free in Holo XXX.
//
// Posture: we VIEW public, consenting, publicly-broadcast streams on demand (resolve-on-play); we never
// re-broadcast them and never reimplement the tip/token economy (that's the source's, account-bound). The room
// LIST is served by Chaturbate's affiliate API, which REQUIRES a real affiliate code (wm) + the viewer IP — read
// from config like the StashDB key. No code → the Live tab prompts you to connect one (nothing is faked).
//
// Fetch is INJECTED (DoH-proxied in the browser). Static room thumbnails are landscape → they pass the wall gate.

// FEATURED pinned rooms — optionally pin specific room slugs to the top of the Live tab (key-free, one-click).
// None by default: the Live tab spotlights the top ONLINE public room as its hero. Pin via opts.featured or
// window.HOLO_CB_FEATURED (a slug or any chaturbate.com room/affiliate URL).
const DEFAULT_FEATURED = [];
// the live room-image CDN (the affiliate API itself returns thumb.live.mmcdn.com/ri/<user>.jpg). Updates server-side
// every few seconds while online; serves a last-frame/placeholder when offline.
const thumbOf = (user) => "https://thumb.live.mmcdn.com/riw/" + encodeURIComponent(user) + ".jpg";

// slugFromUrl(url) → the room slug from any Chaturbate URL: the affiliate deep-link (…/in/?…&room=<slug>), a bare
// room URL (chaturbate.com/<slug>/), or a broadcaster URL (chaturbate.com/b/<slug>). Reserved path words are skipped.
const RESERVED = new Set(["in", "b", "api", "affiliates", "tags", "tag", "female", "male", "couple", "trans", "p", "accounts", "terms", "photo_videos", "feed", "supporter", "security", "apps"]);
export function slugFromUrl(url) {
  const s = String(url || "").trim();
  try {
    const u = new URL(s.startsWith("http") ? s : "https://" + s);
    if (!/(^|\.)chaturbate\.com$/i.test(u.hostname)) return null;
    const room = u.searchParams.get("room"); if (room) return room.replace(/[^a-z0-9_]/gi, "");
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (seg && !RESERVED.has(seg.toLowerCase())) return seg.replace(/[^a-z0-9_]/gi, "");
  } catch (_) {}
  const m = s.match(/chaturbate\.com\/(?:b\/)?([a-z0-9_]+)/i);
  return m && !RESERVED.has(m[1].toLowerCase()) ? m[1] : null;
}

export function createLive({ wm = null, fetch: f, proxyUrl = (u) => u, featured = null } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  const FEATURED = (featured || (typeof window !== "undefined" && window.HOLO_CB_FEATURED) || DEFAULT_FEATURED)
    .map((x) => slugFromUrl(x) || String(x).replace(/[^a-z0-9_]/gi, "")).filter(Boolean);

  const norm = (r) => ({
    id: "live:" + r.username,
    mediaType: "meta",
    title: String(r.room_subject || r.username || "").replace(/<[^>]+>/g, "").slice(0, 80),
    performers: [r.username],
    studio: "Live",
    date: "",
    tags: Array.isArray(r.tags) ? r.tags.slice(0, 10) : [],
    cover: proxyUrl(r.image_url || ""),
    tw: 16, th: 9,                                                 // CB room thumbnails are 16:9 landscape
    live: true, viewers: r.num_users || 0,
    _src: "https://chaturbate.com/" + r.username + "/",
    _provider: "live", _cbUser: r.username,
  });

  // a scene from a bare room slug (paste-URL / featured pin) — no affiliate API needed. The cover is the live
  // room-image (updates server-side); marked live so the card shows the ● badge and skips the hover-transcode storm.
  function roomScene(slug, extra = {}) {
    const user = slugFromUrl(slug) || String(slug).replace(/[^a-z0-9_]/gi, "");
    return {
      id: "live:" + user, mediaType: "meta",
      title: extra.title || ("@" + user), performers: [user], studio: "Live", date: "",
      tags: extra.tags || [], cover: proxyUrl(thumbOf(user)), tw: 16, th: 9,
      live: true, viewers: extra.viewers || 0, featured: !!extra.featured,
      _src: "https://chaturbate.com/" + user + "/", _provider: "live", _cbUser: user,
    };
  }
  // the pinned featured rooms (always available, key-free) — shown first in the Live tab.
  function featuredScenes() { return FEATURED.map((u) => roomScene(u, { featured: true })); }

  // the online public-room wall. Affiliate API needs wm + client_ip (Chaturbate accepts the literal request_ip).
  async function rooms({ gender = "", limit = 90 } = {}) {
    if (!wm || !doFetch) return [];
    const url = "https://chaturbate.com/api/public/affiliates/onlinerooms/?wm=" + encodeURIComponent(wm)
      + "&client_ip=request_ip&format=json&limit=" + limit + (gender ? "&gender=" + gender : "");
    try {
      const j = await (await doFetch(url)).json();
      const a = Array.isArray(j) ? j : (j.results || j.rooms || []);
      return a.filter((r) => r && r.username && (r.current_show || "public") === "public").map(norm);
    } catch { return []; }
  }

  // best-effort NATIVE stream: scrape the room page for its HLS master; the GPU transcode plays it live + ad-free
  // (no chat/tip chrome, no iframe). Returns {kind:'hls'} for the engine-adaptive player, or null if gated.
  async function resolve(scene) {
    const user = scene && (scene._cbUser || (String(scene._src || "").match(/chaturbate\.com\/([^/]+)/) || [])[1]);
    if (!user || !doFetch) return null;
    try {
      const html = await (await doFetch("https://chaturbate.com/" + user + "/")).text();
      const raw = (html.match(/https?:\\?\/\\?\/[^"'\s]*?\.m3u8[^"'\s]*/) || [])[0];
      if (raw) { const u = raw.replace(/\\\//g, "/"); return { kind: "hls", url: u, hls: u, mp4: null, label: "live" }; }
    } catch (_) {}
    return null;
  }

  return { id: "live", name: "Live", color: "#ff2d55", enabled: !!doFetch, hasKey: !!wm, featuredSlugs: FEATURED, rooms, resolve, roomScene, featuredScenes, slugFromUrl };
}
