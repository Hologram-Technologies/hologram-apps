// holo-media-stream.mjs — verified playback over torrent chunk-tables (K3).
//
// Bytes reach the decoder ONLY after their piece re-derives (holo-torrent-kappa.mjs). Sources are the
// torrent's HTTPS webseeds (IA publishes them for every item) — no swarm needed; any .torrent with an
// HTTP source plays. Verified pieces are cached content-addressed (the piece hash IS the key) so replay
// is local, offline, and still verified. Audio streams progressively via MSE (first sound ≈ one piece);
// video (non-fragmented mp4 can't MSE-append) assembles a verified Blob. Refusals surface loudly.

import { torrentView, verifiedFileStream, webseedURL } from "./holo-torrent-kappa.mjs";

const CACHE = "holo-media-b";
const pieceKey = (h) => location.origin + "/.holo-piece/sha1/" + h;   // synthetic, cache-only URL (never fetched)
const cachePiece = async (h, bytes) => { try { await (await caches.open(CACHE)).put(pieceKey(h), new Response(bytes.slice())); } catch {} };
const cachedPiece = async (h) => { try { const r = await (await caches.open(CACHE)).match(pieceKey(h)); return r ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; } };

// view from a stored manifest object (plain JSON) or raw .torrent bytes
export async function viewOf(src) { return src instanceof Uint8Array ? torrentView(src) : src; }

// ── CLEAN chunk-manifest path (K3 robust): each media file hashed in 4MB windows over ITSELF — no
// cross-file spans, no non-CORS neighbours. fetch a chunk's byte-range from the file's own URL, verify
// its sha256, cache content-addressed, feed. This is the primary path for curated cards. ──────────────
const sha256hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8)), (b) => b.toString(16).padStart(2, "0")).join("");
export const cleanFileIndex = (man, base) => (man.files || []).findIndex((f) => (f.name || f.url).split("/").pop() === base || (f.url || "").endsWith("/" + base));

async function* verifiedCleanStream(file) {
  let off = 0;
  for (const ch of file.chunks) {
    const want = ch.sha256;
    let bytes = await cachedPiece(want);
    if (bytes && (await sha256hex(bytes)) !== want) bytes = null;                    // poisoned cache refuses too
    if (!bytes) {
      const r = await fetch(file.url, { headers: { range: `bytes=${off}-${off + ch.size - 1}` } });
      if (r.status !== 206 && !r.ok) throw new Error("source range " + r.status);
      bytes = new Uint8Array(await r.arrayBuffer());
      const got = await sha256hex(bytes);
      if (got !== want) { const e = new Error(`chunk @${off} refused — sha256 ${got.slice(0, 12)}… ≠ ${want.slice(0, 12)}…`); e.kappa = "sha256:" + want; throw e; }
      try { await cachePiece(want, bytes); } catch {}
    }
    off += ch.size;
    yield bytes;
  }
}

// verified progressive audio from a clean chunk-manifest file. Returns { url, done, close }.
export function openVerifiedCleanAudio(man, fileIdx, { onRefuse } = {}) {
  const file = man.files[fileIdx];
  const mse = "MediaSource" in window && MediaSource.isTypeSupported("audio/mpeg");
  let closed = false, url = "", ms = null;
  const pump = async (feed, finish) => {
    try { for await (const b of verifiedCleanStream(file)) { if (closed) return; await feed(b); } finish && finish(); }
    catch (e) { onRefuse && onRefuse(e); if (ms && ms.readyState === "open") { try { ms.endOfStream("network"); } catch {} } }
  };
  if (mse) {
    ms = new MediaSource(); url = URL.createObjectURL(ms);
    const done = new Promise((res) => ms.addEventListener("sourceopen", () => {
      const sb = ms.addSourceBuffer("audio/mpeg");
      const idle = () => new Promise((r) => (sb.updating ? sb.addEventListener("updateend", r, { once: true }) : r()));
      pump(async (b) => { await idle(); if (!closed) sb.appendBuffer(b); await idle(); }, async () => { await idle(); try { ms.endOfStream(); } catch {} res(); });
    }, { once: true }));
    return { url, done, close: () => { closed = true; try { URL.revokeObjectURL(url); } catch {} } };
  }
  const parts = [];
  const done = pump(async (b) => parts.push(b.slice()), null).then(() => (url = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }))));
  return { url: "", done, close: () => { closed = true; try { URL.revokeObjectURL(url); } catch {} } };
}

