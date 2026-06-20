// prism-argon2id — the hologram-native Argon2id proof-of-work engine.
//
// BrowserCoin's PoW is memory-hard Argon2id (RFC 9106), NOT sha256d. To mine
// REAL BRC the digest must be byte-identical to what the network's verifier
// (`checkPoW` → `powHash`) computes, so we vendor the *exact* argon2id wasm
// bytes BrowserCoin ships (openpgpjs/argon2id @ 1.0.1) and wrap them in the
// prism `mineRange` bounded-sweep contract — the same shape as the sha256d
// `prism-btc` kernel, but for the BRC σ-axis.
//
//   PoW(header) = argon2id(
//     password = header,                 // the 148-byte canonical header
//     salt     = "browsercoin-pow-v5",
//     m = 32 MiB, t = 1, p = 1, len = 32 // POW_PARAMS — network-wide consensus
//   )
//
// A header admits when the 32-byte digest, read big-endian, is < target, where
// target = compactToTarget(header.difficulty). This file is κ-pinned (Law L5);
// `brc-witness.mjs` re-derives these bytes and a known-answer vector offline,
// and the in-page loader refuses a κ mismatch. A forged byte fails.

import setupWasm from './setup.js';
import { SIMD_WASM_BASE64, NO_SIMD_WASM_BASE64 } from './argon2id-wasm.js';

/** Network-wide consensus PoW parameters. Changing any value forks the chain. */
export const POW_PARAMS = Object.freeze({
  memorySize: 32 * 1024, // KiB → 32 MB
  iterations: 1,
  parallelism: 1,
  hashLength: 32,
});

/** Fixed network salt (the version suffix is the hard-fork lever). */
const SALT = new TextEncoder().encode('browsercoin-pow-v5');

/** encodeHeader layout (big-endian): nonce occupies [112..116). */
export const HEADER_LEN = 148;
export const NONCE_OFFSET = 112;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// One engine per JS context (worker / main thread / node). setupWasm allocates
// a single ~65 MB WebAssembly.Memory at load and reuses it for every hash —
// that one allocation is what eliminates the per-nonce OOM class.
let enginePromise = null;
export function loadEngine() {
  if (enginePromise) return enginePromise;
  const simd = base64ToBytes(SIMD_WASM_BASE64);
  const noSimd = base64ToBytes(NO_SIMD_WASM_BASE64);
  enginePromise = setupWasm(
    (imp) => WebAssembly.instantiate(simd, imp),
    (imp) => WebAssembly.instantiate(noSimd, imp),
  );
  return enginePromise;
}

/** PoW digest of a 148-byte header. Returns a 32-byte Uint8Array. */
export async function powHash(headerBytes) {
  const argon2id = await loadEngine();
  return argon2id({
    password: headerBytes,
    salt: SALT,
    parallelism: POW_PARAMS.parallelism,
    passes: POW_PARAMS.iterations,
    memorySize: POW_PARAMS.memorySize,
    tagLength: POW_PARAMS.hashLength,
  });
}

/** True iff the digest, read as a big-endian 256-bit integer, is < target. */
export function hashMeetsTarget(hash, target) {
  let h = 0n;
  for (let i = 0; i < hash.length; i++) h = (h << 8n) | BigInt(hash[i]);
  return h < target;
}

/**
 * The prism `mineRange` contract, Argon2id edition. Sweeps `count` nonces from
 * `startNonce` over the 148-byte header (mutating bytes [112..116) big-endian),
 * hashing each with the κ-pinned engine. Returns the first admitting nonce, or
 * `found:false` if the slice is exhausted / stopped.
 *
 * Synchronous-per-hash inside (argon2id is sync after warm-up) but `async` so
 * the caller can `await` slices and stay responsive. `opts.shouldStop()` is
 * polled each hash for instant Stop; `opts.onHash(i, nonce)` fires per hash.
 *
 * @param {Uint8Array} headerBytes 148-byte encoded header template
 * @param {string} targetHex 64-hex big-endian target (compactToTarget output)
 * @param {number} startNonce u32
 * @param {number} count nonces to try this slice
 */
export async function mineRange(headerBytes, targetHex, startNonce, count, opts = {}) {
  const argon2id = await loadEngine();
  const header = new Uint8Array(headerBytes); // own copy; we mutate the nonce field
  const target = BigInt('0x' + targetHex);
  const { shouldStop, onHash } = opts;
  let nonce = startNonce >>> 0;
  for (let i = 0; i < count; i++) {
    header[NONCE_OFFSET] = (nonce >>> 24) & 0xff;
    header[NONCE_OFFSET + 1] = (nonce >>> 16) & 0xff;
    header[NONCE_OFFSET + 2] = (nonce >>> 8) & 0xff;
    header[NONCE_OFFSET + 3] = nonce & 0xff;
    const digest = argon2id({
      password: header,
      salt: SALT,
      parallelism: POW_PARAMS.parallelism,
      passes: POW_PARAMS.iterations,
      memorySize: POW_PARAMS.memorySize,
      tagLength: POW_PARAMS.hashLength,
    });
    if (hashMeetsTarget(digest, target)) {
      return { found: true, nonce, digest, attempts: i + 1 };
    }
    if (onHash) onHash(i + 1, nonce);
    nonce = (nonce + 1) >>> 0;
    if (shouldStop && shouldStop()) return { found: false, nonce, attempts: i + 1, stopped: true };
  }
  return { found: false, nonce, attempts: count };
}
