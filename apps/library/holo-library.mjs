// holo-library.mjs — the flagship orchestrator: discover → OWN → read-along → SHARE-running. It ties the
// witnessed kernels together with REAL content-addressing (reuses holo-content-net.kappaOf, the same κ the
// rest of the OS uses) so the chain is honest end to end:
//   • manufactureTitle — pin the actual audio + text BYTES to κ, align them (P2), seal a holo-title (P0). The
//     bytes form a content-addressed blob set (what you'd hand to holo-stream).
//   • createLibrary    — ownership: an append-only manifest whose head κ attests every title you own (models
//     holo-home / holo-strand — the title you carry, no server).
//   • shareTitle       — one self-contained link (#k= inline when small, #car= when large), modelling holo-share.
//   • openShared       — open on a FRESH device with the ORIGIN OFFLINE: re-derive every track κ from its bytes
//     (L5 verify-before-trust), verify the title κ, then build a working reader. Fail-closed on any mismatch,
//     and performs ZERO io. THIS is "shared as one link that opened running on my friend's phone."
//
// Pure ESM (kappaOf is pure blake3) → Node witnesses the whole chain. Real runtime swaps the modelled transport
// for IPFS pinning and the modelled manifest for holo-home; the κ math + L5 checks are already the real thing.

import { kappaOf } from "./holo-kappa.mjs";
import { alignChapter } from "./holo-align.mjs";
import { sealTitle, verifyTitle, RIGHTS } from "./holo-title.mjs";
import { createReader, flattenSyncmaps } from "./holo-read.mjs";

const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
const unb64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

// OWN IT — pin real bytes to κ, align, seal. Returns the sealed title, the syncmap, and the blob set (κ→bytes).
export function manufactureTitle({ work, audioBytes, textBytes, asrWords = [], coverBytes = null, rightsClass = RIGHTS.PUBLIC_DOMAIN, sources = [], chapterId = "c1" }) {
  const blobs = new Map();
  const audio = kappaOf(audioBytes); blobs.set(audio, audioBytes);
  const text = kappaOf(textBytes); blobs.set(text, textBytes);
  const cover = coverBytes ? kappaOf(coverBytes) : null; if (cover) blobs.set(cover, coverBytes);
  const syncmap = alignChapter({ refText: td.decode(textBytes), asrWords, chapterId });
  const smBytes = te.encode(JSON.stringify(syncmap));
  const syncmapKappa = kappaOf(smBytes); blobs.set(syncmapKappa, smBytes);
  const title = sealTitle({
    work: { ...work, cover },
    audio, text, syncmap: syncmapKappa,
    provenance: { sources, license: rightsClass === RIGHTS.PUBLIC_DOMAIN ? "Public Domain" : "Owned", derived: true },
    rights: { class: rightsClass },
  });
  return { title, syncmap, blobs };
}

// OWNERSHIP — an append-only library manifest; head κ attests the exact set of titles you own (carry, no server).
export function createLibrary(owner = "me") {
  const entries = [];
  const headOf = () => kappaOf(te.encode(owner + "|" + entries.map((e) => e.kappa).join(",")));
  let head = headOf();
  return {
    owner,
    add(title) { entries.push({ kappa: title.kappa, title: title.work.title }); head = headOf(); return head; },
    has(kappa) { return entries.some((e) => e.kappa === kappa); },
    list() { return entries.slice(); },
    get head() { return head; },
    verifyHead() { return head === headOf(); },        // L5 over the manifest itself
  };
}

// SHARE-RUNNING — one self-contained link. Inline when the bytes fit (truly serverless); else publish a CAR and
// carry a short cid that re-derives elsewhere (modelled). The payload carries the title + its content-addressed
// blobs, so the receiver needs nothing from the origin.
export function shareTitle(title, blobs, { maxInline = 512 * 1024 } = {}) {
  const total = [...blobs.values()].reduce((n, b) => n + b.length, 0);
  const payload = { v: 1, title, blobs: [...blobs.entries()].map(([k, b]) => [k, b64(b)]) };
  if (total <= maxInline) return { mode: "inline", total, link: "holo://read#k=" + b64(te.encode(JSON.stringify(payload))), payload };
  return { mode: "car", total, link: "holo://read#car=" + kappaOf(te.encode(JSON.stringify(payload))).slice(7, 23), payload };
}

function parseLink(link) {
  const i = link.indexOf("#k=");
  if (i < 0) throw new Error("holo-library: openShared needs an inline #k= link (a #car= link must be fetched first)");
  return JSON.parse(td.decode(unb64(link.slice(i + 3))));
}

// OPEN ON A FRESH DEVICE — origin offline. Verify every byte against its κ (L5), verify the title, build a reader.
// Fail-closed on tamper/missing. Uses only the payload; touches no io (proven with the spy in the witness).
export function openShared(linkOrPayload, { io = null } = {}) {
  const payload = typeof linkOrPayload === "string" ? parseLink(linkOrPayload) : linkOrPayload;
  const title = payload.title;
  const blobs = new Map(payload.blobs.map(([k, b]) => [k, unb64(b)]));
  for (const k of [title.audio, title.text, title.syncmap, title.work && title.work.cover].filter(Boolean)) {
    const bytes = blobs.get(k);
    if (!bytes) throw new Error("holo-library: missing blob for " + k);
    if (kappaOf(bytes) !== k) throw new Error("holo-library: κ mismatch (tamper) for " + k);   // L5 tripwire
  }
  if (!verifyTitle(title)) throw new Error("holo-library: title κ failed to verify");
  const sm = JSON.parse(td.decode(blobs.get(title.syncmap)));
  const reader = createReader(flattenSyncmaps([{ chapterId: sm.spans?.[0]?.spanId?.split("#")[0] || "c1", spans: sm.spans }]));
  return { title, reader, modes: title.modes, blobs };
}

export default { manufactureTitle, createLibrary, shareTitle, openShared };
if (typeof window !== "undefined") window.HoloLibrary = { manufactureTitle, createLibrary, shareTitle, openShared };
