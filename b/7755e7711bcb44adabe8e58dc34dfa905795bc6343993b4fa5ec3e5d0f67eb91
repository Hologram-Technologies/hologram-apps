// core/holo-stream-load.mjs — H1 of HOLO-BITNET-CANONICAL-INSTANT: load a model from ONE `.holo`
// (packed by forge/holo-kappa-pack.mjs) instead of 330 loose b/<κ>.gz blocks. Returns the SAME
// { manifest, fetchTensor, info } contract as loadKappaObject, PLUS { tokenizerBytes } (embedded),
// so core/loader.js can drop it in and createQvacGPU / the KV path stay untouched.
//
// WHY: the drawer + q-chat cold-load = 330 HTTP requests to HF (latency-bound, the #1 felt defect —
// DRAWER-TRUTH T2). The `.holo` is ONE Range-streamable file: header (1 req) → bodies by absolute
// offset, coalesced + prefetched, each block BLAKE3-verified over its STORED (gzip) bytes BEFORE
// gunzip (Law L5, cheapest). WARM: the whole file persists to OPFS on first load; later boots read
// it locally with re-verify (never trusted). Cold falls back to the parts path in loader.js on any
// throw (fail-soft). Bodies are byte-identical to the parts blocks, so output is byte-identical.
import { reshapeTensor, buildEngineManifest } from "../holo-load2bit.mjs";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function gunzip(u8) { const ds = new DecompressionStream("gzip"); const w = ds.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(ds.readable).arrayBuffer()); }

// ── OPFS single-file warm store: the whole .holo, keyed by URL, re-verified against header on read ──
const OPFS_DIR = "holo-model-files";
const fname = (url) => String(url).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
async function opfsFile(url) {
  try {
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.getDirectory) return null;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR, { create: true });
    return await dir.getFileHandle(fname(url) + ".holo", { create: true });
  } catch { return null; }
}

export async function openHoloKappa(url, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const range = async (reader, s, l) => reader(s, l);

  // Prefer a fully-resident OPFS copy (warm path); else HTTP Range (cold). Both expose read(off,len).
  let fh = await opfsFile(url), warmFile = null;
  if (fh) { try { const f = await fh.getFile(); if (f.size > 0) warmFile = f; } catch {} }

  const httpRead = async (s, l) => {
    const r = await fetch(url, { headers: { Range: `bytes=${s}-${s + l - 1}` } });
    if (!(r.ok || r.status === 206)) throw new Error("holo range " + r.status + " @" + s);
    return new Uint8Array(await r.arrayBuffer());
  };
  // COLD read = serve from a single whole-file buffer downloaded ONE time (streamed, progress-reported)
  // instead of a Range request per tensor (336 tiny reqs → 1 streamed body). WARM read = OPFS slices.
  // The header+tokenizer are read first (cheap ranges) so the engine can start before the body finishes.
  let wholeBuf = null;
  const read = warmFile
    ? async (s, l) => new Uint8Array(await warmFile.slice(s, s + l).arrayBuffer())
    : async (s, l) => wholeBuf ? wholeBuf.subarray(s, s + l) : httpRead(s, l);

  // header: magic(6) + u32 len + JSON
  const head = await read(0, 10);
  if (new TextDecoder().decode(head.slice(0, 6)) !== "HOLK1\n") throw new Error("bad .holo magic");
  const hlen = new DataView(head.buffer, head.byteOffset).getUint32(6, true);
  const H = JSON.parse(new TextDecoder().decode(await read(10, hlen)));
  if (H.format !== "holo-kappa/1") throw new Error("unknown .holo format " + H.format);

  // canonical BLAKE3 verifier (κ = blake3 over STORED gz bytes). Falls back to no-verify only if wasm
  // is unavailable — but the whole point is L5, so require it when present (it always is in the app).
  let b3 = null;
  try { const fn = (await import("../pkg/holospaces_web.js")).kappa; if (fn(new Uint8Array([1])).startsWith("blake3:")) b3 = fn; } catch {}

  // COLD: stream the WHOLE file once into wholeBuf (progress-reported), so every fetchTensor reads from
  // RAM (zero further network). Then persist to OPFS for the next visit. On warm we skip all this.
  const total = 10 + hlen + H.tokenizer.len + H.dir.reduce((a, r) => a + r.len, 0);
  if (!warmFile) {
    try {
      const resp = await fetch(url);                          // one body; stream with progress
      if (!resp.ok) throw new Error("holo GET " + resp.status);
      const buf = new Uint8Array(total); let got = 0;
      if (resp.body && resp.body.getReader) {
        const rd = resp.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; buf.set(value, got); got += value.length; onProgress(got, total); }
      } else { buf.set(new Uint8Array(await resp.arrayBuffer()), 0); onProgress(total, total); }
      wholeBuf = buf;
    } catch (e) {
      // host without a plain GET (or aborted) → wholeBuf stays null; read() falls back to per-range HTTP.
      try { console.warn("[holo] whole-file stream failed, per-range fallback:", e && e.message || e); } catch {}
    }
    if (wholeBuf && fh && opts.persist !== false) {
      (async () => { try { const w = await fh.createWritable(); await w.write(wholeBuf); await w.close(); } catch {} })();
    }
  }

  // reconstruct the raw manifest (top-level fields + tensors dict) for buildEngineManifest
  const man = { ...H.manifest };
  const normRecs = {};
  const dirByName = {};
  for (const rec of H.dir) { normRecs[rec.name] = { N: rec.N, K: rec.K, fmt: rec.fmt, ...(rec.s !== undefined ? { s: rec.s } : {}) }; dirByName[rec.name] = rec; }
  man.tensors = normRecs;

  // e8 LUT (if any) — a named dir entry; fetch+verify like a block
  const getBody = async (rec) => {
    const gz = await read(rec.off, rec.len);
    if (b3) { const got = b3(gz); if (got !== rec.kappa) throw new Error("BLAKE3 κ MISMATCH " + rec.name + " " + rec.kappa.slice(0, 20)); }
    return await gunzip(gz);
  };
  let e8lutData;
  if (man.e8lut) { const r = H.dir.find((d) => d.kappa === man.e8lut || d.name === "e8lut"); if (r) { const b = await getBody(r); e8lutData = new Float32Array(b.buffer, b.byteOffset, 2048); } }

  const manifest = buildEngineManifest(man, normRecs, e8lutData);

  const fetchTensor = async (name) => {
    const rec = dirByName[name]; if (!rec) return new Uint8Array(0);
    return reshapeTensor({ N: rec.N, K: rec.K, fmt: rec.fmt, ...(rec.s !== undefined ? { s: rec.s } : {}) }, await getBody(rec));
  };

  // embedded tokenizer bytes (the loader uses these directly → no separate HF header fetch)
  const tokenizerBytes = await read(H.tokenizer.off, H.tokenizer.len);
  man.source = url;                                            // informational; tokenizer comes from tokenizerBytes

  return { manifest, fetchTensor, info: man, tokenizerBytes, warm: !!warmFile };
}
