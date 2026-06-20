// holo-load2bit.mjs — the LOAD-DIRECT consumer (the "load" half of the 7B infra). Given a pre-compiled
// 2-bit κ-object (manifest.json + content-addressed b/<κ>.gz blocks, produced by compile2bit.mjs), it builds
// the engine manifest + a fetchTensor that streams blocks, verifies each by re-deriving its κ (Law L5),
// gunzips, and hands the engine the weights ALREADY 2-bit — no re-quant at load. The engine reads
// manifest.preQuantized=true (parts() returns the blocks verbatim) and incoherent=false (LDLQ ⇒ no FWHT).
// Hosting = serve the κ-object dir from anywhere; the κ-verify makes any mirror untrusted-safe.
import { f16ToF32 } from "./qvac-ingest.mjs";

async function gunzip(u8) { const ds = new DecompressionStream("gzip"); const w = ds.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function loadKappaObject(baseUrl, opts = {}) {
  // Law L5: the manifest is the ROOT that names every block's κ. Verify the manifest's OWN bytes
  // re-derive to a pinned κ BEFORE trusting man.tensors[*].kappa — otherwise a tampered manifest can
  // re-point every block to a forged-but-self-consistent κ and each per-block check passes against the
  // forgery. The pin is an EXTERNAL anchor (catalog/lock), never the manifest's own self-asserted root.
  const manRaw = new Uint8Array(await (await fetch(baseUrl + "/manifest.json", { cache: "no-store" })).arrayBuffer());
  const manKappa = "sha256:" + hex(await crypto.subtle.digest("SHA-256", manRaw));
  const pin = opts.expectKappa ? String(opts.expectKappa).replace(/^did:holo:/, "") : null;
  if (pin) { if (manKappa !== pin) throw new Error("manifest κ MISMATCH (Law L5): " + manKappa.slice(0, 24) + "… ≠ pinned " + pin.slice(0, 24) + "…"); }
  else if (!opts.allowUnpinned) throw new Error("manifest unpinned (Law L5): pass opts.expectKappa (catalog pin) or opts.allowUnpinned for dev");
  const man = JSON.parse(new TextDecoder().decode(manRaw));
  // cache-less: the engine fetches each tensor exactly once, so blocks are decoded, handed over, and
  // released — bounding browser memory to ~one block at a time (a 7B κ-object decompresses to >2.6 GB).
  const getBlock = async (kappa) => {
    const gz = new Uint8Array(await (await fetch(baseUrl + "/b/" + kappa.replace(":", "_") + ".gz", { cache: "no-store" })).arrayBuffer());
    const got = "sha256:" + hex(await crypto.subtle.digest("SHA-256", gz));         // Law L5: re-derive the κ
    if (got !== kappa) throw new Error("κ MISMATCH " + kappa.slice(0, 24));
    return await gunzip(gz);
  };
  const fetchTensor = async (name) => {
    const rec = man.tensors[name]; if (!rec) return new Uint8Array(0);
    const raw = await getBlock(rec.kappa);
    if (rec.fmt === "2bit" && rec.fp16) {                  // [2-bit packed][fp16 scales] → [2-bit][f32 scales] (the engine reads f32)
      const Kp = rec.K, q2 = (rec.N * Kp) / 4, nsc = rec.N * (Kp / 32);
      const f16 = new Uint16Array(raw.buffer, raw.byteOffset + q2, nsc);
      const out = new Uint8Array(q2 + nsc * 4); out.set(raw.subarray(0, q2), 0);
      const f32 = new Float32Array(out.buffer, q2, nsc); for (let i = 0; i < nsc; i++) f32[i] = f16ToF32(f16[i]);
      return out;
    }
    return raw;                                            // 2bit+f32 (incoherence), q8 (embed), f32 (norms) — verbatim
  };
  const tensors = Object.entries(man.tensors).map(([name, rec]) => ({ name, N: rec.N, K: rec.K, blk: rec.fmt !== "f32", fmt: rec.fmt, ...(rec.s !== undefined ? { s: rec.s } : {}) }));   // engine tmap form (matrices+embed = blk; norms = not); fmt drives per-tensor kernels (e8q/t2); s = t2 per-tensor scale
  // E₈ codebook (mode e8): the 256×8 LUT is its own content-addressed block — fetch + κ-verify (Law L5)
  let e8lutData;
  if (man.e8lut) { const b = await getBlock(man.e8lut.replace(/^did:holo:/, "")); e8lutData = new Float32Array(b.buffer, b.byteOffset, 2048); }
  const native = man.mode === "q4" || man.mode === "q3" || man.mode === "e8" || man.mode === "bitnet";   // native-bits κ-object (rides the engine's bits=N path; e8/bitnet = q3f embed/lm_head + per-tensor e8q/t2 kernels); old 2-bit modes use twoBit
  const manifest = {
    d: man.d, n_heads: man.n_heads, n_kv_heads: man.n_kv_heads, ff: man.ff, vocab: man.vocab, n_layers: man.n_layers, hd: man.hd,
    bits: native ? man.bits : 8, layout: man.layout, rope_base: man.rope_base, ...(man.maskId !== undefined ? { maskId: man.maskId, diffusion: true } : {}), attn_bias: man.attn_bias, qk_norm: man.qk_norm, qk_norm_dim: man.qk_norm_dim, tied: man.tied,
    ...(man.sub_norm ? { sub_norm: true } : {}), ...(man.bitlinear ? { bitlinear: true } : {}), ...(man.ffn_act ? { ffn_act: man.ffn_act } : {}), ...(man.moe ? { moe: man.moe } : {}),
    ...(native ? {} : { twoBit: true, incoherent: man.incoherent === true, preQuantized: true }), tensors, ...(e8lutData ? { e8lutData } : {}),
  };
  // bundled tokenizer: a relative `source` resolves against the κ-object's own dir (self-contained,
  // no external HF dependency). readHeader will fetch <baseUrl>/tokenizer.gguf locally.
  if (man.source && !/^https?:\/\//.test(man.source)) man.source = baseUrl.replace(/\/+$/, "") + "/" + man.source;
  return { manifest, fetchTensor, info: man };
}