export function pickWebseed(view) { return (view.webseeds || []).find((u) => /^https:/.test(u)) || (view.webseeds || [])[0] || null; }
export const fileIndexByName = (view, base) => view.files.findIndex((f) => f.path === base || f.path.endsWith("/" + base) || f.path.split("/").pop() === base);
const rangeFetcher = (view, seed) => async (f, s, e) => {
  const r = await fetch(webseedURL(view, seed, f), { headers: { range: `bytes=${s}-${e - 1}` } });
  if (r.status !== 206 && !r.ok) throw new Error("source range " + r.status);
  return new Uint8Array(await r.arrayBuffer());
};

// ── verified progressive AUDIO (MSE audio/mpeg; falls back to a verified Blob) ───────────────────────
// Returns { url, done, close }: set url on an <audio>; `done` resolves when fully fed; close() tears down.
export function openVerifiedAudio(view, fileIdx, { onRefuse, onProgress } = {}) {
  const seed = pickWebseed(view);
  if (seed == null) throw new Error("no HTTP source in this torrent (webseed required)");
  const fetchRange = rangeFetcher(view, seed);
  const mse = "MediaSource" in window && MediaSource.isTypeSupported("audio/mpeg");
  let closed = false, mediaSource = null, url = "";
  const pump = async (feed, finish) => {
    try {
      for await (const seg of verifiedFileStream(view, fileIdx, fetchRange, { cachePiece, cachedPiece })) {
        if (closed) return;
        await feed(seg.bytes);
        onProgress && onProgress(seg);
      }
      finish && finish();
    } catch (e) { onRefuse && onRefuse(e); if (mediaSource && mediaSource.readyState === "open") { try { mediaSource.endOfStream("network"); } catch {} } }
  };
  if (mse) {
    mediaSource = new MediaSource();
    url = URL.createObjectURL(mediaSource);
    const done = new Promise((res) => {
      mediaSource.addEventListener("sourceopen", () => {
        const sb = mediaSource.addSourceBuffer("audio/mpeg");
        const idle = () => new Promise((r) => (sb.updating ? sb.addEventListener("updateend", r, { once: true }) : r()));
        pump(async (bytes) => { await idle(); if (!closed) sb.appendBuffer(bytes); await idle(); },
             async () => { await idle(); try { mediaSource.endOfStream(); } catch {} res(); });
      }, { once: true });
    });
    return { url, done, close: () => { closed = true; try { URL.revokeObjectURL(url); } catch {} } };
  }
  // Blob fallback: verify everything, then one URL (no partial feed — still refuse-on-tamper)
  const parts = [];
  const done = pump(async (b) => parts.push(b.slice()), null).then(() => {
    url = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
    return url;
  });
  return { url: "", done, close: () => { closed = true; try { URL.revokeObjectURL(url); } catch {} } };
}

// ── verified whole-file Blob (short films / any file) ────────────────────────────────────────────────
export async function verifiedBlobURL(view, fileIdx, type, { onRefuse, onProgress } = {}) {
  const seed = pickWebseed(view);
  if (seed == null) throw new Error("no HTTP source in this torrent (webseed required)");
  const fetchRange = rangeFetcher(view, seed);
  const parts = [];
  try {
    for await (const seg of verifiedFileStream(view, fileIdx, fetchRange, { cachePiece, cachedPiece })) { parts.push(seg.bytes.slice()); onProgress && onProgress(seg); }
  } catch (e) { onRefuse && onRefuse(e); throw e; }
  return URL.createObjectURL(new Blob(parts, { type: type || "video/mp4" }));
}
