// holo-collection.mjs — the flagship orchestrator: discover → OWN → stream → SHARE-running, the video analogue of
// holo-library. It ties the scene kernels together with REAL content-addressing (reuses holo-content-net.kappaOf,
// the same blake3 κ the rest of the OS uses) so the chain is honest end to end:
//   • manufactureScene — pin the MediaGraph RECIPE to a blake3 κ (which transitively pins every segment by its
//     sha256 serving κ via the segment closure), seal a holo-scene manifest. The actual video bytes are NOT
//     copied into the collection — they live content-addressed in the κ-fabric and stream by κ on demand.
//   • createCollection — ownership: an append-only manifest whose head κ attests every scene you own (models
//     holo-home / holo-strand — the collection you carry, no server).
//   • shareScene      — one self-contained link carrying the manifest + graph RECIPE (tiny: just κ lists). The
//     recipient streams the segments by their κ from the fabric/peer, each L5-verified at the decoder.
//   • openShared      — open on a FRESH device, origin offline: re-derive the graph κ + the title κ (L5 verify-
//     before-trust), cross-check the segment closure, hand back a descriptor the player feeds to openStream.
//
// Pure ESM (kappaOf is pure blake3) → Node witnesses the whole chain. The byte-streaming itself rides holo-media's
// openStream(), which re-derives each segment against its sha256 κ before the decoder — so even shared bytes from
// an untrusted peer are refused on a single flipped bit (Law L5).

import { kappaOf } from "../holo-import/holo-content-net.mjs";
import { mediaGraphClosureKappa } from "../../../holo-os/system/os/usr/lib/holo/holo-media.mjs";
import { sealScene, verifyScene, RIGHTS } from "./holo-scene-manifest.mjs";

const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
const unb64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

// canonical graph bytes: the MediaGraph JSON is the recipe whose blake3 κ IS the scene's video identity. Pretty-
// printing is irrelevant to identity, but we fix it so the κ is reproducible from the same graph object.
export const graphBytes = (graph) => te.encode(JSON.stringify(graph));

// OWN IT — seal a scene over a MediaGraph the user holds. The video track κ is blake3(graph recipe); the segment
// closure κ (sha256, holo-media serving axis) is recorded in provenance so every byte is pinned and cross-checkable.
export function manufactureScene({ work, graph, tags = [], coverBytes = null, rightsClass = RIGHTS.USER_OWNED, sources = [] }) {
  if (!graph || !Array.isArray(graph.videos)) throw new Error("holo-collection: manufactureScene needs a MediaGraph { videos:[...] }");
  const blobs = new Map();
  const gb = graphBytes(graph);
  const videoKappa = kappaOf(gb); blobs.set(videoKappa, gb);
  const cover = coverBytes ? kappaOf(coverBytes) : null; if (cover) blobs.set(cover, coverBytes);
  const segmentClosure = mediaGraphClosureKappa(graph);          // sha256 root over every segment κ (Law L5)
  const scene = sealScene({
    work: { ...work, cover },
    video: videoKappa,
    tags,
    provenance: { sources, license: rightsClass === RIGHTS.PUBLIC_DOMAIN ? "Public Domain" : "Owned", derived: true, segmentClosure },
    rights: { class: rightsClass },
  });
  return { scene, graph, blobs };
}

// OWNERSHIP — an append-only collection manifest; head κ attests the exact set of scenes you own (carry, no server).
// The head is what holo-xxx.sealCollection encrypts at rest under a TEE-derived key — your library, sealed.
export function createCollection(owner = "me") {
  const entries = [];
  const headOf = () => kappaOf(te.encode(owner + "|" + entries.map((e) => e.kappa).join(",")));
  let head = headOf();
  return {
    owner,
    add(scene) { entries.push({ kappa: scene.kappa, title: scene.work.title }); head = headOf(); return head; },
    has(kappa) { return entries.some((e) => e.kappa === kappa); },
    list() { return entries.slice(); },
    get head() { return head; },
    verifyHead() { return head === headOf(); },                  // L5 over the manifest itself
    serialize() { return te.encode(JSON.stringify({ owner, entries })); },   // the bytes sealCollection encrypts
  };
}

// SHARE-RUNNING — one self-contained link carrying the RECIPE (manifest + graph), not the bytes. The graph is just
// κ lists, so the link is tiny regardless of the video's size; the recipient streams the actual segments by κ from
// the fabric/peer, each re-derived at the decoder. Inline #k= always fits for the recipe.
export function shareScene(scene, blobs, { maxInline = 256 * 1024 } = {}) {
  // carry only the recipe blobs (graph + cover) — NOT segment bytes (those resolve by κ over the fabric).
  const recipe = new Map([...blobs].filter(([k]) => k === scene.video || k === scene.work?.cover));
  const total = [...recipe.values()].reduce((n, b) => n + b.length, 0);
  const payload = { v: 1, scene, blobs: [...recipe.entries()].map(([k, b]) => [k, b64(b)]) };
  const enc = b64(te.encode(JSON.stringify(payload)));
  if (total <= maxInline) return { mode: "inline", total, link: "holo://xxx#k=" + enc, payload };
  return { mode: "car", total, link: "holo://xxx#car=" + kappaOf(te.encode(JSON.stringify(payload))).slice(7, 23), payload };
}

function parseLink(link) {
  const i = link.indexOf("#k=");
  if (i < 0) throw new Error("holo-collection: openShared needs an inline #k= link (a #car= link must be fetched first)");
  return JSON.parse(td.decode(unb64(link.slice(i + 3))));
}

// OPEN ON A FRESH DEVICE — origin offline. Verify the recipe against its κ (L5), verify the scene, cross-check the
// segment closure, hand back { scene, graph } ready for openStream(). Fail-closed on tamper/missing. This step is
// IO-free (it verifies only the recipe); the byte streaming that follows is itself L5-verified per segment.
export function openShared(linkOrPayload) {
  const payload = typeof linkOrPayload === "string" ? parseLink(linkOrPayload) : linkOrPayload;
  const scene = payload.scene;
  const blobs = new Map(payload.blobs.map(([k, b]) => [k, unb64(b)]));
  for (const k of [scene.video, scene.work && scene.work.cover].filter(Boolean)) {
    const bytes = blobs.get(k);
    if (!bytes) throw new Error("holo-collection: missing recipe blob for " + k);
    if (kappaOf(bytes) !== k) throw new Error("holo-collection: κ mismatch (tamper) for " + k);   // L5 tripwire
  }
  if (!verifyScene(scene)) throw new Error("holo-collection: scene κ failed to verify");
  const graph = JSON.parse(td.decode(blobs.get(scene.video)));
  const closure = mediaGraphClosureKappa(graph);
  if (scene.provenance?.segmentClosure && closure !== scene.provenance.segmentClosure)
    throw new Error("holo-collection: segment-closure κ mismatch (graph tampered)");
  return { scene, graph, modes: scene.modes };
}

export default { manufactureScene, createCollection, shareScene, openShared, graphBytes };
if (typeof window !== "undefined") window.HoloCollection = { manufactureScene, createCollection, shareScene, openShared };
