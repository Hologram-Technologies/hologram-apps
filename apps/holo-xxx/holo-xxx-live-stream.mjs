// holo-xxx-live-stream.mjs — κ-LIVE: a public live broadcast as a continuously-growing, content-addressed κ-DAG.
//
// The transcode path (yt-dlp → ffmpeg → progressive WebM) is robust but high-latency and κ-blind. This is the
// Hologram-native path: when the engine can decode the SOURCE codec (H.264, e.g. the preview browser / a future
// host build), we play the LL-HLS fMP4 renditions DIRECTLY via MSE — no transcode, no extra process, sub-second.
// Each fMP4 segment is SEALED BY ITS κ (sha256 — the same serving axis as the VOD path) the instant it arrives,
// so the live tail becomes a verifiable κ-DAG: a viewer can SCRUB BACK through the cached window (a thing no cam
// site offers — uniquely enabled by content-addressing), and an instant rejoin replays the recent κ from cache.
//
// DEPENDENCY-INJECTED — imports nothing but its sibling parser. The caller passes { fetch, sha256hex } (+ a κ
// cache). The same parse/κ core is Node-witnessable; the MSE drive is browser-only.
//
// POSTURE: a public, consenting, publicly-broadcast stream, viewed on demand. The local κ-cache is the VIEWER's
// private scroll-back of what they are already watching — never re-broadcast (the owned-only peer rights gate is
// unchanged; third-party live is local-cache only, creator-owned live is peer-shareable elsewhere).

import { parseM3U8 } from "./holo-xxx-hls.mjs";

const SHA = "did:holo:sha256:";
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// videoCodecOf(initBytes) → RFC6381 video mime from the fMP4 init's avcC box (avc1.PPCCLL). Falls back to High@4.0.
export function videoCodecOf(b) {
  for (let i = 0; i + 8 < b.length; i++) {
    if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x43) { // 'avcC'
      const hx = (n) => n.toString(16).padStart(2, "0");
      return `video/mp4; codecs="avc1.${hx(b[i + 1 + 4])}${hx(b[i + 2 + 4])}${hx(b[i + 3 + 4])}"`;
    }
  }
  return 'video/mp4; codecs="avc1.4d4020"';
}

