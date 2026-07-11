// holo-media-card.mjs — the MediaCard contract (K0 of HOLO-TV-KAPPA-NATIVE-PROMPT.md).
//
// ONE shape for every kind of media the hub shows — film · show · live · game · music · audiobook.
// A card is a JCS-canonicalized (RFC 8785) JSON object, content-addressed on BOTH axes
// (sha256 for the existing store rungs, blake3 as the canonical κ). The media-index is itself
// a card-like κ-object whose rows are card-κs. Pure ESM, zero DOM, zero deps beyond WebCrypto —
// re-derives byte-identically in the browser and in Node ≥20 (Law L5), so the same witness
// runs anywhere. Verification REFUSES on any mismatch; there is no "trust the path" mode.
//
//   card = {
//     v: 1, kind: "film"|"show"|"live"|"game"|"music"|"audiobook",
//     title, year?, system?, duration?,
//     art:    { kappa: "sha256:<hex>", type: "image/png", bytes }   // κ of the art blob (bytes live in the κ-store)
//     stream: { kappa? , url? , holo? , channel? }                  // κ when bytes are in the store; url/channel = source ref (pre-K3)
//     meta?:  {...}                                                 // kind-specific extras (region, license, chapters…)
//   }

const _enc = new TextEncoder();

// RFC 8785 JCS (kept inline so this module is dependency-free). Unlike the apps/q/core/kappa.js copy,
// this one handles `undefined` per JSON semantics — omitted from objects, null in arrays — because a
// card minted with an optional field left undefined must still be VALID JSON (JSON.stringify(undefined)
// is the literal string `undefined`, which hashes fine but can never parse back → permanent refusal).
export const jcs = (v) => Array.isArray(v) ? "[" + v.map((x) => x === undefined ? "null" : jcs(x)).join(",") + "]"
  : (v && typeof v === "object") ? "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}"
  : JSON.stringify(v);

export async function sha256hex(u8) {
  const d = await crypto.subtle.digest("SHA-256", u8);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const KINDS = ["film", "show", "live", "game", "music", "audiobook"];

// mint: fields → { card, bytes, hex, kappa }. The card's identity IS its canonical bytes.
export async function mintCard(fields) {
  if (!fields || !KINDS.includes(fields.kind)) throw new Error("mintCard: bad kind " + (fields && fields.kind));
  if (!fields.title) throw new Error("mintCard: title required");
  const card = { v: 1, ...fields };
  const bytes = _enc.encode(jcs(card));
  const hex = await sha256hex(bytes);
  return { card, bytes, hex, kappa: "sha256:" + hex };
}

// verify: bytes + expected hex → parsed card, or null (REFUSED). Never returns unverified content.
export async function verifyCard(bytes, expectedHex) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if ((await sha256hex(bytes)) !== String(expectedHex || "").replace(/^sha256:/, "")) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

// mint the media-index: rows of { label, cards:[hex…] } → same κ discipline as a card.
export async function mintIndex(rows, meta = {}) {
  const index = { v: 1, kind: "media-index", ts: meta.ts || 0, rows };
  const bytes = _enc.encode(jcs(index));
  const hex = await sha256hex(bytes);
  return { index, bytes, hex, kappa: "sha256:" + hex };
}

export const verifyIndex = verifyCard;   // same contract: re-derive or refuse

// mint any κ-object (e.g. a torrent-manifest chunk table) with the same JCS + sha256 discipline.
export async function mintObject(obj) {
  const bytes = _enc.encode(jcs(obj));
  const hex = await sha256hex(bytes);
  return { obj, bytes, hex, kappa: "sha256:" + hex };
}
