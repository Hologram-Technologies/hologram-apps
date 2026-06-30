// holo-xxx-redgifs.mjs — RedGifs provider for Holo XXX's multi-source aggregator.
//
// RedGifs has a clean public JSON API (no scraping): a temporary bearer token (GET, no auth) then GET
// /v2/gifs/search → each gif carries its HD mp4 + poster + pixel dimensions INLINE. So the INDEX and the RESOLVE
// are one call — resolve is instant (the mp4 is already in hand). Same posture as the other providers: byte-free
// meta scenes; the source serves the bytes on demand; nothing is bulk-fetched or re-broadcast.
//
// Auth: the holo:// page can't set an Authorization header cross-origin, so in the BROWSER we hand the bearer to
// the DoH proxy via &auth= (the proxy forwards it). In NODE (witness, proxyUrl = identity) we set the header
// directly. Tokens last hours → cached per instance.

export function createRedgifs({ fetch: f, proxyUrl = (u) => u } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  const dec = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');

  let tokenP = null;
  const token = () => {
    if (!tokenP) tokenP = (async () => {
      try { return (await (await doFetch(proxyUrl("https://api.redgifs.com/v2/auth/temporary"))).json()).token || null; }
      catch { tokenP = null; return null; }
    })();
    return tokenP;
  };

  async function api(path) {
    if (!doFetch) return null;
    const apiUrl = "https://api.redgifs.com" + path;
    const t = await token();
    const proxied = proxyUrl(apiUrl);
    try {
      if (proxied === apiUrl) return await (await doFetch(apiUrl, { headers: t ? { authorization: "Bearer " + t } : {} })).json();  // node: header
      return await (await doFetch(proxied + "&auth=" + encodeURIComponent("Bearer " + (t || "")))).json();                          // browser: via proxy &auth=
    } catch { return null; }
  }

  // RedGifs clips have no real title → use the top tags (or the creator). Dimensions drive the wall's landscape gate.
  const norm = (g) => ({
    id: "redgifs:" + g.id,
    mediaType: "meta",
    title: dec(((g.tags && g.tags.slice(0, 3).join(" ")) || g.userName || g.id || "").trim()),
    performers: g.userName ? [g.userName] : [],
    studio: "RedGifs",
    date: "",
    tags: (g.tags || []).slice(0, 10),
    cover: proxyUrl((g.urls && (g.urls.thumbnail || g.urls.poster || g.urls.sd)) || ""),
    tw: g.width || 16, th: g.height || 9,
    duration: g.duration ? Math.round(g.duration) : null,
    _src: "https://www.redgifs.com/watch/" + g.id,
    _provider: "redgifs",
    _mp4: (g.urls && (g.urls.hd || g.urls.sd)) || null,            // the playable stream — already in hand
  });

  async function search(q, p = 0, count = 40) {
    const j = await api("/v2/gifs/search?search_text=" + encodeURIComponent(q || "") + "&order=trending&count=" + count + "&page=" + ((p | 0) + 1));   // p = 0-based → API is 1-based
    return (j && j.gifs || []).map(norm).filter((s) => s._mp4);
  }

  // The mp4 is already resolved at search time — return it instantly (engine-adaptive play happens upstream).
  async function resolve(scene) {
    const mp4 = scene && scene._mp4; if (!mp4) return null;
    return { kind: "mp4", url: mp4, mp4, hls: null, label: "hd" };
  }

  return {
    id: "redgifs", name: "RedGifs", color: "#0f8b8d",
    enabled: !!doFetch,
    search: (q, p = 0) => search(q, p),
    browse: (p = 0) => search("trending", p),
    resolve,
  };
}
