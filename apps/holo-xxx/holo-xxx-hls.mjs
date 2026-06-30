// holo-xxx-hls.mjs — RESOLVE-ON-PLAY: an HLS media playlist (m3u8) → a κ-MediaGraph + a streaming, low-latency
// native feed. This is AlohaTube's "resolve the source's M3U8 and play it" done NATIVELY: parse the playlist,
// fetch the init + media segments, SEAL EACH BY ITS κ (sha256 — the same serving axis as P0–P2) on arrival, and
// FEED segment 0 to the decoder BEFORE the tail resolves (seg0-to-first-frame is the felt latency). It emits a
// MediaGraph (with κs) so a repeat view streams BY κ from the private cache, origin-independent.
//
// DEPENDENCY-INJECTED — imports nothing. The caller passes { fetch, sha256hex } (+ a cache, + the browser's
// MediaSource for playHls). So the parse / κ / graph core runs in the Node witness, and the same code drives MSE
// in the browser. No mount-point branching.
//
// POSTURE: the bytes flow origin → viewer on demand (the source CDN serves them, like AlohaTube's embed). We host
// nothing; we content-address what we resolve for a PRIVATE cache. Peer-sharing a resolved scene is refused
// upstream (holo-xxx-peer's rights gate) — a resolved third-party scene is not owned.

const SHA = "did:holo:sha256:";

// absolutize a (possibly relative) URL against the page/document base, so segment URLs resolve correctly. A
// relative m3u8 URL ("./media/…") cannot be a URL() base, so we anchor it to location.href in the browser first.
export function absUrl(u) {
  try { return new URL(u).href; } catch (_) {}
  try { return new URL(u, (typeof location !== "undefined" ? location.href : "file:///")).href; } catch (_) { return u; }
}

// parseM3U8(text, baseUrl) → { initUrl, segUrls } — resolve relative URIs against the playlist URL (mirrors the
// node holo-tube-ingest.genFromHls reader: #EXT-X-MAP:URI is the fMP4 init; non-# lines are media segments).
export function parseM3U8(text, baseUrl) {
  if (!/#EXTM3U/.test(text)) throw new Error("not an HLS playlist");
  const root = absUrl(baseUrl);
  const abs = (u) => { try { return new URL(u, root).href; } catch { return u; } };
  const init = (text.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1];
  const segUrls = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(abs);
  return { initUrl: init ? abs(init) : null, segUrls };
}

// codecStringFromInit(initBytes) → the RFC 6381 mime, read from the fMP4 init's avcC box (no guessing). Falls back
// to High@4.0 + AAC-LC. Browser- and Node-safe (pure byte scan).
export function codecStringFromInit(b) {
  for (let i = 0; i + 8 < b.length; i++) {
    if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x43) {
      const hx = (n) => n.toString(16).padStart(2, "0");
      return `video/mp4; codecs="avc1.${hx(b[i + 5])}${hx(b[i + 6])}${hx(b[i + 7])}, mp4a.40.2"`;
    }
  }
  return 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
}

// resolveGraph({ m3u8Url, fetch, sha256hex, height, onSegment }) → { graph, bytesByKappa, mime } — the OFF-MSE core
// (Node-witnessable). Fetches the playlist + init + each segment, computes κ, builds a one-rep MediaGraph. onSegment
// (index, kappa, bytes, isInit) fires per fetched part, IN ORDER — that's the streaming hook the player feeds MSE on.
export async function resolveGraph({ m3u8Url, fetch: f, sha256hex, height = null, onSegment = null }) {
  const text = await (await f(m3u8Url)).text();
  const { initUrl, segUrls } = parseM3U8(text, m3u8Url);
  if (!initUrl) throw new Error("HLS playlist has no fMP4 init (#EXT-X-MAP) — only fMP4 is MSE-feedable bit-exact");
  const bytesByKappa = new Map();
  const u8 = async (u) => new Uint8Array(await (await f(u)).arrayBuffer());
  const initBytes = await u8(initUrl);
  const mime = codecStringFromInit(initBytes);
  const initKappa = SHA + sha256hex(initBytes);
  bytesByKappa.set(initKappa, initBytes);
  if (onSegment) onSegment(-1, initKappa, initBytes, true);
  const segments = [];
  for (let i = 0; i < segUrls.length; i++) {
    const b = await u8(segUrls[i]);                      // origin → viewer, on demand (AlohaTube posture)
    const k = SHA + sha256hex(b);
    bytesByKappa.set(k, b);
    segments.push({ kappa: k, dur: 2, bytes: b.length, len: b.length, src: segUrls[i] });
    if (onSegment) onSegment(i, k, b, false);            // ← seg0 fires first; the player feeds it immediately
  }
  const graph = {
    "@context": { holo: "https://hologram.os/ns#" }, "@type": "holo:MediaGraph", kind: "video", live: false,
    videos: [{ id: "resolved", representations: [{ mime, height, width: height ? Math.round(height * 16 / 9) : null, initSegment: initKappa, initSrc: initUrl, segments }] }],
  };
  return { graph, bytesByKappa, mime };
}

