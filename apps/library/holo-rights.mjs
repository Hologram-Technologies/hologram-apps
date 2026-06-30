// holo-rights.mjs — the ingest policy gate. This is the line between an index and a pirate, expressed in code.
// Every edition carries a tier (open | owned | commercial). The gate decides, per work, which tracks may be
// PINNED (turned into bytes/κ) and which may only be INDEXED + linked-out — and what rights class the resulting
// holo-title carries. The hard invariants:
//   • commercial (Tier C) tracks are NEVER ingested — only a metadata card with a link-out.
//   • a title's rights class is the MOST RESTRICTIVE of its ingested tracks (owned beats public-domain).
//   • assertIngestAllowed() throws before any byte-pin of a commercial edition — a runtime tripwire, not a hope.
// Pure ESM → Node witnesses the policy exactly.

import { TIER } from "./holo-book.mjs";
import { sealTitle, RIGHTS } from "./holo-title.mjs";

export const tierToRights = (tier) => ({
  [TIER.OPEN]: RIGHTS.PUBLIC_DOMAIN,
  [TIER.OWNED]: RIGHTS.USER_OWNED,
  [TIER.COMMERCIAL]: RIGHTS.METADATA_ONLY,
}[tier] || RIGHTS.METADATA_ONLY);

// is this edition allowed to become bytes? Only open + owned. Commercial = index, never ingest.
export function ingestPolicy(edition) {
  const tier = edition?._tier || TIER.OPEN;
  if (tier === TIER.COMMERCIAL) return { ingestable: false, reason: "commercial catalog — index + link-out only, never ingest" };
  return { ingestable: true, reason: tier === TIER.OWNED ? "user owns this source" : "public domain" };
}

// the runtime tripwire: call this immediately before pinning an edition's bytes (audio→holo-stream, text→DAG).
export function assertIngestAllowed(edition) {
  const p = ingestPolicy(edition);
  if (!p.ingestable) throw new Error(`holo-rights: refusing to ingest "${edition?.title || edition?.id}" — ${p.reason}`);
  return true;
}

// pick the best edition by tier preference, then trust.
function pickByTier(editions, pref) {
  const ing = (editions || []).filter((e) => ingestPolicy(e).ingestable);
  return ing.slice().sort((a, b) => (pref.indexOf(a._tier) - pref.indexOf(b._tier)) || ((b._trust || 0) - (a._trust || 0)))[0] || null;
}

// planWork — decide, for a merged work, what becomes the title: which audio + text we may pin, whether a read-
// along is manufacturable, the rights class, and which commercial sources are surfaced as link-outs only.
export function planWork(work) {
  const audio = pickByTier(work.audio || [], [TIER.OWNED, TIER.OPEN]);   // prefer the copy you own
  const text = pickByTier(work.text || [], [TIER.OPEN, TIER.OWNED]);     // text is almost always open
  const all = [...(work.audio || []), ...(work.text || []), ...(work.meta || [])];
  const linkOuts = all.filter((e) => e._tier === TIER.COMMERCIAL && (e.linkOut || e._url))
    .map((e) => ({ library: e._providerName, mediaType: e.mediaType, url: e.linkOut || e._url, title: e.title }));

  const ingestedTiers = [audio, text].filter(Boolean).map((e) => e._tier);
  let rightsClass;
  if (!ingestedTiers.length) rightsClass = RIGHTS.METADATA_ONLY;          // nothing ingestable → index card
  else if (ingestedTiers.includes(TIER.OWNED)) rightsClass = RIGHTS.USER_OWNED;
  else rightsClass = RIGHTS.PUBLIC_DOMAIN;

  const canReadAlong = !!(audio && text);
  const log = [];
  if (audio) log.push(`ingest audio ← ${audio._providerName} (${audio._tier})`);
  if (text) log.push(`ingest text ← ${text._providerName} (${text._tier})`);
  for (const l of linkOuts) log.push(`link-out only ← ${l.library} (commercial)`);
  if (!ingestedTiers.length) log.push(`index card only — no ingestable track`);

  return { rightsClass, audio, text, canReadAlong, linkOuts, log };
}

// assembleFromPlan — turn a plan + (already-pinned) κ values into a sealed holo-title. For a metadata-only work
// it builds an index CARD: no track κ, link-outs recorded in provenance. The holo-title seal is the backstop —
// it throws if a metadata-only title is ever handed a track κ.
export function assembleFromPlan(work, plan, { audioKappa = null, textKappa = null, syncmapKappa = null, coverKappa = null } = {}) {
  if (plan.rightsClass === RIGHTS.METADATA_ONLY) {
    return sealTitle({
      work: { title: work.title, authors: work.authors || [], lang: work.lang, year: work.year || null, cover: coverKappa || null,
        sourceAttribution: plan.linkOuts.map((l) => `${l.library} (link-out)`) },
      provenance: { sources: plan.linkOuts.map((l) => ({ library: l.library, mediaType: "link", url: l.url })), license: "", derived: false },
      rights: { class: RIGHTS.METADATA_ONLY },
    });
  }
  const sources = [];
  if (plan.audio) sources.push({ library: plan.audio._providerName, mediaType: "audio", ref: plan.audio.id, tier: plan.audio._tier });
  if (plan.text) sources.push({ library: plan.text._providerName, mediaType: "text", ref: plan.text.id, tier: plan.text._tier });
  for (const l of plan.linkOuts) sources.push({ library: l.library, mediaType: "link", url: l.url });
  return sealTitle({
    work: { title: work.title, authors: work.authors || [], lang: work.lang, year: work.year || null, cover: coverKappa || null,
      sourceAttribution: sources.filter((s) => s.mediaType !== "link").map((s) => `${s.library} (${s.mediaType})`) },
    audio: plan.audio ? audioKappa : null,
    text: plan.text ? textKappa : null,
    syncmap: plan.canReadAlong ? syncmapKappa : null,
    provenance: { sources, license: plan.rightsClass === RIGHTS.PUBLIC_DOMAIN ? "Public Domain" : "Owned", derived: !!(plan.canReadAlong && syncmapKappa) },
    rights: { class: plan.rightsClass },
  });
}

export default { tierToRights, ingestPolicy, assertIngestAllowed, planWork, assembleFromPlan };
if (typeof window !== "undefined") window.HoloRights = { tierToRights, ingestPolicy, assertIngestAllowed, planWork, assembleFromPlan };
