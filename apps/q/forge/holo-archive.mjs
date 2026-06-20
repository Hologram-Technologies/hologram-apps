// GGUF → .holo writer/reader. A .holo is the precompiled, streamable, content-
// addressed package the cold-load runtime consumes: a section table + a Weights
// section of sha256-keyed, deduplicated weight bodies laid out in FIRST-USE order
// (so streaming arrives in compute order), with the GGUF header (metadata +
// tokenizer) baked in as an Extension and a footer fingerprint = the model's
// did:holo. Each body's ABSOLUTE file offset is in the directory, so a single
// weight is range-fetchable (HTTP Range) and verified by re-derivation (L5).
//
// Layout aligns to hologram/crates/hologram-archive (MAGIC "HOLO" v2, SectionRef
// {kind,offset,len}, Weights=3/Metadata=8/Extension=14). Hash axis is sha256 (the
// forge axis = SRI = L5), not the Rust crate's blake3 — byte-exact Rust-decoder
// interop is out of scope; this is the JS runtime's streaming package.

import { forgeGguf } from "./gguf-forge.mjs";
import { parseGgufHeader } from "../qvac-ingest.mjs";
import { sha256hex, didHolo } from "../../../../holo-os/system/os/usr/lib/holo/holo-uor.mjs";

const MAGIC = [0x48, 0x4f, 0x4c, 0x4f];           // "HOLO"
const VERSION = 2;
const K = { Weights: 3, Metadata: 8, Extension: 14 };
const HEX = (h) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; };
const hexOf = (b) => { let s = ""; for (const x of b) s += x.toString(16).padStart(2, "0"); return s; };

// ── writer ──
export function writeHolo(ggufBytes) {
  const f = forgeGguf(ggufBytes);
  const dataOffset = parseGgufHeader(ggufBytes).dataOffset;
  const headerBytes = ggufBytes.subarray(0, dataOffset);   // GGUF metadata + tokenizer + tensor infos

  // first-use order = GGUF tensor directory order (token_embd → per-layer → output);
  // dedup bodies by κ but keep first-occurrence order.
  const order = [], seen = new Map();             // κ-hex → {offset(within bodies), len}
  let bodyTotal = 0;
  for (const t of f.tensors) {
    const hex = t.kappa.split(":").pop();
    if (!seen.has(hex)) { seen.set(hex, { off: bodyTotal, len: t.nbytes }); bodyTotal += t.nbytes; }
    order.push({ name: t.name, kappa: hex });
  }
  const uniq = [...seen.entries()];               // [hex, {off,len}]

  const meta = JSON.stringify({ format: "holo/2", arch: f.arch, sourceRoot: f.rootKappa, nTensors: f.tensors.length, nBodies: uniq.length, order });
  const extKey = "gguf.header";
  const enc = new TextEncoder();
  const metaBytes = enc.encode(meta);
  const extKeyBytes = enc.encode(extKey);
  const extPayload = cat([u16(extKeyBytes.length), extKeyBytes, headerBytes]);   // [keyLen][key][bytes]
  const dirCount = uniq.length;
  const dirBytes = 4 + dirCount * (32 + 8 + 8);   // [count u32][κ(32) off(u64) len(u64)]×
  const weightsLen = dirBytes + bodyTotal;

  // layout: header + section-table + ext + meta + weights + footer(32)
  const sectionCount = 3;
  const headSize = 4 + 2 + 2 + 2 + sectionCount * (1 + 8 + 8);
  const extOff = headSize, metaOff = extOff + extPayload.length, weightsOff = metaOff + metaBytes.length;
  const bodiesStart = weightsOff + dirBytes;
  const fileLen = bodiesStart + bodyTotal + 32;

  const out = new Uint8Array(fileLen);
  const dv = new DataView(out.buffer);
  let p = 0;
  out.set(MAGIC, p); p += 4;
  dv.setUint16(p, VERSION, true); p += 2;
  dv.setUint16(p, 0, true); p += 2;               // flags
  dv.setUint16(p, sectionCount, true); p += 2;
  const sec = (kind, off, len) => { out[p] = kind; p += 1; dv.setBigUint64(p, BigInt(off), true); p += 8; dv.setBigUint64(p, BigInt(len), true); p += 8; };
  sec(K.Extension, extOff, extPayload.length);
  sec(K.Metadata, metaOff, metaBytes.length);
  sec(K.Weights, weightsOff, weightsLen);
  out.set(extPayload, extOff);
  out.set(metaBytes, metaOff);
  // weights directory (ABSOLUTE file offsets) + bodies
  dv.setUint32(weightsOff, dirCount, true);
  let dp = weightsOff + 4;
  const store = (h) => f.blocks.get(h);
  for (const [hex, info] of uniq) {
    out.set(HEX(hex), dp); dp += 32;
    dv.setBigUint64(dp, BigInt(bodiesStart + info.off), true); dp += 8;
    dv.setBigUint64(dp, BigInt(info.len), true); dp += 8;
    out.set(store(hex), bodiesStart + info.off);
  }
  // footer = sha256 over everything before the footer → the .holo's identity
  const footHex = sha256hex(out.subarray(0, fileLen - 32));
  out.set(HEX(footHex), fileLen - 32);
  return { holo: out, rootHolo: didHolo("sha256", footHex), nBodies: uniq.length, nTensors: f.tensors.length, bytes: fileLen };
}

