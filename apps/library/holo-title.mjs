// holo-title.mjs — the ONE object Holo Library owns. A "holo-title" is a signed κ-manifest: a DAG of
// synchronized tracks (audio, text, images, syncmap) plus the work identity, rights class, and provenance.
// It is NOT a proprietary container — sync is just another κ-track, and the title's identity is the blake3
// over its sorted (track → κ) map (the same self-verifying-manifest pattern as holospaceKappa in holo-import).
//
//   holo-title := {
//     work:       { title, authors[], lang, series?, cover, sourceAttribution[] },
//     audio:      κ | null,          // verified streamable DAG (fMP4/segmented via holo-stream)
//     text:       κ | null,          // normalized text DAG (chapters → spans, addressable by spanId)
//     images:     [κ],               // illustrations/plates (optional)
//     syncmap:    κ | null,          // word/sentence ↔ audioMs alignment (a κ-track, not a format)
//     provenance: { sources[], license, derived },
//     rights:     { class }          // public-domain | user-owned-source | metadata-only
//   }
//
// Rules: any track may be absent — the reader degrades gracefully (modesOf). metadata-only titles MUST NOT
// carry ingested bytes (audio/text/syncmap κ) — that boundary is the difference between an index and a pirate,
// so it is enforced in code (assertRightsCoherent), not left to prose. Pure ESM, no network — Node witnesses it.

import { blake3hex } from "./holo-kappa.mjs";

export const RIGHTS = Object.freeze({
  PUBLIC_DOMAIN: "public-domain",      // Tier A — open libraries, full auto-manufacture
  USER_OWNED: "user-owned-source",     // Tier B — user's own server/files, full playback
  METADATA_ONLY: "metadata-only",      // Tier C — commercial catalogs, index + link-out ONLY
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

// The title's identity = blake3 over its CONTENT essence: work identity + the sorted track κ-map + rights
// class + derived flag. Mutable display/provenance labels are deliberately excluded so the same content
// from two discovery paths collapses to the same κ.
export function titleKappaOf(m) {
  const essence = {
    work: { title: m.work?.title || "", authors: [...(m.work?.authors || [])].sort(), lang: m.work?.lang || "" },
    tracks: {
      audio: m.audio || null,
      text: m.text || null,
      syncmap: m.syncmap || null,
      images: [...(m.images || [])].sort(),
      cover: m.work?.cover || null,
    },
    rights: m.rights?.class || null,
    derived: !!m.provenance?.derived,
  };
  return "blake3:" + blake3hex(enc.encode(canonical(essence)));
}

// metadata-only titles index a work but never hold its bytes. Enforce that invariant.
export function assertRightsCoherent(m) {
  const cls = m.rights?.class;
  if (!RIGHTS_SET.has(cls)) throw new Error("holo-title: unknown rights class " + JSON.stringify(cls));
  if (cls === RIGHTS.METADATA_ONLY) {
    for (const t of ["audio", "text", "syncmap"]) {
      if (m[t]) throw new Error(`holo-title: metadata-only title must not carry an ingested ${t} κ (index, never ingest)`);
    }
  }
  for (const t of ["audio", "text", "syncmap"]) {
    if (m[t] != null && !isKappa(m[t])) throw new Error(`holo-title: ${t} must be a blake3 κ or null, got ${JSON.stringify(m[t])}`);
  }
  return true;
}

// Which experiences a title can offer, from which tracks are present. The reader reads this — never assumes.
export function modesOf(m) {
  const listen = !!m.audio;
  const read = !!m.text;
  const readalong = listen && read && !!m.syncmap;
  return { listen, read, readalong };
}

// Seal a manifest → a frozen, content-addressed title. Validates rights coherence first.
export function sealTitle(manifest) {
  const m = {
    work: { title: "", authors: [], lang: "", series: null, cover: null, sourceAttribution: [], ...(manifest.work || {}) },
    audio: manifest.audio || null,
    text: manifest.text || null,
    images: manifest.images || [],
    syncmap: manifest.syncmap || null,
    provenance: { sources: [], license: "", derived: false, ...(manifest.provenance || {}) },
    rights: { class: manifest.rights?.class || RIGHTS.PUBLIC_DOMAIN },
  };
  assertRightsCoherent(m);
  const kappa = titleKappaOf(m);
  return Object.freeze({ ...m, kappa, modes: modesOf(m) });
}

// Re-derive the κ and compare — the L5 "verify before you trust" check, for round-trips and shared links.
export function verifyTitle(sealed) {
  if (!sealed || !sealed.kappa) return false;
  return titleKappaOf(sealed) === sealed.kappa;
}

export default { RIGHTS, titleKappaOf, assertRightsCoherent, modesOf, sealTitle, verifyTitle };
if (typeof window !== "undefined") window.HoloTitle = { RIGHTS, titleKappaOf, sealTitle, verifyTitle, modesOf };
