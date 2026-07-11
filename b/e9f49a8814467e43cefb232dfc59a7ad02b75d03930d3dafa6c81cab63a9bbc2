// holo-7z.mjs — fast .7z extraction for the archive-set play path (N64). archive.org's complete No-Intro set
// stores each game as a per-game .7z (LZMA2); EmulatorJS CAN extract it but its asm.js decoder takes ~40s. This
// uses libarchive.js (vendored under ./libarchive/, BSD-licensed, WASM in a module worker) which decodes the
// SAME file in ~0.8s — measured. We decode here, hand the engine the RAW ROM, and cache the decoded ROM, so a
// first play is ~1s of decode instead of ~40s, and repeats are instant. Off the main thread (worker).
import { Archive } from "./libarchive/libarchive.js";

let _inited = false;
function ensureInit() {
  if (_inited) return;
  // {} (not null) → no custom getWorker → libarchive spawns its default module worker resolved relative to
  // libarchive.js (worker-bundle.js + libarchive.wasm are co-located in ./libarchive/).
  Archive.init({});
  _inited = true;
}

// decode a single-file .7z (or .zip/.rar/.tar — libarchive handles all) → the inner ROM's raw bytes.
export async function decode7z(bytes) {
  ensureInit();
  const archive = await Archive.open(new Blob([bytes]));
  const files = await archive.extractFiles();
  const names = Object.keys(files || {});
  if (!names.length) throw new Error("empty archive");
  // pick the largest entry — the ROM (No-Intro .7z hold exactly one file, but be robust)
  let best = names[0], bestSize = -1;
  for (const n of names) { const sz = (files[n] && files[n].size) || 0; if (sz > bestSize) { bestSize = sz; best = n; } }
  const ab = await files[best].arrayBuffer();
  return { name: best, bytes: new Uint8Array(ab) };
}
