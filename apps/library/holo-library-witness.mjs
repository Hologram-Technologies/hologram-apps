#!/usr/bin/env node
// holo-library-witness.mjs — proves the flagship chain end to end with REAL content-addressing: discover → OWN
// (pin actual bytes to κ) → read-along → SHARE-running → open on a FRESH device with the ORIGIN OFFLINE, L5-
// verified, fail-closed on tamper, zero io. The transport + home are modelled; the κ math and verification are
// the real holo-content-net κ used across the OS.
//
//   1 realKappa       — the title's audio/text/syncmap κ are the genuine blake3 of the actual bytes.
//   2 ownedManifest   — adding the title changes the library head κ, which attests it and re-derives (L5).
//   3 shareInline     — small title → ONE self-contained #k= link carrying title + content-addressed blobs.
//   4 freshDeviceOpens— openShared() on a fresh reader re-derives the SAME title κ, verifies, and can read along.
//   5 tamperRejected  — flip one byte of a shared blob → openShared throws a κ mismatch (fail-closed).
//   6 offlineZeroIO   — openShared is synchronous and calls the injected io ZERO times (origin offline).
//
// node holo-library-witness.mjs   (from holo-apps/apps/library/)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kappaOf } from "../holo-import/holo-content-net.mjs";
import { manufactureTitle, createLibrary, shareTitle, openShared } from "./holo-library.mjs";
import { RIGHTS } from "./holo-title.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checks = {}; const fail = [];
const ok = (n, c, d = "") => { checks[n] = !!c; if (!c) fail.push(n + (d ? ` — ${d}` : "")); return !!c; };
const te = new TextEncoder();

// ── fixtures: a public-domain passage (text) + a stand-in narration (bytes) + its ASR hypothesis ────────────
const refText = "The quick brown fox jumps over the lazy dog. It pauses by the river and listens. Then it runs on into the bright morning.";
const textBytes = te.encode(refText);
const audioBytes = new Uint8Array(2048).map((_, i) => (i * 31 + 7) & 0xff);   // stand-in for the LibriVox mp3 bytes
const asrWords = refText.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).map((w, i) => ({ w, t0: i * 420, t1: i * 420 + 380 }));

const { title, blobs } = manufactureTitle({
  work: { title: "The Fox by the River", authors: ["Public Domain"], lang: "en" },
  audioBytes, textBytes, asrWords,
  rightsClass: RIGHTS.PUBLIC_DOMAIN,
  sources: [{ library: "LibriVox", mediaType: "audio" }, { library: "Project Gutenberg", mediaType: "text" }],
});

// 1 — the κ are real (independently recomputed from the bytes)
ok("realKappa",
  title.audio === kappaOf(audioBytes) && title.text === kappaOf(textBytes) &&
  blobs.has(title.audio) && blobs.has(title.text) && blobs.has(title.syncmap) && title.modes.readalong,
  JSON.stringify({ audio: title.audio.slice(0, 18), text: title.text.slice(0, 18) }));

// 2 — own it: head κ attests the title and re-derives
const lib = createLibrary("ilya");
{
  const before = lib.head;
  const head = lib.add(title);
  ok("ownedManifest", head !== before && lib.has(title.kappa) && lib.verifyHead(), JSON.stringify({ before: before.slice(0, 14), after: head.slice(0, 14) }));
}

// 3 — share: one self-contained inline link
const shared = shareTitle(title, blobs);
ok("shareInline", shared.mode === "inline" && typeof shared.link === "string" && shared.link.includes("#k=") && shared.link.length > 100, JSON.stringify({ mode: shared.mode, bytes: shared.total }));

// 4 — open on a fresh device (only the link), origin offline → same title κ, verified, readable
const io = { calls: 0, fetch() { this.calls++; return Promise.resolve(null); } };
{
  const opened = openShared(shared.link, { io });
  const hits = opened.reader.search("river");
  ok("freshDeviceOpens",
    opened.title.kappa === title.kappa && opened.modes.readalong &&
    opened.reader.spans.length === 3 && hits.length === 1 && typeof hits[0].startMs === "number",
    JSON.stringify({ sameKappa: opened.title.kappa === title.kappa, spans: opened.reader.spans.length }));
}

// 5 — tamper a shared blob → fail-closed
{
  const evil = JSON.parse(JSON.stringify(shared.payload));
  const ai = evil.blobs.findIndex(([k]) => k === title.audio);
  const bytes = Uint8Array.from(Buffer.from(evil.blobs[ai][1], "base64")); bytes[0] ^= 0xff;
  evil.blobs[ai][1] = Buffer.from(bytes).toString("base64");
  let threw = false; try { openShared(evil, { io }); } catch (e) { threw = /mismatch|tamper/.test(e.message); }
  ok("tamperRejected", threw);
}

// 6 — offline + zero io
{
  io.calls = 0;
  const r = openShared(shared.payload, { io });
  ok("offlineZeroIO", !(r instanceof Promise) && io.calls === 0 && r.title.kappa === title.kappa, JSON.stringify({ ioCalls: io.calls }));
}

const witnessed = Object.values(checks).every(Boolean);
const result = {
  "@type": "earl:TestResult",
  spec: "holo-library — the flagship chain: a work is OWNED by pinning its real audio + text bytes to κ (the same holo-content-net κ used across the OS), aligned into a read-along, and sealed into a holo-title carried by an append-only manifest whose head κ attests it. SHARE produces one self-contained link; opening it on a FRESH device with the ORIGIN OFFLINE re-derives every track κ from its bytes (L5 verify-before-trust), verifies the title, and builds a working reader — fail-closed on tamper, zero io. 'Found on the open web, owned by κ, reads along, shared as one link that opens running elsewhere.' Transport (IPFS) + home (holo-home) are modelled; the κ + verification are real.",
  authority: "rests on #holo-content-net (kappaOf) + #holo-title + #holo-align + #holo-read — P5 of the Holo Library build",
  witnessed,
  covers: witnessed ? ["real-kappa", "owned-manifest", "share-inline", "fresh-device-opens", "tamper-rejected", "offline-zero-io"] : [],
  checks, failed: fail,
};
writeFileSync(join(here, "holo-library-witness.result.json"), JSON.stringify(result, null, 2) + "\n");
console.log("holo-library witness — own by κ, share one link, open running on a fresh device, offline + verified\n");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "✓" : "✗"}  ${k}`);
console.log(`\n  ${witnessed ? "WITNESSED ✓  the magical moment, end to end, serverless and tamper-proof" : "NOT witnessed — " + fail.join("; ")}`);
process.exit(witnessed ? 0 : 1);
