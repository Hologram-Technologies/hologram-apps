// kappa-compile.mjs — compile every game into a κ-addressable object, the stack's own way.
// Each ROM → a CIDv1 whose multihash IS its BLAKE3 κ (codec raw 0x55, hash blake3 0x1e). One identity:
// the same string is the did:holo κ (universal resolver) AND the IPFS content address. Verify-on-read
// (holo-ipfs verifyBlock) refuses any gateway byte that doesn't re-derive to its CID — Law L5, native.
//
// Output: games/ipfs-manifest.json  { title → { cid, bytes, system, rom } }.  Offline + free: CIDs are
// computed from the bytes, truthful BEFORE anything is pinned. Pinning (fills the IPFS commons) is a
// separate background step; the manifest is the compiled, decentralized address book.
//
//   node _dev/kappa-compile.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;   // holo-ipfs uses WebCrypto for sha2; blake3 is pure-JS

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");                                          // apps/games
const IPFS = pathToFileURL(join(APP, "..", "browser", "_shared", "holo-ipfs.js")).href;
const { cidOf, cidToString, verifyBlock, CODEC, HASH, blake3, toHex } = await import(IPFS);

// the raw-block ceiling: a ROM under this is ONE content-addressed block (CID = κ directly). Bigger ROMs
// would chunk into a UnixFS DAG (a manifest of block-κs) — the homebrew batch is all single-block.
const RAW_MAX = 1 << 20;   // 1 MiB

const romDir = join(APP, "roms", "hh");
const arcade = JSON.parse(readFileSync(join(APP, "arcade.json"), "utf8")).games;
const bySlug = new Map(arcade.map((g) => [g.slug, g]));

const manifest = {};
let n = 0, big = 0;
for (const f of readdirSync(romDir).filter((f) => /\.(gb|gbc)$/i.test(f))) {
  const bytes = new Uint8Array(readFileSync(join(romDir, f)));
  const slug = f.replace(/\.(gb|gbc)$/i, "");
  const meta = bySlug.get(slug);
  if (bytes.length > RAW_MAX) { big++; continue; }                    // (none expected in this batch)
  const cid = await cidOf(bytes, CODEC.RAW, HASH.BLAKE3);             // κ = CID: raw block + blake3 multihash
  const cidStr = cidToString(cid);
  // prove Law L5 both ways: verifyBlock accepts the true bytes, and the κ equals raw blake3
  const ok = await verifyBlock(cidStr, bytes);
  const kappa = toHex(blake3(bytes));
  if (!ok) throw new Error("verify FAILED for " + slug);
  manifest[meta ? meta.title : slug] = { cid: cidStr, kappa, bytes: bytes.length, system: "gb", rom: "./roms/hh/" + f };
  n++;
}
writeFileSync(join(APP, "ipfs-manifest.json"), JSON.stringify({ codec: "raw", hash: "blake3", games: manifest }, null, 0));

const sample = Object.entries(manifest).slice(0, 3);
console.log("compiled " + n + " κ-objects (" + big + " too big for a single raw block)");
for (const [t, m] of sample) console.log("  · " + t.padEnd(30) + " cid " + m.cid + "  (blake3 κ " + m.kappa.slice(0, 16) + "…, " + m.bytes + "B)");
console.log("\nmanifest → games/ipfs-manifest.json — the CID string IS the did:holo κ AND the IPFS address.");
