// holo-stream.mjs — make any discoverable title instantly playable. The latency trick: a ROM is tiny and
// content-addressable, so we PREFETCH it while the user is still looking at it (prefetchTitle), resolve it
// 0-network from a shipped index, fetch the bytes through ONE device-agnostic seam (fetchRom), and cache it
// content-addressed in OPFS. By the time Play is pressed the bytes are already in hand → boot is instant.
//
// Personal-use stance unchanged: bytes come from the user's chosen source (the Internet Archive sets r-roms
// catalogs), fetched host-side (no CORS) via the allowlisted proxy, unzipped + run + cached LOCALLY (OPFS),
// never re-hosted. Same-origin OPFS means a ROM prefetched by the catalog is already warm for the play page.

import { CONSOLES } from "./consoles.mjs";
import { SOURCES, archiveSetUrl } from "./sources.mjs";
// a console's archive may be ONE item (string) or an ORDERED ARRAY of items (multi-source, widest set).
const itemsFor = (sysCode) => {
  const it = CONSOLES[sysCode] && CONSOLES[sysCode].archive;
  if (!it) throw new Error("streaming not wired for this console yet");
  return Array.isArray(it) ? it : [it];
};

// strip any leading folder segments first ("Atari 2600/Donkey Kong (USA)" → "Donkey Kong (USA)") so
// subdir-prefixed romset items resolve against plain catalog titles; URLs still use the full name.
const norm = (s) => s.split("/").pop().replace(/\.(zip|gb|gbc|nes|sfc|md|gba)$/i, "").replace(/\s*\([^)]*\)/g, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
function regionRank(name) {
  const r = (/\(([^)]*)\)/.exec(name)?.[1] || "").toLowerCase();
  if (r.includes("usa")) return 0; if (r.includes("world")) return 1; if (r.includes("europe")) return 2; if (r.includes("japan")) return 3; return 4;
}

// ── 0-network index: a precomputed shard (gen at build) shipped beside this module; the live archive
//    metadata API is only a self-healing fallback. Resolution at play-time is then a local lookup. ──
// One item → its name list. Cached per item; shared across consoles that reference the same item.
const _item = {};
async function itemNames(item) {
  if (_item[item]) return _item[item];
  try {
    const r = await fetch(new URL("./index/" + item + ".json", import.meta.url));
    if (r.ok) { const names = await r.json(); if (names && names.length) return (_item[item] = names); }
  } catch (e) {}
  // fallback: live archive metadata (cached)
  const KEY = "holo-romidx:" + item;
  try { const c = JSON.parse(localStorage.getItem(KEY) || "null"); if (c && c.length) return (_item[item] = c); } catch (e) {}
  const meta = await (await fetch("https://archive.org/metadata/" + item)).json();
  const names = (meta.files || []).map((f) => f.name).filter((n) => /\.zip$/i.test(n)).map((n) => n.replace(/\.zip$/i, ""));
  try { localStorage.setItem(KEY, JSON.stringify(names)); } catch (e) {}
  return (_item[item] = names);
}
// A console's union index: every name across its ordered items, plus a name→item map so a resolved title is
// fetched from the item that actually holds it. Built once per console code.
const _idx = {};
async function index(sysCode) {
  if (_idx[sysCode]) return _idx[sysCode];
  const names = [], itemOf = new Map();
  for (const item of itemsFor(sysCode)) {
    for (const n of await itemNames(item)) if (!itemOf.has(n)) { itemOf.set(n, item); names.push(n); }
  }
  return (_idx[sysCode] = { names, itemOf });
}

// push pre-release/unofficial dumps (10) below the clean release (0). Among equal region+junk, the
// `score` tiebreaker prefers the PLAINEST variant (fewest parenthetical tags) — so the standalone cart wins
// over re-release/compilation dumps (Virtual Console, iam8bit, Mega Collection, …) without enumerating them.
const junkRank = (n) =>
  /\((Beta|Proto(?!\w)|Demo|Sample|Pirate|Hack|Promo)\b/i.test(n) ? 10 :
  /\([^)]*\b(Collection|Anniversary|Virtual Console|Switch Online|Classic Mini|GameCube|Aftermarket|Unl)\b[^)]*\)/i.test(n) ? 5 : 0;   // re-release dumps: often missing from cart items
