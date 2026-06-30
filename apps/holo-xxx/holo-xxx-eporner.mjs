// holo-xxx-eporner.mjs — a REAL aggregator source over Eporner's public API (the kind of free tube aloha
// aggregates). Two jobs, fetch INJECTED (the app passes a DoH-routing fetch so the ISP name-filter is a no-op;
// node-witnessable with a mock):
//   • PROVIDER — search(q)/browse(page) → byte-free meta scenes with REAL titles/thumbs/keywords + a resolvable
//     _src (the watch page). This is what fills the wall with real content. Thumbnails are routed through the
//     same proxy (proxyUrl) so the blocked CDN loads.
//   • RESOLVER — resolveStream(vid|url) tries to obtain a DIRECT, natively-playable file: fetch the embed page,
//     read EP.video.player.{vid,hash}, call the sources XHR WITH the embed Referer (Eporner withholds sources
//     from refererless requests), and return the highest-quality mp4/hls. The bytes still flow origin→viewer.
//
// POSTURE unchanged: byte-free index + resolve-on-demand of a user-selected scene; no bulk download; resolved
// third-party bytes are never peer-broadcast (the owned-only gate stays). Eporner hosts the bytes; we host nothing.

const API = "https://www.eporner.com/api/v2/video/search/";

// createEporner({ fetch, proxyUrl, perPage, order }) → a SceneProvider (hub-registerable, like createStashDB).
//   proxyUrl(rawUrl) → a URL the BROWSER can load for a blocked host (the DoH proxy /fetch wrapper). Identity in node.
export function createEporner({ fetch: f, proxyUrl = (u) => u, perPage = 30, order = "top-weekly" } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  const norm = (v) => ({
    id: "eporner:" + v.id, mediaType: "meta",
    title: v.title || "",
    performers: [],                                              // Eporner has no performer field on search
    studio: "Eporner",
    date: (v.added || "").slice(0, 10),
    tags: String(v.keywords || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10),
    cover: proxyUrl((v.default_thumb && v.default_thumb.src) || ""),  // blocked CDN → load via proxy
    tw: (v.default_thumb && v.default_thumb.width) || 0, th: (v.default_thumb && v.default_thumb.height) || 0,  // thumb aspect → filter out portrait phone clips
    duration: v.length_sec || null, views: v.views, rate: v.rate,
    _src: v.url,                                                 // watch page → resolveStream
    _vid: v.id, _embed: v.embed,
  });
  async function page(query, p) {
    if (!doFetch) return [];
    const url = API + "?query=" + encodeURIComponent(query || "") + "&per_page=" + perPage + "&page=" + (p + 1) +
                "&order=" + order + "&thumbsize=big&format=json";
    try { const r = await doFetch(url); const j = await r.json(); return (j.videos || []).map(norm); } catch { return []; }
  }
  return {
    id: "builtin:eporner", name: "Eporner", kind: "open", mediaType: "meta", enabled: !!doFetch, trust: 4,
    async search(q, p = 0) { return page(q, p); },             // p = 0-based page → infinite scroll pages deeper
    async browse(p = 0) { return page("", p); },
    async categories() { return ["Amateur", "MILF", "Teen", "Anal", "Asian", "Ebony", "Latina", "POV", "Lesbian", "Big Tits", "Threesome", "Compilation", "Japanese", "Hardcore"]; },
  };
}

// extractVidHash(embedHtml) → { vid, hash } | null — read the player config the embed page prints inline.
export function extractVidHash(html) {
  const vid = (html.match(/EP\.video\.player\.vid\s*=\s*'([^']+)'/) || [])[1] || (html.match(/hash\s*[:=]\s*["'][\da-f]{32}/) && html.match(/vid\s*[:=]\s*["']([\w]+)/) || [])[1];
  const hash = (html.match(/hash\s*[:=]\s*["']([\da-f]{32})/) || [])[1];
  return vid && hash ? { vid, hash } : null;
}

// calcHash(hash) — Eporner's sources-XHR authorization token: split the 32-hex player hash into four 8-char
// chunks, base-36 encode each, concatenate (reverse-engineered from eporner's vjs.js; matches yt-dlp's eporner
// extractor). The RAW hash is rejected ("Authorization failed") — this transform is what authorizes the request.
export function calcHash(hash) {
  let out = "";
  for (let i = 0; i < 32; i += 8) out += parseInt(hash.slice(i, i + 8), 16).toString(36);
  return out;
}

// pickBest(sourcesJson, maxHeight) → { url, label, kind:'mp4'|'hls', h } | null — the highest-res REAL source
// (skip 'na.mp4' placeholders), optionally capped at maxHeight so the GPU transcode stays real-time (then Holo
// super-res takes it back up). Eporner nests sources as { mp4: { '1080p':{src}, '2160p(4K)@60fps':{src}, … } }.
export function pickBest(j, maxHeight = 0) {
  const out = [];
  const collect = (obj, kind) => {
    if (!obj) return;
    const items = Array.isArray(obj) ? obj : Object.entries(obj).map(([k, v]) => ({ label: k, ...(v || {}) }));
    for (const it of items) {
      const src = it.src || it.url; if (!src || /\/na\.mp4(\?|$)/.test(src)) continue;
      const h = parseInt(String(it.labelShort || it.label || "0"), 10) || 0;
      out.push({ url: src, label: it.label || it.labelShort || "", kind, h });
    }
  };
  const s = (j && j.sources) || {};
  collect(s.mp4, "mp4"); collect(s.hls, "hls");
  out.sort((a, b) => (b.h - a.h) || (a.kind === "hls" ? -1 : 1));
  if (maxHeight > 0) { const fit = out.find((x) => x.h && x.h <= maxHeight); if (fit) return fit; }
  return out[0] || null;
}

// resolveStream({ watchUrl, embedUrl, vid, fetch, sourcesFetch }) → { url, kind, label } | null.
//   fetch        : DoH-routing fetch for the embed HTML.
//   sourcesFetch : a fetch that can attach the embed Referer (Eporner returns 'na.mp4' without it). The app passes
//                  a proxy fetch that forwards Referer; in node the caller can inject one. Falls back to `fetch`.
export async function resolveStream({ watchUrl = null, embedUrl = null, vid = null, fetch: f, sourcesFetch = null, maxHeight = 0 } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) return null;
  const eUrl = embedUrl || (vid ? "https://www.eporner.com/embed/" + vid + "/" : null);
  if (!eUrl) return null;
  let html; try { html = await (await doFetch(eUrl)).text(); } catch { return null; }
  const vh = extractVidHash(html); if (!vh) return null;
  // the sources XHR is AUTHORIZED by the base-36-transformed hash (not the raw one) + the embed Referer.
  const xhr = "https://www.eporner.com/xhr/video/" + vh.vid + "?hash=" + calcHash(vh.hash) +
              "&device=generic&domain=www.eporner.com&fallback=false";
  const sf = sourcesFetch || doFetch;
  let j; try { j = await (await sf(xhr, { referer: eUrl })).json(); } catch { return null; }
  if (j && j.available === false) return null;
  return pickBest(j, maxHeight);
}

export default { createEporner, extractVidHash, pickBest, resolveStream };
if (typeof window !== "undefined") window.HoloXxxEporner = { createEporner, extractVidHash, pickBest, resolveStream };
