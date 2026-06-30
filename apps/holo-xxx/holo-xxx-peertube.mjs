// holo-xxx-peertube.mjs — PeerTube (the federated fediverse video network) as a CLEAN, LEGAL, OPEN-API source:
// creator-licensed NSFW videos via SepiaSearch (the official global index) + each instance's public REST API.
// Resolve yields a direct web-video mp4 (or HLS). Open + federated + creator-owned → the most κ-aligned external
// source. Marked browseOnly (modest catalogue) → a "source" logo, not in every category rail. Fetch is INJECTED.
export function createPeerTube({ fetch: f, proxyUrl = (u) => u, index = "https://sepiasearch.org" } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);

  const norm = (v) => ({
    id: "pt:" + v.uuid, mediaType: "meta",
    title: String(v.name || "").slice(0, 90),
    performers: [v.account && (v.account.displayName || v.account.name)].filter(Boolean),
    studio: "PeerTube", date: String(v.publishedAt || "").slice(0, 10), tags: (v.tags || []).slice(0, 8),
    cover: proxyUrl(v.thumbnailUrl || ""), tw: 16, th: 9,
    _provider: "peertube", _src: v.url || "", _ptHost: v.account && v.account.host, _ptUuid: v.uuid,
  });

  async function search(q) {
    if (!doFetch) return [];
    // nsfw=true to include adult; durationMin filters out the many erotic-AUDIO posts; -match = relevance.
    const url = index + "/api/v1/search/videos?search=" + encodeURIComponent(q || "")
      + "&nsfw=true&count=24&sort=-match&durationMin=30";
    try { const j = await (await doFetch(proxyUrl(url))).json(); return ((j.data) || []).filter((v) => v && v.uuid && !v.isLive).map(norm); } catch { return []; }
  }

  // resolve via the source instance's public API → highest-resolution direct file (skip audio-only res 0), else HLS.
  async function resolve(scene) {
    const host = scene && scene._ptHost, uuid = scene && scene._ptUuid;
    if (!host || !uuid || !doFetch) return null;
    try {
      const j = await (await doFetch(proxyUrl("https://" + host + "/api/v1/videos/" + uuid))).json();
      const direct = (j.files || []).filter((x) => x && x.resolution && x.resolution.id > 0 && (x.fileUrl || x.fileDownloadUrl));
      if (direct.length) {
        direct.sort((a, b) => (b.resolution.id || 0) - (a.resolution.id || 0));
        const url = direct[0].fileUrl || direct[0].fileDownloadUrl;
        return { kind: "mp4", url, mp4: url, hls: null, label: (direct[0].resolution.label || "") };
      }
      const hls = (j.streamingPlaylists || [])[0];
      if (hls && hls.playlistUrl) return { kind: "hls", url: hls.playlistUrl, hls: hls.playlistUrl, mp4: null, label: "hls" };
    } catch (_) {}
    return null;
  }

  return { id: "peertube", name: "PeerTube", color: "#f1680d", browseOnly: true, search, resolve };
}
export default { createPeerTube };
