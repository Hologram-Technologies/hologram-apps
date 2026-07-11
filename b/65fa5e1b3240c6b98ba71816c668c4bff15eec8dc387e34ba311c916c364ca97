#!/usr/bin/env node
// holo-media-indexer.mjs — mint the κ-addressed media-index (K0 of HOLO-TV-KAPPA-NATIVE-PROMPT.md).
//
// Build-time tool (Node ≥20). Mints MediaCards from sources that are ALREADY playable today:
//   games      — apps/holo-games/holos/catalog.json (.holo packages; posters are baked data-URLs)
//   films      — Internet Archive public-domain feature films with a direct-stream mp4 derivative
//   live       — the player's curated featured channels (iptv-org ids + fetched logos)
//   audiobooks — LibriVox (Internet Archive librivoxaudio collection, mp3 chapters)
// Every art blob, every card, and the index itself is stored content-addressed at b/<sha256hex>
// (the origin-b store rung the resolver + SW already serve). A pointer file media-index.json
// carries ONLY the index κ — path is convenience, the hash is the truth. Fail-open per item:
// a dead source shrinks a row, never breaks the mint. Rights: only public-domain / free /
// operator-curated-legal entries are indexed — a hash is not a license.
//
//   node holo-media-indexer.mjs [--out <repoRoot>]   (default: ../../.. from this file = HOLOGRAM/holo-apps)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintCard, mintIndex, mintObject, sha256hex } from "./holo-media-card.mjs";
import { torrentView } from "./holo-torrent-kappa.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPS = path.resolve(HERE, "..");                     // holo-apps/apps
const ROOT = path.resolve(APPS, "..");                     // holo-apps  (has the b/ store)
const BDIR = path.join(ROOT, "b");
mkdirSync(BDIR, { recursive: true });

const put = async (bytes) => { const hex = await sha256hex(bytes); const p = path.join(BDIR, hex); if (!existsSync(p)) writeFileSync(p, bytes); return hex; };
const UA = { headers: { "user-agent": "holo-media-indexer/1 (+hologram)" } };
async function fetchBytes(url, timeoutMs = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { ...UA, signal: ctl.signal }); if (!r.ok) return null; const type = r.headers.get("content-type") || ""; return { bytes: new Uint8Array(await r.arrayBuffer()), type }; }
  catch { return null; } finally { clearTimeout(t); }
}
const dataUrlBytes = (u) => { const m = /^data:([^;,]+);base64,(.*)$/.exec(u || ""); return m ? { type: m[1], bytes: Uint8Array.from(Buffer.from(m[2], "base64")) } : null; };

const cards = [];   // { hex, card }
async function emit(fields) { const m = await mintCard(fields); writeFileSync(path.join(BDIR, m.hex), m.bytes); cards.push(m); return m.hex; }

// ── torrent-manifest per IA item — the .torrent IS the chunk table (K3): piece SHA-1s + webseeds,
// minted from a ~30KB download instead of the media's gigabytes. Fail-open: no torrent → url-only card.
const _tmCache = new Map();
async function mintTorrentManifest(iaId) {
  if (_tmCache.has(iaId)) return _tmCache.get(iaId);
  let kappa = null;
  try {
    const r = await fetch(`https://archive.org/download/${iaId}/${iaId}_archive.torrent`, UA);
    if (r.ok) {
      const view = await torrentView(new Uint8Array(await r.arrayBuffer()));
      const m = await mintObject({ v: 1, kind: "torrent-manifest", ia: iaId, name: view.name, infoHash: view.infoHash,
        pieceLength: view.pieceLength, totalLength: view.totalLength, multi: view.multi,
        webseeds: view.webseeds.filter((u) => /^https:/.test(u)), files: view.files, pieces: view.pieces });
      writeFileSync(path.join(BDIR, m.hex), m.bytes);
      kappa = m.kappa;
      console.log(`torrent ✓ ${iaId} (${view.pieces.length} pieces · ${view.files.length} files)`);
    }
  } catch (e) { console.error("torrent ✗ " + iaId + ": " + e.message); }
  _tmCache.set(iaId, kappa);
  return kappa;
}

// ── games — the .holo library (fully κ-native already: ROM κ + baked art) ─────────────────────────
async function mintGames() {
  const out = [];
  try {
    const cat = JSON.parse(readFileSync(path.join(APPS, "holo-games/holos/catalog.json"), "utf8"));
    for (const g of cat.games || []) {
      if (!g.title || !g.holo) continue;
      let art = null;
      const p = dataUrlBytes(g.poster);
      if (p) art = { kappa: "sha256:" + await put(p.bytes), type: p.type };
      out.push(await emit({ kind: "game", title: g.title, system: g.system || "", art,
        stream: { kappa: g.kappa ? "sha256:" + g.kappa : undefined, holo: "/apps/holo-games/holos/" + path.basename(g.holo) },
        meta: { license: g.license || "", provenance: g.provenance || "" } }));
    }
  } catch (e) { console.error("games: " + e.message); }
  return out;
}

