// holo-pin.mjs — pin fetched media (a LibriVox mp3) to κ and play it BY κ, verified. The point: the audio the
// reader plays is content-addressed, not a passthrough to archive.org — so it streams from any source and a
// flipped byte fails closed (L5). This module is the thin app-side seam over the OS streaming substrate: in the
// host, `store` is holo-content-net / holo-stream (SW-served, Bao-verified); in Node, a Map proves the κ logic.
//
//   pin(store, bytes) → { kappa, url }          (κ = blake3 over bytes; url = a κ-resolving playback URL)
//   resolveVerified(store, kappaOrUrl) → bytes  (re-derives κ, throws on mismatch — verify before you trust)
//   kappaUrl(kappa) / parseKappaUrl(url)        (the runtime SW maps this scheme onto the κ block resolver)
//
// Pure κ logic → Node witnesses pin/resolve/tamper; the real store swaps in without changing callers.

import { kappaOf } from "./holo-kappa.mjs";

const SCHEME = "holo-k:";
export const kappaUrl = (kappa) => SCHEME + kappa;                      // holo-k:blake3:<hex> — SW resolves to bytes
export const parseKappaUrl = (u) => (String(u || "").startsWith(SCHEME) ? String(u).slice(SCHEME.length) : u);

// a Map-backed store for Node witnesses; the host passes holo-content-net (put/get by κ, SW-served).
export function createMemStore() {
  const m = new Map();
  return { has: (k) => m.has(k), get: (k) => m.get(k), set: (k, b) => m.set(k, b), get size() { return m.size; } };
}

// pin bytes by content address (idempotent — same bytes ⇒ same κ ⇒ stored once).
export function pin(store, bytes) {
  const kappa = kappaOf(bytes);
  if (!store.has(kappa)) store.set(kappa, bytes);
  return { kappa, url: kappaUrl(kappa) };
}

// resolve + VERIFY: re-derive the κ from the bytes and refuse a mismatch (L5). This is what makes playback
// tamper-proof regardless of where the bytes came from.
export function resolveVerified(store, kappaOrUrl) {
  const kappa = parseKappaUrl(kappaOrUrl);
  const bytes = store.get(kappa);
  if (!bytes) throw new Error("holo-pin: no bytes for " + kappa);
  if (kappaOf(bytes) !== kappa) throw new Error("holo-pin: κ mismatch (tamper) for " + kappa);
  return bytes;
}

// pin an ordered set of chapter/section audio blobs → [{ kappa, url, sec? }] (the playlist the reader streams).
export function pinTracks(store, tracks /* [{ bytes, sec?, title? }] */) {
  return tracks.map((t) => { const { kappa, url } = pin(store, t.bytes); return { kappa, url, sec: t.sec || 0, title: t.title || "" }; });
}

export default { kappaUrl, parseKappaUrl, createMemStore, pin, resolveVerified, pinTracks };
if (typeof window !== "undefined") window.HoloPin = { kappaUrl, parseKappaUrl, createMemStore, pin, resolveVerified, pinTracks };
