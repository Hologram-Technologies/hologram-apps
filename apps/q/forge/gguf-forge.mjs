// GGUF Forge — split a GGUF into κ-addressable objects, ORIGINAL BYTES PRESERVED.
//
// This is the "compile into κ-addressable objects" core. Unlike qvac-ingest's
// makeDiskFetcher (which dequantizes then RE-QUANTIZES Q4_K/Q6_K into the engine's
// lossy 4-bit format — a fidelity violation for "strictly adhere to original
// code"), the forge stores each tensor's EXACT on-disk ggml quant bytes as its own
// content-addressed κ-object. The κ of a tensor IS the hash of the bytes llama.cpp
// would mmap, so fidelity is byte-literal and L5-verifiable on every load.
//
// Output:
//   • blocks:  Map<hex, Uint8Array>   the κ-store (one object per tensor, by content)
//   • plan:    a JSON manifest of arch + hparams + per-tensor {dims, type, κ, sri}
//   • rootKappa: did:holo:sha256 of the canonical plan — the model's identity (L1)
//
// Laws: L1 identity=content, L2 one object per tensor (dedup by κ), L5 verify by
// re-derivation. holospaces github.com/Hologram-Technologies/holospaces.

import { parseGgufHeader } from "../qvac-ingest.mjs";
import { sha256hex, sriOf, kappa, didHolo, jcs } from "../../../../holo-os/system/os/usr/lib/holo/holo-uor.mjs";

// ── ggml type → (block elements, block bytes). Source: ggml.c type_traits table
//    (blck_size, type_size). Covers the standard set a Qx_K_M GGUF uses. Exotic
//    IQ*/TBQ/MXFP4 types throw until their kernels land (honest, not silent). ──
const QK = 32, QK_K = 256;
const TYPE_BLOCK = {
  0:  [1, 4],          // F32
  1:  [1, 2],          // F16
  2:  [QK, 18],        // Q4_0
  3:  [QK, 20],        // Q4_1
  6:  [QK, 22],        // Q5_0
  7:  [QK, 24],        // Q5_1
  8:  [QK, 34],        // Q8_0
  9:  [QK, 36],        // Q8_1
  10: [QK_K, 84],      // Q2_K
  11: [QK_K, 110],     // Q3_K
  12: [QK_K, 144],     // Q4_K
  13: [QK_K, 176],     // Q5_K
  14: [QK_K, 210],     // Q6_K
  15: [QK_K, 292],     // Q8_K (intermediate; not normally stored)
  16: [QK_K, 66],      // IQ2_XXS
  17: [QK_K, 74],      // IQ2_XS
  18: [QK_K, 98],      // IQ3_XXS
  19: [QK_K, 50],      // IQ1_S
  20: [QK, 18],        // IQ4_NL (block = 32 elems)
  21: [QK_K, 110],     // IQ3_S
  22: [QK_K, 82],      // IQ2_S
  23: [QK_K, 136],     // IQ4_XS
  29: [QK_K, 56],      // IQ1_M
  30: [1, 2],          // BF16
};
export const GGML_TYPE_NAME = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1",
  10: "Q2_K", 11: "Q3_K", 12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K",
  16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL",
  21: "IQ3_S", 22: "IQ2_S", 23: "IQ4_XS", 29: "IQ1_M", 30: "BF16",
};

// ggml_nbytes for a contiguous tensor of `numElements` of `ggmlType` (the exact
// span llama.cpp loads — excludes inter-tensor alignment padding).
export function ggmlNBytes(ggmlType, numElements) {
  const bt = TYPE_BLOCK[ggmlType];
  if (!bt) throw new Error(`gguf-forge: unsupported ggml type ${ggmlType} (no block size yet)`);
  const [blk, bytes] = bt;
  if (numElements % blk !== 0) throw new Error(`gguf-forge: ${numElements} not divisible by block ${blk} (type ${ggmlType})`);
  return (numElements / blk) * bytes;
}

const numElements = (dims) => dims.reduce((a, b) => a * b, 1);