// ── reader ──
export function readHolo(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error("not a .holo");
  if (dv.getUint16(4, true) !== VERSION) throw new Error("holo version");
  const sectionCount = dv.getUint16(8, true);
  let p = 10; const sections = {};
  for (let i = 0; i < sectionCount; i++) { const kind = bytes[p]; const off = Number(dv.getBigUint64(p + 1, true)); const len = Number(dv.getBigUint64(p + 9, true)); sections[kind] = { off, len }; p += 17; }
  // footer verify (L5 on the whole archive)
  const footHex = hexOf(bytes.subarray(bytes.length - 32));
  if (sha256hex(bytes.subarray(0, bytes.length - 32)) !== footHex) throw new Error("holo footer mismatch (tamper)");
  // extension: gguf header
  const e = sections[K.Extension]; const keyLen = dv.getUint16(e.off, true);
  const headerBytes = bytes.subarray(e.off + 2 + keyLen, e.off + e.len);
  // metadata
  const m = sections[K.Metadata];
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(m.off, m.off + m.len)));
  // weights directory → κ-hex → {offset(abs), len}
  const w = sections[K.Weights]; const count = dv.getUint32(w.off, true); const dir = new Map();
  let dp = w.off + 4;
  for (let i = 0; i < count; i++) { const hex = hexOf(bytes.subarray(dp, dp + 32)); dp += 32; const off = Number(dv.getBigUint64(dp, true)); dp += 8; const len = Number(dv.getBigUint64(dp, true)); dp += 8; dir.set(hex, { off, len }); }
  const getBody = (kappaOrHex) => { const h = String(kappaOrHex).split(":").pop(); const d = dir.get(h); if (!d) throw new Error("κ not in holo: " + h); return bytes.subarray(d.off, d.off + d.len); };
  // a κ-store with L5 verify on every body fetch
  const store = { get: (h) => { const d = dir.get(h); if (!d) return undefined; const b = bytes.subarray(d.off, d.off + d.len); if (sha256hex(b) !== h) throw new Error("holo L5 REFUSE " + h); return b; }, has: (h) => dir.has(h) };
  return { sections, meta, headerBytes, dir, getBody, store, footer: didHolo("sha256", footHex), rangeOf: (kappaOrHex) => dir.get(String(kappaOrHex).split(":").pop()) };
}

// ── streaming/partial reader: open a .holo over a Range reader (HTTP Range, or a
//    file slice). Fetches only the header + directory up front (~the baked gguf
//    metadata, a few MB); weight bodies are fetched on demand by absolute offset
//    and verified per block (L5). This is the cold-load path. ──
export async function openHoloStream(rangeReader) {
  const head = await rangeReader(0, 64);
  const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  for (let i = 0; i < 4; i++) if (head[i] !== MAGIC[i]) throw new Error("not a .holo");
  if (hdv.getUint16(4, true) !== VERSION) throw new Error("holo version");
  const sectionCount = hdv.getUint16(8, true);
  const tbl = await rangeReader(10, sectionCount * 17);
  const tdv = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
  const sections = {};
  for (let i = 0, p = 0; i < sectionCount; i++, p += 17) sections[tbl[p]] = { off: Number(tdv.getBigUint64(p + 1, true)), len: Number(tdv.getBigUint64(p + 9, true)) };
  // baked gguf header (metadata + tokenizer + tensor infos)
  const e = sections[K.Extension], extBytes = await rangeReader(e.off, e.len);
  const edv = new DataView(extBytes.buffer, extBytes.byteOffset, extBytes.byteLength);
  const keyLen = edv.getUint16(0, true);
  const headerBytes = extBytes.subarray(2 + keyLen);
  // metadata (first-use order, name→κ)
  const m = sections[K.Metadata], metaBytes = await rangeReader(m.off, m.len);
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  // weights directory (κ → absolute offset/len) — only the directory, not the bodies
  const w = sections[K.Weights];
  const cntB = await rangeReader(w.off, 4); const count = new DataView(cntB.buffer, cntB.byteOffset, cntB.byteLength).getUint32(0, true);
  const dirB = await rangeReader(w.off + 4, count * 48), ddv = new DataView(dirB.buffer, dirB.byteOffset, dirB.byteLength);
  const dir = new Map();
  for (let i = 0, p = 0; i < count; i++, p += 48) dir.set(hexOf(dirB.subarray(p, p + 32)), { off: Number(ddv.getBigUint64(p + 32, true)), len: Number(ddv.getBigUint64(p + 40, true)) });
  // hardware-accelerated SHA-256 (WebCrypto, ~GB/s) so per-block L5 verify isn't the
  // bottleneck at high bandwidth; falls back to pure-JS sha256hex if unavailable.
  const cs = globalThis.crypto?.subtle;
  const vhex = cs ? async (b) => { const d = new Uint8Array(await cs.digest("SHA-256", b)); let s = ""; for (const x of d) s += x.toString(16).padStart(2, "0"); return s; } : async (b) => sha256hex(b);
  // fetch + L5-verify one weight body by κ
  const getBody = async (kappaOrHex) => { const h = String(kappaOrHex).split(":").pop(); const d = dir.get(h); if (!d) throw new Error("κ not in holo: " + h); const b = await rangeReader(d.off, d.len); if (await vhex(b) !== h) throw new Error("holo L5 REFUSE " + h); return b; };
  // fetch a sub-range WITHIN a body (e.g. one token_embd row) — defers the rest
  const getBodySlice = async (kappaOrHex, byteOff, byteLen) => { const d = dir.get(String(kappaOrHex).split(":").pop()); return rangeReader(d.off + byteOff, byteLen); };
  return { sections, meta, headerBytes, dir, getBody, getBodySlice, order: meta.order, bodyLen: (k) => dir.get(String(k).split(":").pop())?.len };
}

// ── helpers ──
const u16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
function cat(arrs) { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; }