const parenCount = (n) => (n.match(/\(/g) || []).length;
// junk ≫ region ≫ plainness: a clean cart in ANY region beats a beta/collection dump in the
// preferred one — collection dumps regularly 404 on the per-game cart items.
const score = (n) => junkRank(n) * 100000 + regionRank(n) * 100 + parenCount(n);
// Resolution ladder — an indexed title must ALWAYS play; a picker is a failure state.
//   1. exact norm matches (the precise identity), ranked region≫junk≫plainness
//   2. fuzzy: containment either way ("Zelda II" ⊂ "Zelda II - The Adventure of Link"),
//      ranked by closeness (nearest title text) ≫ junk ≫ region ≫ plainness
// Returns a RANKED CANDIDATE LIST — the byte layer walks it until one actually serves
// (a top-ranked re-release dump can 404 on the archive item; the next candidate must
// get its chance before any picker appears). Empty ONLY on zero text overlap.
export async function resolveCandidates(title, sysCode, max = 8) {
  const { names } = await index(sysCode);
  const want = norm(title);
  if (!want) return [];
  const exact = names.filter((n) => norm(n) === want).sort((a, b) => score(a) - score(b));
  const fkey = (n) => Math.abs(norm(n).length - want.length) * 1e6 + junkRank(n) * 1e4 + regionRank(n) * 10 + parenCount(n);
  const fuzzy = names.filter((n) => { const m = norm(n); return m !== want && (m.includes(want) || want.includes(m)); })
    .sort((a, b) => fkey(a) - fkey(b));
  return [...exact, ...fuzzy].slice(0, max);
}
export async function resolveTitle(title, sysCode) {
  return (await resolveCandidates(title, sysCode, 1))[0] || null;
}
export async function search(query, sysCode, max = 40) {
  const { names } = await index(sysCode);
  const q = norm(query);
  if (!q) return [];
  return names.filter((n) => norm(n).includes(q)).slice(0, max);
}

// ── content-addressed cache in OPFS (same-origin → shared between the catalog prefetch and the play page);
//    falls back to localStorage for tiny ROMs if OPFS is unavailable. ──
// `kind` namespaces the cache: "rom" = the source bytes as fetched (a per-game .zip, or a .7z for archive-set
// consoles); "z64" = the DECODED raw ROM the engine extracted (so repeat plays skip both the fetch AND the slow
// .7z decode entirely — the difference between a ~60s first boot and an instant one).
const ckey = (sysCode, name, kind = "rom") => kind + "_" + sysCode + "_" + encodeURIComponent(name);

// PRIMARY store = IndexedDB. OPFS is BLOCKED in the CEF host (getFileHandle throws SecurityError "unsafe for
// access"), and localStorage caps at a few MB — so a multi-MB ROM only survives in IDB here. OPFS/localStorage
// stay as fallbacks for web/mobile builds where they work. IDB stores the bytes by structured clone (any key
// string is fine) and a readwrite transaction's `oncomplete` is the durable-write signal.
let _idb = null;
function idb() {
  if (_idb) return _idb;
  _idb = new Promise((resolve, reject) => {
    let r; try { r = indexedDB.open("holo-roms", 1); } catch (e) { return reject(e); }
    r.onupgradeneeded = () => { try { r.result.createObjectStore("roms"); } catch (e) {} };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return _idb;
}
async function idbGet(k) {
  try { const db = await idb(); return await new Promise((res) => { const rq = db.transaction("roms").objectStore("roms").get(k); rq.onsuccess = () => { const v = rq.result; res(v ? (v instanceof Uint8Array ? v : new Uint8Array(v)) : null); }; rq.onerror = () => res(null); }); } catch (e) { return null; }
}
async function idbPut(k, bytes) {
  try { const db = await idb(); return await new Promise((res) => { const tx = db.transaction("roms", "readwrite"); tx.objectStore("roms").put(bytes, k); tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false); }); } catch (e) { return false; }
}
async function cacheGet(sysCode, name, kind) {
  const k = ckey(sysCode, name, kind);
  const fromIdb = await idbGet(k); if (fromIdb && fromIdb.length) return fromIdb;
  try { const d = await navigator.storage.getDirectory(); const fh = await d.getFileHandle(k); return new Uint8Array(await (await fh.getFile()).arrayBuffer()); } catch (e) {}
  try { const b64 = localStorage.getItem(k); if (b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } } catch (e) {}
  return null;
}
async function cachePut(sysCode, name, bytes, kind) {
  const k = ckey(sysCode, name, kind);
  if (await idbPut(k, bytes)) return;
  try { const d = await navigator.storage.getDirectory(); const fh = await d.getFileHandle(k, { create: true }); const w = await fh.createWritable(); await w.write(bytes); await w.close(); return; } catch (e) {}
  try { if (bytes.length <= 2_000_000) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); localStorage.setItem(k, btoa(s)); } } catch (e) {}
}
export async function isCached(title, sysCode) {
  try { const name = await resolveTitle(title, sysCode); return !!(name && await cacheGet(sysCode, name)); } catch (e) { return false; }
}

