// holo-xxx-xvideos.mjs — XVideos + XNXX providers for Holo XXX's multi-source aggregator.
//
// XVideos and XNXX are sister sites on the SAME platform (identical search markup, /video-<id> watch URLs, and
// inline html5player setVideoHLS/setVideoUrlHigh config) — so ONE family factory serves both, parameterized only
// by base URL + CDN host. Byte-free INDEX (search scrape → meta scenes with a watch URL) + resolve-on-play (watch
// page → signed adaptive HLS master + progressive mp4). Posture: Hologram hosts nothing; the source serves bytes
// on demand, projected native + ad-free; never bulk-fetched or re-broadcast. Static thumbs are landscape 16:9.

function createXvFamily({ id, name, color, base, cdn, fetch: f, proxyUrl = (u) => u } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  const cdnRe = cdn.replace(/[-]/g, "\\-");                        // CDN host substring for URL scans (e.g. xvideos-cdn / xnxx-cdn)
  const dec = (s) => String(s)
    .replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const unesc = (u) => String(u || "").replace(/\\\//g, "/");

  const norm = (it) => ({
    id: id + ":" + (it.id || it.url),
    mediaType: "meta",
    title: dec(it.title || ""),
    performers: [], studio: name, date: "", tags: [],
    cover: proxyUrl(it.thumb || ""),
    tw: 0, th: 0,                                                 // dims unknown from search markup → the wall's onload aspect-check is the real landscape filter (don't fake 16:9; portrait amateur uploads exist)
    duration: it.dur || null,
    _src: it.url,
    _provider: id,
  });

  // search grid: each result card is a title anchor `<a href="/video-<id>/<slug>" title="…">` (XVideos wraps it in
  // class="title", XNXX in class="thumb-under" — so DON'T depend on the wrapper) preceded by a lazy data-src CDN
  // thumb + a duration span. Associate each title with its NEAREST PRECEDING thumb/duration → robust to either
  // template. Dedup by path (the thumb-link + title-link can both point at the same /video URL).
  function parse(html) {
    const titleRe = /<a href="(\/video[^"]+)"\s+title="([^"]*)"/g;
    const thumbRe = new RegExp('data-src="(https:\\/\\/[^"]*' + cdnRe + '[^"]*\\.jpg[^"]*)"', "g");
    const durRe = /<span class="duration">([^<]+)<\/span>/g;
    const thumbs = [], durs = []; let m;
    while ((m = thumbRe.exec(html))) thumbs.push({ pos: m.index, v: m[1] });
    while ((m = durRe.exec(html))) durs.push({ pos: m.index, v: m[1].trim() });
    const before = (arr, pos) => { let v = ""; for (let i = arr.length - 1; i >= 0; i--) if (arr[i].pos < pos) { v = arr[i].v; break; } return v; };
    const seen = new Set(), out = [];
    while ((m = titleRe.exec(html))) {
      const path = m[1]; if (seen.has(path)) continue; seen.add(path);
      const vid = (path.match(/\/video-?\.?([^/]+)/) || [])[1] || path;
      out.push(norm({ url: base + path, title: m[2], id: vid, thumb: before(thumbs, m.index), dur: before(durs, m.index) || null }));
    }
    return out;
  }

  async function page(query, p) {
    if (!doFetch) return [];
    const url = base + "/?k=" + encodeURIComponent(query || "") + (p ? "&p=" + p : "");
    try { return parse(await (await doFetch(url)).text()); } catch { return []; }
  }

  // resolve(scene) → { kind, url, hls, mp4, label } | null. The watch page comes in >1 shape: inline
  // setVideoHLS/setVideoUrlHigh (single OR double quotes), or only a JSON-LD "contentUrl". Be robust: prefer the
  // adaptive HLS master (transcode picks the top variant), else collect EVERY progressive CDN mp4 and pick the best.
  async function resolve(scene) {
    if (!doFetch) return null;
    const watch = scene && (scene._src || scene.url); if (!watch) return null;
    let html; try { html = await (await doFetch(watch)).text(); } catch { return null; }
    const hlsRaw = new RegExp('(https?:[^"\'\\s\\\\]*' + cdnRe + '[^"\'\\s\\\\]*hls\\.m3u8[^"\'\\s\\\\]*)');
    const hls = unesc((html.match(/setVideoHLS\(['"]([^'"]+)['"]\)/) || [])[1] || (html.match(hlsRaw) || [])[1] || "") || null;
    const mp4s = [];
    const mp4Re = new RegExp('(https?:[^"\'\\s\\\\]*' + cdnRe + '[^"\'\\s\\\\]*video_\\d+p?\\.mp4[^"\'\\s\\\\]*)', "g");
    const push = (u) => { u = unesc(u); if (u && new RegExp(cdnRe).test(u) && /\.mp4/.test(u)) mp4s.push(u); };
    push((html.match(/setVideoUrlHigh\(['"]([^'"]+)['"]\)/) || [])[1]);
    push((html.match(/setVideoUrlLow\(['"]([^'"]+)['"]\)/) || [])[1]);
    push((html.match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/) || [])[1]);
    for (const m of html.matchAll(mp4Re)) push(m[1]);
    const resOf = (u) => { const m = String(u).match(/video_(\d+)p?\.mp4/); return m ? +m[1] : 0; };
    mp4s.sort((a, b) => resOf(b) - resOf(a));
    const mp4 = mp4s[0] || null;
    if (!hls && !mp4) return null;
    return { kind: hls ? "hls" : "mp4", url: hls || mp4, hls, mp4, label: hls ? "adaptive" : (resOf(mp4) ? resOf(mp4) + "p" : "source") };
  }

  return { id, name, color, enabled: !!doFetch, search: (q, p = 0) => page(q, p), browse: (p = 0) => page("", p), resolve };
}

export const createXvideos = (o = {}) => createXvFamily({ id: "xvideos", name: "XVideos", color: "#cf0a0a", base: "https://www.xvideos.com", cdn: "xvideos-cdn", ...o });
export const createXnxx = (o = {}) => createXvFamily({ id: "xnxx", name: "XNXX", color: "#0a3d91", base: "https://www.xnxx.com", cdn: "xnxx-cdn", ...o });
