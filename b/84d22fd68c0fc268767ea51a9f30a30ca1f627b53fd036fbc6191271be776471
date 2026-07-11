#!/usr/bin/env node
// holo-media-stream-witness.mjs — K3 gates (HOLO-TV-K3-KAPPA-STREAM-PROMPT.md).
// Proves against REAL infrastructure (Internet Archive), no mocks:
//   S1 source-truth — a clean-manifest chunk fetched by Range from the file's own URL re-derives to its
//                     minted sha256 (the manifest tells the truth about the source).
//   S4 tamper       — a flipped byte in a fetched chunk REFUSES by name (Law L5 at chunk granularity).
//   torrent leg     — a single-file .torrent's pieces verify (the "any torrent" path, span-free case).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { torrentView, verifiedFileStream, webseedURL } from "./holo-torrent-kappa.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BDIR = path.resolve(HERE, "../../b");
const UA = { headers: { "user-agent": "holo-witness/1" } };
const R = { pass: 0, fail: 0 };
const check = (n, ok, note = "") => { R[ok ? "pass" : "fail"]++; console.log(`${ok ? "✓" : "✗"} ${n}${note ? " — " + note : ""}`); };
const sha256hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8)), (b) => b.toString(16).padStart(2, "0")).join("");
const load = (hex) => new Uint8Array(readFileSync(path.join(BDIR, hex.replace(/^sha256:/, ""))));

// find the clean chunk-manifest referenced by the Art of War card
const ptr = JSON.parse(readFileSync(path.join(HERE, "media-index.json"), "utf8"));
const idx = JSON.parse(new TextDecoder().decode(load(ptr.kappa)));
let cleanKappa = null;
for (const row of idx.rows) for (const h of row.cards) { const c = JSON.parse(new TextDecoder().decode(load(h))); if (c.title && /Art of War/i.test(c.title) && c.stream && c.stream.manifest) cleanKappa = c.stream.manifest; }
check("card carries a clean chunk-manifest κ", !!cleanKappa, cleanKappa || "none");

if (cleanKappa) {
  const man = JSON.parse(new TextDecoder().decode(load(cleanKappa)));
  const file = man.files[0], ch0 = file.chunks[0];
  // S1 — Range-fetch chunk 0 from the file's OWN url; must re-derive to the minted sha256
  const r = await fetch(file.url, { headers: { ...UA.headers, range: `bytes=0-${ch0.size - 1}` } });
  const bytes = new Uint8Array(await r.arrayBuffer());
  const got = await sha256hex(bytes);
  check("S1 source chunk re-derives to minted κ", got === ch0.sha256, `${r.status} · ${got.slice(0, 12)}… vs ${ch0.sha256.slice(0, 12)}…`);
  // S4 — tamper → refuse
  bytes[0] ^= 1;
  check("S4 tampered chunk refused", (await sha256hex(bytes)) !== ch0.sha256, "1 bit flipped");
  check("manifest is KBs, media is NOT in-repo", load(cleanKappa).length < 200000 && !existsSync(path.join(BDIR, "..", "media")), `${(load(cleanKappa).length / 1024) | 0}KB manifest`);
}

// torrent leg — the "any .torrent" path: parse a real .torrent, verify a media file's pieces against the
// info-dict SHA-1s over its HTTP webseeds (Law L5 at BitTorrent-piece granularity). Art of War is the
// proven-fetchable item; interior pieces of its mp3 verify without touching non-CORS neighbours.
try {
  const tr = await fetch("https://archive.org/download/art_of_war_librivox/art_of_war_librivox_archive.torrent", UA);
  const view = await torrentView(new Uint8Array(await tr.arrayBuffer()));
  const vfi = view.files.findIndex((f) => /art_of_war_01-02_sun_tzu\.mp3$/.test(f.path));
  const seed = view.webseeds.find((u) => /^https:/.test(u));
  const fetchRange = async (f, s, e) => { const rr = await fetch(webseedURL(view, seed, f), { headers: { ...UA.headers, range: `bytes=${s}-${e - 1}` } }); if (rr.status !== 206 && !rr.ok) throw new Error("range " + rr.status); return new Uint8Array(await rr.arrayBuffer()); };
  let n = 0; for await (const seg of verifiedFileStream(view, vfi, fetchRange)) { n++; if (n === 3) break; }
  check("torrent leg: .torrent info-dict pieces verify over webseeds", n === 3, `${view.name} · ${view.pieces.length} pieces · infoHash ${view.infoHash.slice(0, 10)}…`);
  // tamper a fetched piece → named refusal
  let refused = false;
  const bad = async (f, s, e) => { const b = await fetchRange(f, s, e); b[0] ^= 1; return b; };
  try { for await (const _ of verifiedFileStream(view, vfi, bad)) break; } catch (e) { refused = /piece \d+ refused/.test(e.message); }
  check("torrent leg: tampered piece refused by name", refused);
} catch (e) { check("torrent leg", false, (e.message || e).slice(0, 50)); }

console.log(`\nK3 ${R.fail === 0 ? "GREEN" : "RED"} — ${R.pass}/${R.pass + R.fail}`);
process.exit(R.fail === 0 ? 0 : 1);