// ROM bytes are fetched HOST-SIDE to dodge CORS. In the CEF host that seam is the holo://games/rom proxy; when
// the app is served over plain HTTP (local-browser preview), it's the dev server's /__romproxy (identical
// behaviour). Detect by the page's scheme so the SAME code runs in both.
const ROM_PROXY_BASE = (typeof location !== "undefined" && location.protocol === "holo:") ? "holo://games/rom" : "/__romproxy";

function unzipRom(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let p = -1; for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { p = i; break; } }
  if (p < 0) throw new Error("not a zip");
  const cdOff = dv.getUint32(p + 16, true), cdCount = dv.getUint16(p + 10, true);
  let off = cdOff, entry = null;
  for (let n = 0; n < cdCount && dv.getUint32(off, true) === 0x02014b50; n++) {
    const method = dv.getUint16(off + 10, true), compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const nm = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (/\.(gb|gbc|nes|sfc|smc|fig|swc|md|gen|bin|sms|gg|sg|gba|pce|ngp|ngc|ws|wsc|vb|a78|a26|min|z64|n64|v64)$/i.test(nm)) { entry = { nm, method, compSize, lho }; break; }
  }
  if (!entry) throw new Error("no ROM in zip");
  const lNameLen = dv.getUint16(entry.lho + 26, true), lExtra = dv.getUint16(entry.lho + 28, true);
  const ds = entry.lho + 30 + lNameLen + lExtra;
  return { method: entry.method, comp: u8.subarray(ds, ds + entry.compSize) };
}

// fetch + unzip ONE mirror's byte URL → ROM bytes, or null if this mirror missed / returned a non-zip (an
// HTML error page, an ad wrapper, a 404) so the chain falls through to the next mirror. Desktop native goes
// through the host proxy (holo://games/rom, no CORS); a web/mobile build routes THIS call to the κ-peer/edge
// backend — same chain, same verify, different transport.
async function fetchUnzip(byteUrl) {
  const via = ROM_PROXY_BASE + "?u=" + encodeURIComponent(byteUrl) + "&mime=application/zip";
  const res = await fetch(via);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 64) return null;
  try {
    const { method, comp } = unzipRom(buf);
    return method === 0 ? new Uint8Array(comp) : new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  } catch (e) { return null; }
}

// ── the ONE byte-transport seam (per-game .zip consoles). A title is one identity (its exact No-Intro name);
//    resolve its bytes from each source in order, first valid ROM wins. A source that's down/missing/garbage
//    just falls through. Bytes are cached content-addressed in OPFS. (Consoles with no per-game archive.org
//    item use the ARCHIVE-SET raw path instead — streamRawTitle.) ──
async function fetchRom(name, sysCode) {
  const { itemOf } = await index(sysCode);
  const item = itemOf.get(name) || null;
  for (const src of SOURCES) {
    const u = src.urlFor(name, sysCode, item);
    if (!u) continue;
    try { const bytes = await fetchUnzip(u); if (bytes && bytes.length) return bytes; } catch (e) {}
  }
  throw new Error("not found — " + name);
}

