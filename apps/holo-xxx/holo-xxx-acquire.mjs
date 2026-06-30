// holo-xxx-acquire.mjs — the honest acquisition edge. An index-only scene (a StashDB metadata entry you don't
// own) shows a "stream/acquire" affordance. Acquisition is the USER's explicit action and the ToS/legal boundary:
// the OS never auto-fetches or redistributes others' bytes. This module does two things, and NEITHER fetches video:
//
//   planAcquire(url)  → PURE. Recognize the page (holo-media-route.classifyMedia: YouTube/Vimeo/Twitch/DM/archive,
//                       + yt-dlp's ~1000 sites from the page URL) and return the EXACT steps the user's own machine
//                       would run (the yt-dlp command + the /sc/vstream route). It plans; it does not act.
//   acquireIntoCollection({ graph, work, tags, collection }) → once the user HAS produced a κ-sealed MediaGraph
//                       (holo-xxx-ingest on their machine), seal it into a scene and append it to the owned,
//                       sealed collection. This is the manufacture→own step; the bytes were the user's to ingest.
//
// Relative lib import → resolves for the Node witness and a repo-root server; /_shared in the native runtime.

import { classifyMedia, buildVstreamSrc } from "../../../holo-os/system/os/usr/lib/holo/holo-media-route.mjs";
import { manufactureScene } from "./holo-collection.mjs";
import { RIGHTS } from "./holo-scene-manifest.mjs";

// PLAN ONLY — no network. Returns the recognized shape + the commands the user would run themselves.
export function planAcquire(url, { maxH = 2160 } = {}) {
  const m = classifyMedia(url);                                   // null if not an http(s) watch page
  const canonical = m?.canonical || url;
  const recognized = !!m;
  // yt-dlp resolves the page URL directly; we pin avc1≤maxH + m4a and remux to fMP4 κ-segments (bit-exact).
  const ytdlp = `node holo-apps/apps/holo-xxx/holo-xxx-ingest.mjs --acquire ${JSON.stringify(canonical)}  (user's machine; yt-dlp + ffmpeg)`;
  return {
    recognized,
    platform: m?.platform || "generic",
    canonical,
    vstream: buildVstreamSrc(canonical, maxH),                    // the proven /sc/vstream route (native projector)
    ytdlp,
    note: "Acquisition runs on YOUR machine and is YOUR call (ToS boundary). Holo XXX seals what you produce; it never fetches or hosts it for you.",
  };
}

// MANUFACTURE → OWN — seal a user-produced MediaGraph into a scene and add it to the collection. The metadata
// (title/performers/studio/tags) comes from the StashDB index entry the user was viewing; the bytes are theirs.
export function acquireIntoCollection({ graph, work, tags = [], collection, sources = [] }) {
  if (!graph) throw new Error("holo-xxx-acquire: need a κ-sealed MediaGraph (produced by holo-xxx-ingest on the user's machine)");
  const { scene, blobs } = manufactureScene({ work, graph, tags, rightsClass: RIGHTS.USER_OWNED, sources });
  if (collection) collection.add(scene);                          // now owned + (when sealed) encrypted at rest
  return { scene, blobs };
}

export default { planAcquire, acquireIntoCollection };
if (typeof window !== "undefined") window.HoloXxxAcquire = { planAcquire, acquireIntoCollection };
