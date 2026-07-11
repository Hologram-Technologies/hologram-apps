// holo-torrent-kappa.mjs — a .torrent file IS a chunk table (K3 of HOLO-TV-KAPPA-NATIVE-PROMPT.md).
//
// BitTorrent already content-addresses media: the info dict carries fixed-size piece SHA-1s, and (BEP-19)
// url-list webseeds give plain HTTPS sources for every piece — Internet Archive publishes one for every
// item. So instead of downloading gigabytes to mint chunk tables, we PARSE the torrent (KBs) and verify
// each piece against its hash before a byte reaches the decoder — 100% compatible with any .torrent
// (v1 single- or multi-file), no swarm required when webseeds/HTTP sources exist. Pure ESM, browser+Node,
// zero deps: bencode parser + piece↔file geometry + a verified byte-range streamer. Law L5 at piece
// granularity: a failed piece REFUSES by name — never fed, never skipped.

const td = new TextDecoder();

// ── bencode (parse only) — returns JS values; byte-strings stay Uint8Array, dict keys decoded ─────────
export function bdecode(buf) {
  let p = 0;
  const str = () => { let s = p; while (buf[p] !== 58) p++; const n = +td.decode(buf.slice(s, p)); p++; const v = buf.subarray(p, p + n); p += n; return v; };
  const any = () => {
    const c = buf[p];
    if (c === 105) { p++; let s = p; while (buf[p] !== 101) p++; const n = +td.decode(buf.slice(s, p)); p++; return n; }          // i…e
    if (c === 108) { p++; const a = []; while (buf[p] !== 101) a.push(any()); p++; return a; }                                     // l…e
    if (c === 100) { p++; const o = { __start: 0 }; delete o.__start; const start = p - 1; while (buf[p] !== 101) { const k = td.decode(str()); o[k] = any(); } p++; Object.defineProperty(o, "__span", { value: [start, p], enumerable: false }); return o; } // d…e
    return str();
  };
  return any();
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export async function sha1hex(u8) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", u8))); }

// ── torrentView: bytes → a normalized, serializable chunk-table view ──────────────────────────────────
export async function torrentView(bytes) {
  const t = bdecode(bytes);
  const info = t.info;
  if (!info || !info.pieces || !info["piece length"]) throw new Error("not a v1 torrent (no piece table)");
  const [s, e] = info.__span;                                        // exact bencoded info slice → infohash
  const infoHash = await sha1hex(bytes.subarray(s, e));
  const name = td.decode(info.name);
  const pieceLength = info["piece length"];
  const pieces = []; for (let i = 0; i + 20 <= info.pieces.length; i += 20) pieces.push(hex(info.pieces.subarray(i, i + 20)));
  let files = [], off = 0;
  if (info.files) for (const f of info.files) { files.push({ path: f.path.map((x) => td.decode(x)).join("/"), length: f.length, offset: off }); off += f.length; }
  else { files = [{ path: name, length: info.length, offset: 0 }]; off = info.length; }
  const webseeds = (Array.isArray(t["url-list"]) ? t["url-list"] : t["url-list"] ? [t["url-list"]] : []).map((u) => td.decode(u));
  return { name, infoHash, pieceLength, pieces, files, totalLength: off, webseeds, multi: !!info.files };
}

// BEP-19 webseed URL for a file (multi-file: seed + name + / + path; single: seed [+ name if seed ends /])
export const webseedURL = (view, seed, file) =>
  view.multi ? seed + (seed.endsWith("/") ? "" : "/") + encodeURI(view.name) + "/" + encodeURI(file.path)
             : (seed.endsWith("/") ? seed + encodeURI(view.name) : seed);

// ── verified streaming of ONE file inside the torrent ────────────────────────────────────────────────
// Pieces are hashed over the CONCATENATION of all files, so an edge piece needs a few bytes from the
// neighbouring files — fetched by Range from the same webseed. fetchRange(file, start, end) → Uint8Array
// (end exclusive, relative to that file). Emits verified segments of the TARGET file, in order.
export async function* verifiedFileStream(view, fileIdx, fetchRange, { cachePiece, cachedPiece } = {}) {
  const file = view.files[fileIdx];
  const firstPiece = Math.floor(file.offset / view.pieceLength);
  const lastPiece = Math.floor((file.offset + file.length - 1) / view.pieceLength);
  const byFileOffset = (abs) => { for (let i = 0; i < view.files.length; i++) { const f = view.files[i]; if (abs < f.offset + f.length) return { f, rel: abs - f.offset, i }; } return null; };
  for (let p = firstPiece; p <= lastPiece; p++) {
    const pStart = p * view.pieceLength, pEnd = Math.min(pStart + view.pieceLength, view.totalLength);
    const want = view.pieces[p];
    let piece = cachedPiece ? await cachedPiece(want) : null;        // content-addressed: the piece HASH is the key
    if (piece && (await sha1hex(piece)) !== want) piece = null;      // poisoned cache refuses like a poisoned fetch
    if (!piece) {
      const parts = [];
      let cur = pStart;
      while (cur < pEnd) {                                           // gather the piece across file boundaries
        const loc = byFileOffset(cur); if (!loc) throw new Error("piece geometry out of range");
        const take = Math.min(pEnd - cur, loc.f.length - loc.rel);
        parts.push(await fetchRange(loc.f, loc.rel, loc.rel + take));
        cur += take;
      }
      piece = parts.length === 1 ? parts[0] : (() => { const out = new Uint8Array(pEnd - pStart); let o = 0; for (const q of parts) { out.set(q, o); o += q.length; } return out; })();
      const got = await sha1hex(piece);
      if (got !== want) { const err = new Error(`piece ${p} refused — sha1 ${got.slice(0, 12)}… ≠ ${want.slice(0, 12)}…`); err.piece = p; err.kappa = "sha1:" + want; throw err; }
      if (cachePiece) { try { await cachePiece(want, piece); } catch {} }
    }
    // slice out the target file's share of this verified piece
    const fs = Math.max(pStart, file.offset), fe = Math.min(pEnd, file.offset + file.length);
    yield { piece: p, offset: fs - file.offset, bytes: piece.subarray(fs - pStart, fe - pStart) };
  }
}