// stream a ROM by its EXACT No-Intro name → raw bytes (cache → fetchRom → cache).
export async function streamByName(name, sysCode, onStatus) {
  const cached = await cacheGet(sysCode, name);
  if (cached) { onStatus && onStatus("ready"); return cached; }
  onStatus && onStatus("streaming…");
  const bytes = await fetchRom(name, sysCode);
  cachePut(sysCode, name, bytes);   // fire-and-forget cache write
  return bytes;
}
export async function streamTitle(title, sysCode, onStatus) {
  const candidates = await resolveCandidates(title, sysCode);
  if (!candidates.length) throw new Error("not in the " + (sysCode || "gb") + " library");
  // walk the ranked candidates until one actually serves bytes — a 404'd top pick
  // (shard drift, collection-only dump) must fall through, never dead-end the player
  let lastErr = null;
  for (const name of candidates) {
    try { return { name, bytes: await streamByName(name, sysCode, onStatus) }; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no source served " + title);
}

// ── RAW path for the ARCHIVE-SET / EJS tier (N64): the byte source is a per-game .7z extracted from the
//    complete No-Intro set on archive.org. We DON'T unzip here — EmulatorJS extracts the .7z itself — so we
//    fetch the raw bytes through the host proxy (no CORS) and hand them straight to the engine. OPFS-cached by
//    name so repeats are instant. ──
async function fetchRawBytes(byteUrl) {
  const via = ROM_PROXY_BASE + "?u=" + encodeURIComponent(byteUrl) + "&mime=application/octet-stream";
  const res = await fetch(via);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  // archive.org serves the inner .7z (magic 37 7A BC AF); a miss returns an HTML page → reject it
  if (!buf || buf.byteLength < 64) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x3c) return null;   // '<' → HTML error/listing page, not an archive
  return u8;
}
export async function streamRawTitle(title, sysCode, onStatus) {
  const name = await resolveTitle(title, sysCode);
  if (!name) throw new Error("not in the " + (sysCode || "n64") + " library");
  // 1) DECODED ROM already cached → instant (no fetch, no decode). The engine gets a raw ROM and just boots.
  const decoded = await cacheGet(sysCode, name, "z64");
  if (decoded) { onStatus && onStatus("ready"); return { name, bytes: decoded, decoded: true }; }
  // 2) source .7z: from cache, else fetch it cold from the archive.org complete set.
  let raw = await cacheGet(sysCode, name, "rom");
  if (!raw) {
    onStatus && onStatus("streaming…");
    const url = archiveSetUrl(sysCode, name);
    if (!url) throw new Error("no archive-set source for " + sysCode);
    raw = await fetchRawBytes(url);
    if (!raw || !raw.length) throw new Error("not found in archive set — " + name);
    cachePut(sysCode, name, raw, "rom");
  }
  // 3) DECODE the .7z → raw ROM here (libarchive WASM, ~1s) instead of letting the engine's asm.js decoder do
  //    it (~40s). Cache the decoded ROM so repeats skip everything. Fall back to handing the engine the .7z if
  //    decode fails for any reason (the engine can still extract it, just slowly).
  onStatus && onStatus("decoding…");
  try {
    const { decode7z } = await import("./lib/holo-7z.mjs");
    const out = await decode7z(raw);
    if (out && out.bytes && out.bytes.length) {
      cachePut(sysCode, name, out.bytes, "z64");   // decoded cache → instant next play
      return { name, bytes: out.bytes, decoded: true };
    }
  } catch (e) {}
  return { name, bytes: raw, decoded: false };
}
// Cache the engine-decoded raw ROM so the next play of this title skips the fetch AND the slow .7z decode.
// Called by the play surface once the emulator has the extracted ROM in its filesystem.
export async function putDecodedRom(name, sysCode, bytes) {
  try { if (name && bytes && bytes.length) await cachePut(sysCode, name, bytes, "z64"); } catch (e) {}
}

// ── PREFETCH engine: warm a title's bytes into the cache in the background while the user browses, so Play
//    is instant. Deduped + concurrency-capped; failures are silent. Call from the catalog on hover/focus. ──
const _seen = new Set(); let _active = 0; const _queue = [];
function _pump() {
  while (_active < 3 && _queue.length) {
    const job = _queue.shift(); _active++;
    job().catch(() => {}).finally(() => { _active--; _pump(); });
  }
}
export function prefetchTitle(title, sysCode) {
  if (!title) return;
  const key = sysCode + "|" + title;
  if (_seen.has(key)) return;
  _seen.add(key);
  _queue.push(async () => {
    const name = await resolveTitle(title, sysCode);
    if (!name) return;
    if (await cacheGet(sysCode, name)) return;          // already warm
    const bytes = await fetchRom(name, sysCode);
    await cachePut(sysCode, name, bytes);
  });
  _pump();
}
