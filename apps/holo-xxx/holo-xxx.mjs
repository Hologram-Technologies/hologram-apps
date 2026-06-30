// holo-xxx.mjs — the Holo XXX orchestrator (browser-safe: no TEE graph imported here). It wires discovery and the
// quality pick. The privacy spine — sealing the collection under the operator's biometric, and the payload-bound
// step-up to open a scene — lives in holo-xxx-seal.mjs (the real holospace-identity / holo-stepup seam), which the
// UI dynamic-imports only when locking/unlocking. Keeping it out of this module means the immersive grid loads
// without dragging in WebAuthn/session code it doesn't need to render.
//
//   makeHub({ stashApiKey, fetch, cache, ownedSource }) → a SceneHub with StashDB (metadata) + owned (bytes)
//   bestRep(graph, videoId?)        → the top representation (4K/60 if present), for the "quality" badge + player
//   qualityBadge(rep)               → human label for the top rep ("4K60", "1080p", …)

import { createSceneHub } from "./holo-scene.mjs";
import { createStashDB } from "./holo-xxx-stashdb.mjs";
import { createOwnedScenes } from "./holo-xxx-owned.mjs";
import { resolveStashKey, createKappaCache } from "./holo-xxx-config.mjs";

// makeHub — assemble discovery. The StashDB key defaults to the OS-resolved one (window→localStorage→env; null →
// provider self-disables, hub runs on owned content alone). The cache defaults to a content-addressed κ-cache so
// repeat queries are instant. Pass explicit values to override (the witness injects a mock fetch + key). Provider
// order is irrelevant; the hub merges by scene key regardless.
export function makeHub({ stashApiKey, fetch, cache, ownedSource } = {}) {
  const apiKey = stashApiKey !== undefined ? stashApiKey : resolveStashKey();
  const kcache = cache || createKappaCache();
  const hub = createSceneHub();
  hub.register(createStashDB({ apiKey, fetch, cache: kcache }));
  if (ownedSource) hub.register(createOwnedScenes({ source: ownedSource }));
  return hub;
}

// bestRep — the exceptional-quality pick: highest (height, then bitrate) representation in the graph. The player
// then hands this to holo-media.openStream via opts.quality; openStream still gates on MSE.isTypeSupported, so a
// device that can't decode 4K/60 falls back to the best it CAN, never to a broken stream (Law L2: bit-exact only).
export function bestRep(graph, videoId = null) {
  const v = (graph.videos || []).find((x) => x.id === videoId) || (graph.videos || [])[0];
  if (!v) return null;
  return (v.representations || []).reduce((best, r) =>
    !best || (r.height || 0) > (best.height || 0) ||
    ((r.height || 0) === (best.height || 0) && (r.bitrate || 0) > (best.bitrate || 0)) ? r : best, null);
}

// qualityBadge — a human label for the top rep ("4K60", "1080p", …). The fps suffix only shows when the graph
// records it (ingest can stamp r.fps); height alone otherwise.
export function qualityBadge(rep) {
  if (!rep) return "";
  const h = rep.height || 0;
  const tier = h >= 4320 ? "8K" : h >= 2160 ? "4K" : h >= 1440 ? "1440p" : h >= 1080 ? "1080p" : h >= 720 ? "720p" : h ? h + "p" : "";
  return tier + (rep.fps && rep.fps >= 48 ? String(Math.round(rep.fps)) : "");
}

// Privacy lives in holo-xxx-seal.mjs (real holospace-identity.sealState + payload-bound holo-stepup). It is not
// imported here so this module stays browser-light; the UI loads it on demand to lock/unlock.

export default { makeHub, bestRep, qualityBadge };
if (typeof window !== "undefined") window.HoloXXX = { makeHub, bestRep, qualityBadge };