// playHls(videoEl, opts) → controller. BROWSER: drive MediaSource from an m3u8, feeding seg0 the instant it lands
// (low latency), sealing each segment by κ into the cache as it arrives. Returns { stop(), stats(), graph() }.
//   opts: { m3u8Url, fetch, sha256hex, cache?, onProgress?, height? }   cache = { get(κ), put(κ,bytes) } (private).
export function playHls(videoEl, opts) {
  const { m3u8Url, fetch: f, sha256hex, cache = null, onProgress = null, height = null, knownGraph = null } = opts;
  // knownGraph (from a PRIOR resolve) carries the segment κs in order → a repeat view fetches each segment FROM
  // THE κ-CACHE (origin-independent, instant) instead of re-hitting the source. First resolve has none.
  const knownRep = knownGraph && knownGraph.videos && knownGraph.videos[0] && knownGraph.videos[0].representations[0];
  const knownInitK = knownRep && knownRep.initSegment, knownSegK = (knownRep && knownRep.segments || []).map((s) => s.kappa);
  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  let stopped = false, sb = null, verified = 0, bytes = 0, firstFrameMs = null, t0 = (performance || Date).now();
  const segmentsMeta = []; let initKappa = null, mime = null;
  const append = (b) => new Promise((res, rej) => {
    const done = () => { sb.removeEventListener("updateend", done); sb.removeEventListener("error", err); res(); };
    const err = () => { sb.removeEventListener("updateend", done); sb.removeEventListener("error", err); rej(new Error("SourceBuffer append error")); };
    sb.addEventListener("updateend", done); sb.addEventListener("error", err); sb.appendBuffer(b);
  });
  const getBytes = async (u, kHint) => {                 // cache-first: a repeat view serves κ from cache, no origin
    if (cache && kHint) { try { const c = await cache.get(kHint); if (c) return c; } catch (_) {} }
    return new Uint8Array(await (await f(u)).arrayBuffer());
  };

  ms.addEventListener("sourceopen", async () => {
    URL.revokeObjectURL(videoEl.src);
    try {
      const text = await (await f(m3u8Url)).text();
      const { initUrl, segUrls } = parseM3U8(text, m3u8Url);
      if (!initUrl) throw new Error("HLS playlist has no fMP4 init (#EXT-X-MAP)");
      const initBytes = await getBytes(initUrl, knownInitK);   // κ known on repeat → served from cache
      mime = codecStringFromInit(initBytes); initKappa = SHA + sha256hex(initBytes);
      if (cache) try { await cache.put(initKappa, initBytes); } catch (_) {}
      sb = ms.addSourceBuffer(mime);
      await append(initBytes);                            // init MUST precede media
      for (let i = 0; i < segUrls.length && !stopped; i++) {
        const k0 = knownSegK[i] || null;                  // κ from a prior resolve → cache-hit; else fetch origin
        const b = await getBytes(segUrls[i], k0);
        const k = SHA + sha256hex(b);
        if (cache) try { await cache.put(k, b); } catch (_) {}
        await append(b);
        verified++; bytes += b.length;
        segmentsMeta.push({ kappa: k, dur: 2, bytes: b.length, len: b.length, src: segUrls[i] });
        if (firstFrameMs === null) firstFrameMs = (performance || Date).now() - t0;   // seg0-to-first-frame
        if (onProgress) onProgress({ verified, bytes, firstFrameMs, buffered: bufferedAhead(videoEl) });
      }
      if (!stopped && ms.readyState === "open") ms.endOfStream();
    } catch (e) { try { if (ms.readyState === "open") ms.endOfStream("decode"); } catch (_) {} if (onProgress) onProgress({ error: e.message }); }
  });

  return {
    stop() { stopped = true; try { if (ms.readyState === "open") ms.endOfStream(); } catch (_) {} },
    stats: () => ({ verified, bytes, firstFrameMs }),
    // the resolved κ-MediaGraph (recipe) — cache it; a repeat view replays by κ from the private cache.
    graph: () => ({ "@type": "holo:MediaGraph", kind: "video", live: false, videos: [{ id: "resolved", representations: [{ mime, height, initSegment: initKappa, segments: segmentsMeta.slice() }] }] }),
  };
}
function bufferedAhead(v) { try { const b = v.buffered; return b && b.length ? Math.max(0, b.end(b.length - 1) - v.currentTime) : 0; } catch { return 0; } }

export default { parseM3U8, codecStringFromInit, resolveGraph, playHls };
