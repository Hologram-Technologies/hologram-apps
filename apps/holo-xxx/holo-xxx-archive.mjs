// holo-xxx-archive.mjs — Internet Archive as a CLEAN, LEGAL video source: public-domain & Creative-Commons
// erotica / vintage film over the public advancedsearch + metadata APIs (no key, CORS-open). Resolve-on-play
// yields a DIRECT mp4 download URL. Because this content is public-domain/owned, it fits the peer-shareable rights
// posture (unlike third-party tube bytes). Marked browseOnly: the catalogue is niche, so it surfaces as a "source"
// logo (openProvider) rather than diluting every category rail. Fetch is INJECTED; covers go through proxyUrl.
export function createArchive({ fetch: f, proxyUrl = (u) => u } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  const SUBJ = "mediatype:movies AND subject:erotica";        // keep results ADULT-only, never general film

  const norm = (d) => ({
    id: "ia:" + d.identifier, mediaType: "meta",
    title: String(d.title || d.identifier).slice(0, 90), performers: [], studio: "Internet Archive",
    date: d.year ? String(d.year) : "", tags: [],
    cover: proxyUrl("https://archive.org/services/img/" + encodeURIComponent(d.identifier)),
    tw: 0, th: 0, keep: true,                                   // film posters are often portrait — keep them (ambient-fit frames it)
    _provider: "archive", _src: "https://archive.org/details/" + d.identifier, _iaId: d.identifier,
  });

  async function search(q) {
    if (!doFetch) return [];
    const query = q && q.trim() ? `(${SUBJ}) AND (${q})` : SUBJ;
    const url = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(query)
      + "&fl[]=identifier&fl[]=title&fl[]=year&sort[]=downloads+desc&rows=24&output=json";
    try { const j = await (await doFetch(proxyUrl(url))).json(); return ((j.response && j.response.docs) || []).filter((d) => d && d.identifier).map(norm); } catch { return []; }
  }

  // resolve → the item's best video file as a direct download URL (Range-streamable through the proxy).
  async function resolve(scene) {
    const id = scene && (scene._iaId || (String(scene._src || "").match(/archive\.org\/details\/([^/?#]+)/) || [])[1]);
    if (!id || !doFetch) return null;
    try {
      const j = await (await doFetch(proxyUrl("https://archive.org/metadata/" + encodeURIComponent(id)))).json();
      const vids = (j.files || []).filter((x) => /\.(mp4|m4v|webm|ogv)$/i.test(x.name));
      if (!vids.length) return null;
      vids.sort((a, b) => ((/\.mp4$/i.test(b.name) ? 1 : 0) - (/\.mp4$/i.test(a.name) ? 1 : 0)) || ((+b.size || 0) - (+a.size || 0)));
      const best = vids[0];
      const url = "https://archive.org/download/" + encodeURIComponent(id) + "/" + best.name.split("/").map(encodeURIComponent).join("/");
      return { kind: "mp4", url, mp4: url, hls: null, label: best.height ? best.height + "p" : (best.format || "video") };
    } catch { return null; }
  }

  return { id: "archive", name: "Archive", color: "#1a8917", browseOnly: true, search, resolve };
}
export default { createArchive };