// ── films — IA public-domain features with a direct mp4 (verified via the metadata API) ───────────
const FILM_IDS = ["night_of_the_living_dead", "his_girl_friday", "TheGeneral_798", "nosferatu_the_vampyre",
  "Charade19631280x696", "plan_9_from_outer_space_ipod", "detour_1945", "the_39_steps_1935",
  "CC_1916_09_04_ThePawnshop", "Popeye_forPresident"];
async function mintFilms() {
  const out = [];
  for (const id of FILM_IDS) {
    try {
      const meta = await (await fetch(`https://archive.org/metadata/${id}`, UA)).json();
      if (!meta || !meta.files) continue;
      const mp4 = meta.files.find((f) => /\.mp4$/i.test(f.name) && (+f.size || 0) > 5e6) || meta.files.find((f) => /\.mp4$/i.test(f.name));
      if (!mp4) continue;
      const art0 = await fetchBytes(`https://archive.org/services/img/${id}`);
      const art = art0 ? { kappa: "sha256:" + await put(art0.bytes), type: art0.type || "image/jpeg" } : null;
      const md = meta.metadata || {};
      const tm = await mintTorrentManifest(id);
      out.push(await emit({ kind: "film", title: String(md.title || id).slice(0, 120), year: +String(md.year || md.date || "").slice(0, 4) || undefined,
        art, stream: { url: `https://archive.org/download/${id}/${encodeURIComponent(mp4.name)}`, ...(tm ? { torrent: tm } : {}) },
        meta: { source: "internet-archive", ia: id, license: String(md.licenseurl || "public-domain").slice(0, 120) } }));
      console.log("film ✓ " + id);
    } catch (e) { console.error("film ✗ " + id + ": " + e.message); }
  }
  return out;
}

// ── live — the player's curated featured channels (iptv-org ids; logos fetched → κ) ───────────────
const FEATURED = [
  ["BBCNews.uk", "BBC News"], ["SkyNews.ie", "Sky News"], ["AlJazeera.qa", "Al Jazeera English"],
  ["France24.fr", "France 24 English"], ["EuronewsEnglish.fr", "Euronews"], ["DW.de", "DW News"],
  ["ABCNewsLive.us", "ABC News Live"], ["BloombergTV.us", "Bloomberg TV"], ["TRTWorld.tr", "TRT World"],
  ["NHKWorldJapan.jp", "NHK World Japan"], ["NasaTV.mk", "NASA TV"], ["AfricanewsEnglish.fr", "Africanews"]];
async function mintLive() {
  const out = [];
  let logos = new Map();
  try {
    // iptv-org moved logos out of channels.json → logos.json (many per channel; first in-use wins)
    const ls = await (await fetch("https://iptv-org.github.io/api/logos.json", UA)).json();
    for (const l of ls) if (l && l.channel && l.url && l.in_use !== false && !logos.has(l.channel)) logos.set(l.channel, l.url);
  } catch (e) { console.error("live logos.json: " + e.message); }
  for (const [id, name] of FEATURED) {
    try {
      let art = null;
      const lu = logos.get(id);
      if (lu) { const a = await fetchBytes(lu, 12000); if (a && a.bytes.length > 200) art = { kappa: "sha256:" + await put(a.bytes), type: a.type || "image/png" }; }
      out.push(await emit({ kind: "live", title: name, art, stream: { channel: "iptv:" + id }, meta: { source: "iptv-org" } }));
      console.log("live ✓ " + id + (art ? "" : " (no logo)"));
    } catch (e) { console.error("live ✗ " + id + ": " + e.message); }
  }
  return out;
}

