// holo-scene-manifest.mjs — the ONE object Holo XXX owns. A "scene" is a signed κ-manifest: the work identity
// (title, performers, studio, date), a video κ-track (the MediaGraph segment-closure κ — see holo-media.mjs),
// optional preview/cover tracks, the tag set, a rights class, and provenance. It is NOT a proprietary container:
// the video is just another κ-track, and the scene's identity is the blake3 over its sorted essence — the same
// self-verifying-manifest pattern as holo-title (books) and holospaceKappa (holo-import).
//
//   scene := {
//     work:       { title, performers[], studio, date, cover, sourceAttribution[] },
//     video:      κ | null,        // MediaGraph segment-closure κ (verified streamable DAG via holo-media)
//     preview:    κ | null,        // short hover/teaser clip closure κ (optional)
//     tags:       [string],        // categories — the facet axis the catalogue navigates by
//     provenance: { sources[], license, derived },
//     rights:     { class }        // user-owned-source | public-domain | metadata-only
//   }
//
// Rules: metadata-only scenes (a scraped catalogue entry you don't own) MUST NOT carry a video/preview κ — that
// boundary is the difference between an index and a redistributor, so it's enforced in code (assertRightsCoherent),
// not left to prose. Pure ESM, no network — Node witnesses it byte-for-byte.

import { blake3hex } from "../../../holo-os/system/os/usr/lib/holo/holo-blake3.mjs";

export const RIGHTS = Object.freeze({
  PUBLIC_DOMAIN: "public-domain",      // Tier A — open/CC sources, full playback
  USER_OWNED: "user-owned-source",     // Tier B — the user's own files/acquisition, full playback
  METADATA_ONLY: "metadata-only",      // Tier C — scraped catalogue, index + link-out ONLY (never bytes)
});
const RIGHTS_SET = new Set(Object.values(RIGHTS));

const enc = new TextEncoder();
const isKappa = (v) => typeof v === "string" && /^blake3:[0-9a-f]{64}$/.test(v);

// deterministic, key-sorted serialization so the κ is stable across machines and field order.
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
}

// The scene's identity = blake3 over its CONTENT essence: work identity + the sorted track κ-map + tags + rights
// class + derived flag. Mutable display/provenance labels are excluded so the same content discovered two ways
// (StashDB scrape vs a friend's share) collapses to the same κ.
export function sceneKappaOf(m) {
  const essence = {
    work: {
      title: m.work?.title || "",
      performers: [...(m.work?.performers || [])].map((p) => String(p).toLowerCase()).sort(),
      studio: (m.work?.studio || "").toLowerCase(),
      date: m.work?.date || "",
    },
    tracks: { video: m.video || null, preview: m.preview || null, cover: m.work?.cover || null },
    tags: [...(m.tags || [])].map((t) => String(t).toLowerCase()).sort(),
    rights: m.rights?.class || null,
    derived: !!m.provenance?.derived,
  };
  return "blake3:" + blake3hex(enc.encode(canonical(essence)));
}

// metadata-only scenes index a work but never hold its bytes. Enforce that invariant in code.
export function assertRightsCoherent(m) {
  const cls = m.rights?.class;
  if (!RIGHTS_SET.has(cls)) throw new Error("holo-scene: unknown rights class " + JSON.stringify(cls));
  if (cls === RIGHTS.METADATA_ONLY) {
    for (const t of ["video", "preview"]) {
      if (m[t]) throw new Error(`holo-scene: metadata-only scene must not carry a ${t} κ (index, never redistribute)`);
    }
  }
  for (const t of ["video", "preview"]) {
    if (m[t] != null && !isKappa(m[t])) throw new Error(`holo-scene: ${t} must be a blake3 κ or null, got ${JSON.stringify(m[t])}`);
  }
  return true;
}

// Which experiences a scene can offer, from which tracks are present. The catalogue reads this — never assumes.
export function modesOf(m) {
  return { stream: !!m.video, preview: !!m.preview, indexOnly: !m.video && !m.preview };
}

// Seal a manifest → a frozen, content-addressed scene. Validates rights coherence first.
export function sealScene(manifest) {
  const m = {
    work: { title: "", performers: [], studio: "", date: "", cover: null, sourceAttribution: [], ...(manifest.work || {}) },
    video: manifest.video || null,
    preview: manifest.preview || null,
    tags: manifest.tags || [],
    provenance: { sources: [], license: "", derived: false, ...(manifest.provenance || {}) },
    rights: { class: manifest.rights?.class || RIGHTS.USER_OWNED },
  };
  assertRightsCoherent(m);
  const kappa = sceneKappaOf(m);
  return Object.freeze({ ...m, kappa, modes: modesOf(m) });
}

// Re-derive the κ and compare — the L5 "verify before you trust" check, for round-trips and shared links.
export function verifyScene(sealed) {
  if (!sealed || !sealed.kappa) return false;
  return sceneKappaOf(sealed) === sealed.kappa;
}

export default { RIGHTS, sceneKappaOf, assertRightsCoherent, modesOf, sealScene, verifyScene };
if (typeof window !== "undefined") window.HoloScene = { RIGHTS, sceneKappaOf, sealScene, verifyScene, modesOf };
