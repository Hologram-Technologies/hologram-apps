#!/usr/bin/env node
// holo-title-witness.mjs — proves the holo-title manifest: it seals to a deterministic content-κ, verifies on
// round-trip, reports which modes its tracks afford (graceful degradation), the SAME content from two paths
// collapses to one κ, and the rights boundary is ENFORCED (a metadata-only title cannot carry ingested bytes).
//
//   1 sealsAndVerifies   — a public-domain title seals → has a blake3 κ → verifyTitle() true.
//   2 deterministicKappa  — same content, different field order / provenance labels → identical κ.
//   3 tamperFails         — flip a track κ after sealing → verifyTitle() false (L5).
//   4 modesDegrade        — audio+text+syncmap ⇒ readalong; audio only ⇒ listen only; text only ⇒ read only.
//   5 rightsEnforced      — a metadata-only title carrying an audio κ THROWS (index, never ingest).
//   6 badKappaRejected    — a non-blake3 track value THROWS.
//
// node holo-title-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sealTitle, verifyTitle, modesOf, titleKappaOf, RIGHTS } from "./holo-title.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };
const K = (h) => "blake3:" + h.repeat(64).slice(0, 64);
const AUD = K("a"), TXT = K("b"), SYN = K("c"), COV = K("d");

// 1
const t = sealTitle({
  work: { title: "Frankenstein", authors: ["Mary Shelley"], lang: "en", cover: COV },
  audio: AUD, text: TXT, syncmap: SYN,
  provenance: { sources: ["LibriVox", "Project Gutenberg"], license: "Public Domain", derived: true },
  rights: { class: RIGHTS.PUBLIC_DOMAIN },
});
ok("sealsAndVerifies", /^blake3:[0-9a-f]{64}$/.test(t.kappa) && verifyTitle(t), t.kappa);

// 2 — same content, authors in different order + different provenance labels → same κ
{
  const a = titleKappaOf({ work: { title: "Frankenstein", authors: ["Mary Shelley"], lang: "en", cover: COV }, audio: AUD, text: TXT, syncmap: SYN, rights: { class: RIGHTS.PUBLIC_DOMAIN }, provenance: { derived: true } });
  const b = titleKappaOf({ provenance: { derived: true, sources: ["a different label entirely"] }, rights: { class: RIGHTS.PUBLIC_DOMAIN }, syncmap: SYN, text: TXT, audio: AUD, work: { lang: "en", cover: COV, authors: ["Mary Shelley"], title: "Frankenstein" } });
  ok("deterministicKappa", a === b && a === t.kappa, a + " vs " + b);
}

// 3 — tamper
{
  const tampered = { ...t, audio: K("f") };
  ok("tamperFails", verifyTitle(t) === true && verifyTitle(tampered) === false);
}

// 4 — modes degrade by track presence
{
  const all = modesOf({ audio: AUD, text: TXT, syncmap: SYN });
  const listenOnly = modesOf({ audio: AUD });
  const readOnly = modesOf({ text: TXT });
  const noSync = modesOf({ audio: AUD, text: TXT });
  ok("modesDegrade",
    all.readalong && all.listen && all.read &&
    listenOnly.listen && !listenOnly.read && !listenOnly.readalong &&
    readOnly.read && !readOnly.listen &&
    noSync.listen && noSync.read && !noSync.readalong,
    JSON.stringify({ all, listenOnly, readOnly, noSync }));
}

// 5 — rights boundary enforced
{
  let threw = false;
  try { sealTitle({ work: { title: "Project Hail Mary", authors: ["Andy Weir"], lang: "en" }, audio: AUD, rights: { class: RIGHTS.METADATA_ONLY } }); }
  catch (e) { threw = /metadata-only/.test(e.message); }
  // but a metadata-only title with NO bytes is fine (pure index card)
  let indexOk = false;
  try { const m = sealTitle({ work: { title: "Project Hail Mary", authors: ["Andy Weir"], lang: "en", cover: COV }, rights: { class: RIGHTS.METADATA_ONLY } }); indexOk = verifyTitle(m) && !m.audio && !m.text; }
  catch { indexOk = false; }
  ok("rightsEnforced", threw && indexOk);
}

// 6 — non-κ track value rejected
{
  let threw = false;
  try { sealTitle({ work: { title: "x", authors: [], lang: "en" }, audio: "http://example.com/a.mp3", rights: { class: RIGHTS.PUBLIC_DOMAIN } }); }
  catch (e) { threw = /must be a blake3/.test(e.message); }
  ok("badKappaRejected", threw);
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-title — a holo-title is a signed κ-manifest (a DAG of audio/text/images/syncmap tracks). Its identity is the blake3 over its sorted track κ-map + work identity + rights, so the same content collapses to one κ and tampering is detectable (L5). Tracks may be absent and the reader degrades gracefully. The rights boundary is enforced: a metadata-only title cannot carry ingested bytes — Holo Library indexes commercial catalogs, it never ingests them.",
  authority: "rests on #holo-blake3 (kappaBlake3) — P0 of the Holo Library build",
  witnessed,
  covers: witnessed ? ["seals-and-verifies", "deterministic-kappa", "tamper-fails", "modes-degrade", "rights-enforced", "bad-kappa-rejected"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-title-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-title witness — one owned object: content-addressed, verifiable, rights-enforced\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  a title is a κ you own; metadata-only is indexed, never ingested" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