// ── clean per-file chunk table (K3 robust path) — hash a single media file in 4MB windows, NO cross-file
// spans (unlike a multi-file torrent whose pieces bleed into non-CORS neighbours). Streamed so a 550MB
// book never sits in RAM; each chunk sha256 = the browser verifies with crypto.subtle (no wasm needed).
const CHUNK = 4 << 20;
async function chunkTable(url) {
  const r = await fetch(url, UA); if (!r.ok || !r.body) return null;
  const reader = r.body.getReader();
  const chunks = []; let buf = new Uint8Array(0), total = 0;
  const flush = async (bytes) => { const d = await crypto.subtle.digest("SHA-256", bytes); chunks.push({ sha256: Buffer.from(d).toString("hex"), size: bytes.length }); total += bytes.length; };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) { const m = new Uint8Array(buf.length + value.length); m.set(buf); m.set(value, buf.length); buf = m; while (buf.length >= CHUNK) { await flush(buf.subarray(0, CHUNK)); buf = buf.slice(CHUNK); } }
    if (done) break;
  }
  if (buf.length) await flush(buf);
  return { chunkSize: CHUNK, size: total, chunks };
}
async function mintCleanBookManifest(iaId, chapters) {
  const files = [];
  for (const ch of chapters) {
    const t = await chunkTable(ch.url).catch(() => null);
    if (!t) { console.error("  chunk ✗ " + ch.url.split("/").pop()); return null; }   // all-or-nothing per book → honest chip
    files.push({ url: ch.url, name: ch.name, size: t.size, chunkSize: t.chunkSize, chunks: t.chunks });
    process.stdout.write(".");
  }
  const m = await mintObject({ v: 1, kind: "chunk-manifest", ia: iaId, files });
  writeFileSync(path.join(BDIR, m.hex), m.bytes);
  console.log(` clean-manifest ✓ ${iaId} (${files.length} files)`);
  return m.kappa;
}

// ── audiobooks — LibriVox via the IA librivoxaudio collection (public domain, mp3 chapters) ───────
const BOOK_IDS = ["pride_and_prejudice_librivox", "adventures_sherlock_holmes_rg_librivox", "art_of_war_librivox",
  "meditations_marcus_aurelius_mfs_librivox", "alices_adventures_1003_librivox", "count_monte_cristo_0711_librivox"];
async function mintBooks() {
  const out = [];
  for (const id of BOOK_IDS) {
    try {
      const meta = await (await fetch(`https://archive.org/metadata/${id}`, UA)).json();
      if (!meta || !meta.files) continue;
      const mp3s = meta.files.filter((f) => /\.mp3$/i.test(f.name) && !/_64kb|_32kb/i.test(f.name)).slice(0, 200);
      const chapters = (mp3s.length ? mp3s : meta.files.filter((f) => /\.mp3$/i.test(f.name))).map((f) => ({ name: f.name.replace(/\.mp3$/i, "").replace(/[_-]+/g, " ").trim(), url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}` }));
      if (!chapters.length) continue;
      const art0 = await fetchBytes(`https://archive.org/services/img/${id}`);
      const art = art0 ? { kappa: "sha256:" + await put(art0.bytes), type: art0.type || "image/jpeg" } : null;
      const md = meta.metadata || {};
      // Short books get a clean per-file chunk-manifest (fully κ-verified playback); large ones stay direct
      // for now (chip absent — honest) to keep the mint bounded. Torrent manifest kept as a source hint.
      const tm = await mintTorrentManifest(id);
      const clean = chapters.length <= 12 ? await mintCleanBookManifest(id, chapters).catch(() => null) : null;
      out.push(await emit({ kind: "audiobook", title: String(md.title || id).replace(/\s*\(?librivox\)?/i, "").slice(0, 120),
        art, stream: { url: chapters[0].url, ...(clean ? { manifest: clean } : {}), ...(tm ? { torrent: tm } : {}) }, meta: { source: "librivox", ia: id, chapters: chapters.slice(0, 100), license: "public-domain" } }));
      console.log("book ✓ " + id + " (" + chapters.length + " ch)");
    } catch (e) { console.error("book ✗ " + id + ": " + e.message); }
  }
  return out;
}

// ── mint everything → rows → index → pointer ──────────────────────────────────────────────────────
const [games, films, live, books] = [await mintGames(), await mintFilms(), await mintLive(), await mintBooks()];
const rows = [];
if (films.length) rows.push({ label: "Films", kind: "film", cards: films });
if (games.length) rows.push({ label: "Games", kind: "game", cards: games });
if (live.length) rows.push({ label: "Live TV", kind: "live", cards: live });
if (books.length) rows.push({ label: "Audiobooks", kind: "audiobook", cards: books });
const idx = await mintIndex(rows, { ts: Date.now() });
writeFileSync(path.join(BDIR, idx.hex), idx.bytes);
writeFileSync(path.join(HERE, "media-index.json"), JSON.stringify({ kappa: idx.kappa, rows: rows.map((r) => ({ label: r.label, n: r.cards.length })) }, null, 2));
console.log(`\nmedia-index κ ${idx.kappa}`);
console.log(`rows: ${rows.map((r) => r.label + "=" + r.cards.length).join(" · ")} · ${cards.length} cards · blobs in ${BDIR}`);