// playLiveDual(videoEl, opts) → controller. Drives a MediaSource from up to TWO LL-HLS media playlists (CB serves
// video-only + a separate AAC audio rendition), κ-sealing every segment into the cache as it lands, holding a
// scroll-back ring (ringSec) in the SourceBuffer. Returns { stop, stats, behindLive, jumpLive, rewind, graph }.
//   opts: { videoUrl, audioUrl?, fetch, sha256hex, cache?, onProgress?, onSegment?, ringSec? }
export function playLiveDual(videoEl, opts) {
  const { videoUrl, audioUrl = null, fetch: f, sha256hex, cache = null, onProgress = null, onSegment = null, onFail = null, ringSec = 150 } = opts;
  if (typeof MediaSource === "undefined") throw new Error("no MediaSource");
  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  let stopped = false, firstMs = null, segCount = 0, bytes = 0, fail = null;
  const t0 = now();
  const segMeta = [];                                              // the resolved κ-DAG (recipe) for replay/witness

  const u8 = async (url, kHint) => {
    if (cache && kHint) { try { const c = await cache.get(kHint); if (c) return c; } catch (_) {} }
    return new Uint8Array(await (await f(url)).arrayBuffer());      // origin → viewer, on demand
  };

  // a serialized append queue per SourceBuffer (appendBuffer is async; never append while updating). On a quota
  // overflow it evicts behind the scroll-back ring and retries — bounding memory while keeping the rewind window.
  function makeTrack(buf) {
    const q = []; let busy = false;
    const evict = () => { try { const br = buf.buffered; if (!br.length) return; const keepFrom = Math.max(0, (videoEl.currentTime || br.end(br.length - 1)) - ringSec); if (br.start(0) < keepFrom - 6 && !buf.updating) buf.remove(br.start(0), keepFrom - 6); } catch (_) {} };
    const pump = () => {
      if (busy || stopped || !q.length || buf.updating) return;
      busy = true; const b = q.shift();
      try { buf.appendBuffer(b); } catch (e) { busy = false; if (/quota/i.test(e && e.message || "")) { evict(); q.unshift(b); setTimeout(pump, 60); } }
    };
    buf.addEventListener("updateend", () => { busy = false; if (q.length > 30) evict(); pump(); });
    buf.addEventListener("error", () => { busy = false; });
    return { push: (b) => { q.push(b); pump(); } };
  }

  // poll ONE live media playlist forever: fetch init once → SourceBuffer; then append every new segment in order,
  // κ-sealing each; refresh near the segment cadence (LL). De-dupes by segment URL.
  async function runTrack(playlistUrl, kind) {
    let track = null, initDone = false, seen = new Set();
    while (!stopped) {
      let text; try { text = await (await f(playlistUrl)).text(); } catch (_) { await sleep(700); continue; }
      let parsed; try { parsed = parseM3U8(text, playlistUrl); } catch (_) { await sleep(700); continue; }
      const { initUrl, segUrls } = parsed;
      if (!initDone) {
        try {
          const ib = initUrl ? await u8(initUrl) : null;
          const mime = kind === "video" ? (ib ? videoCodecOf(ib) : 'video/mp4; codecs="avc1.4d4020"') : 'audio/mp4; codecs="mp4a.40.2"';
          // AUDIO is BEST-EFFORT: an unsupported/failed audio track must NEVER kill video — play video-only silently.
          if (!MediaSource.isTypeSupported(mime)) { if (kind === "audio") return; throw new Error("unsupported " + mime); }
          const buf = ms.addSourceBuffer(mime); track = makeTrack(buf);
          if (ib) track.push(ib);
          initDone = true;
        } catch (e) {
          if (kind === "audio") return;                            // video-only: drop the audio track, keep playing
          fail = e; stopped = true; if (onFail) try { onFail(e); } catch (_) {}   // VIDEO init failed → fatal (caller falls back)
          return;
        }
      }
      for (const su of segUrls) {
        if (seen.has(su) || stopped) continue; seen.add(su);
        let b; try { b = await u8(su); } catch (_) { continue; }
        const k = SHA + sha256hex(b); if (cache) { try { await cache.put(k, b); } catch (_) {} }
        track.push(b);
        if (kind === "video") { segCount++; bytes += b.length; segMeta.push({ kappa: k, len: b.length }); if (firstMs === null) { firstMs = now() - t0; if (onProgress) onProgress({ firstFrameMs: firstMs }); } }
        if (onSegment) onSegment({ kind, kappa: k, bytes: b.length });
      }
      if (seen.size > 600) seen = new Set([...seen].slice(-300));
      await sleep(kind === "video" ? 850 : 950);
    }
  }

  ms.addEventListener("sourceopen", () => {
    try { URL.revokeObjectURL(videoEl.src); } catch (_) {}
    runTrack(videoUrl, "video");
    if (audioUrl) runTrack(audioUrl, "audio");
    // start at — and stay near — the LIVE EDGE (low latency); native seeking within the buffer gives scroll-back.
    const ride = () => { if (stopped) return; try { const b = videoEl.buffered; if (b.length) { const end = b.end(b.length - 1); if (end - videoEl.currentTime > 8) videoEl.currentTime = end - 2.5; } } catch (_) {} };
    videoEl.addEventListener("progress", () => { if (videoEl.paused) return; });   // (kept light; ride() is explicit)
    setTimeout(ride, 1200);
  });

  return {
    // FULL teardown — remove every SourceBuffer (they otherwise leak against Chrome's global SourceBuffer cap and a
    // later addSourceBuffer throws "reached the limit"), end the stream, and revoke the object URL.
    stop() {
      stopped = true;
      try { if (ms.readyState === "open") { for (const sb of Array.from(ms.sourceBuffers)) { try { ms.removeSourceBuffer(sb); } catch (_) {} } } } catch (_) {}
      try { if (ms.readyState === "open") ms.endOfStream(); } catch (_) {}
      try { URL.revokeObjectURL(videoEl.src); } catch (_) {}
    },
    stats: () => ({ segCount, bytes, firstFrameMs: firstMs, fail: fail && fail.message }),
    behindLive() { try { const b = videoEl.buffered; return b.length ? Math.max(0, b.end(b.length - 1) - videoEl.currentTime) : 0; } catch { return 0; } },
    jumpLive() { try { const b = videoEl.buffered; if (b.length) videoEl.currentTime = b.end(b.length - 1) - 1.8; } catch (_) {} },
    rewind(sec = 30) { try { const b = videoEl.buffered; if (b.length) videoEl.currentTime = Math.max(b.start(0) + 0.5, videoEl.currentTime - sec); } catch (_) {} },
    graph: () => ({ "@type": "holo:MediaGraph", kind: "video", live: true, videos: [{ id: "live", representations: [{ segments: segMeta.slice() }] }] }),
  };
}

export default { playLiveDual, videoCodecOf };