// Forge a full in-memory GGUF (Uint8Array) into κ-objects. For multi-GB models the
// streaming variant (forgeGgufStream, below) does the same with a Range reader so
// no tensor beyond the one being hashed is ever resident.
export function forgeGguf(bytes) {
  const { version, dataOffset, tensors, meta } = parseGgufHeader(bytes);
  const blocks = new Map();
  const planTensors = [];
  for (const t of tensors) {
    const n = numElements(t.dims);
    const nbytes = ggmlNBytes(t.ggmlType, n);
    const start = dataOffset + t.offset;
    const end = start + nbytes;
    if (end > bytes.byteLength) throw new Error(`gguf-forge: tensor ${t.name} runs past EOF (${end} > ${bytes.byteLength})`);
    // EXACT bytes — no copy semantics changed, no re-quant. This subarray IS the κ-object.
    const blob = bytes.subarray(start, end);
    const hex = sha256hex(blob);
    if (!blocks.has(hex)) blocks.set(hex, blob.slice()); // own the bytes; L2 dedup by content
    planTensors.push({
      name: t.name, dims: t.dims, type: t.ggmlType, typeName: GGML_TYPE_NAME[t.ggmlType] || String(t.ggmlType),
      nbytes, kappa: kappa("sha256", hex), sri: sriOf(blob),
    });
  }
  const arch = meta["general.architecture"] || "unknown";
  // The plan is the sealed manifest: arch + all scalar metadata + per-tensor κ refs.
  // No raw weight bytes here — only content addresses. Hashing it gives model identity.
  const plan = {
    format: "gguf-forge/1",
    arch,
    ggufVersion: version,
    meta,                 // scalar hparams + tokenizer ids captured by parseGgufHeader
    tensors: planTensors, // ordered as in the GGUF directory
  };
  const planHex = sha256hex(jcs(plan));
  const rootKappa = didHolo("sha256", planHex);
  return { version, dataOffset, arch, meta, tensors: planTensors, blocks, plan, rootKappa };
}

// Streaming forge: same κ-objects from a Range reader (start,len)->Promise<Uint8Array>,
// for models too large to hold whole. Reads the header once, then each tensor span once.
export async function forgeGgufStream(readRange, { headerBytes }) {
  const { version, dataOffset, tensors, meta } = parseGgufHeader(headerBytes);
  const blocks = new Map();
  const planTensors = [];
  for (const t of tensors) {
    const n = numElements(t.dims);
    const nbytes = ggmlNBytes(t.ggmlType, n);
    const blob = await readRange(dataOffset + t.offset, nbytes);
    if (blob.byteLength !== nbytes) throw new Error(`gguf-forge: short read for ${t.name}`);
    const hex = sha256hex(blob);
    if (!blocks.has(hex)) blocks.set(hex, blob);
    planTensors.push({
      name: t.name, dims: t.dims, type: t.ggmlType, typeName: GGML_TYPE_NAME[t.ggmlType] || String(t.ggmlType),
      nbytes, kappa: kappa("sha256", hex), sri: sriOf(blob),
    });
  }
  const arch = meta["general.architecture"] || "unknown";
  const plan = { format: "gguf-forge/1", arch, ggufVersion: version, meta, tensors: planTensors };
  const rootKappa = didHolo("sha256", sha256hex(jcs(plan)));
  return { version, dataOffset, arch, meta, tensors: planTensors, blocks, plan, rootKappa };
}

// L5: load a tensor's bytes by κ, RE-DERIVE the hash, refuse on mismatch.
// `store` is any { get(hex) -> Uint8Array | undefined }. Accepts "sha256:<hex>",
// "did:holo:sha256:<hex>", or a bare hex.
export function loadByKappa(store, kappaRef) {
  const hex = String(kappaRef).split(":").pop();
  const bytes = store.get(hex);
  if (!bytes) throw new Error(`gguf-forge: κ not found: ${kappaRef}`);
  const got = sha256hex(bytes);
  if (got !== hex) throw new Error(`gguf-forge: L5 REFUSE — ${kappaRef} re-derives to sha256:${got}`);
  return bytes;
}

// Re-derive the whole plan's identity from a store: verify every tensor block, then
// re-hash the plan. Returns the recomputed rootKappa (throws on any tamper).
export function verifyPlan(store, plan) {
  for (const t of plan.tensors) loadByKappa(store, t.kappa); // L5 per block
  return didHolo("sha256", sha256hex(jcs(plan)));
}

// Map-backed κ-store helper for tests/Node.
export function mapStore(blocks) {
  return { get: (hex) => blocks.get(hex), has: (hex) => blocks.has(hex), put: (b) => { const h = sha256hex(b); blocks.set(h, b); return h; } };
}
