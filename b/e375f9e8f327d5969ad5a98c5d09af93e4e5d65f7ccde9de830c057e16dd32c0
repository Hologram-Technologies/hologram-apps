// pin-ipfs.mjs — pin every compiled κ-object into the IPFS commons via Pinata, so the CIDs the
// manifest already carries become RETRIEVABLE. Two things recorded per game:
//   · cid   — the blake3 κ=CID (raw block) — the sovereign identity + what verify-on-read checks.
//   · ipfs  — the CID the pinning service actually serves (Pinata pins sha256 UnixFS by default);
//             the retrieval address that every public gateway understands. Same bytes; on arrival we
//             re-hash and check against the blake3 κ (Law L5), so it's BLAKE-verified regardless.
// If a gateway later proves it serves our blake3 CID directly, `ipfs` collapses back to `cid`.
//
//   PINATA_JWT=<jwt> node _dev/pin-ipfs.mjs [--limit N]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const JWT = process.env.PINATA_JWT;
if (!JWT) { console.error("set PINATA_JWT=<your Pinata JWT>"); process.exit(2); }
const LIMIT = process.argv.includes("--limit") ? +process.argv[process.argv.indexOf("--limit") + 1] : 9999;

const man = JSON.parse(readFileSync(join(APP, "ipfs-manifest.json"), "utf8"));
const entries = Object.entries(man.games);
let done = 0, failed = 0;
for (const [title, m] of entries) {
  if (done >= LIMIT) break;
  if (m.ipfs) { done++; continue; }                                   // idempotent: skip already-pinned
  try {
    const bytes = readFileSync(join(APP, m.rom.replace(/^\.\//, "")));
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), basename(m.rom));
    fd.append("pinataMetadata", JSON.stringify({ name: title, keyvalues: { blake3: m.kappa, system: m.system } }));
    const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST", headers: { authorization: "Bearer " + JWT }, body: fd,
    });
    if (!r.ok) { console.log("✗ " + title + " → " + r.status + " " + (await r.text()).slice(0, 120)); failed++; continue; }
    const j = await r.json();
    m.ipfs = j.IpfsHash;                                              // the servable CID
    done++;
    console.log("✓ " + done + "/" + entries.length + "  " + title.padEnd(28) + " ipfs " + j.IpfsHash);
    writeFileSync(join(APP, "ipfs-manifest.json"), JSON.stringify(man, null, 0));   // persist as we go
  } catch (e) { console.log("✗ " + title + " → " + e.message); failed++; }
}
console.log("\npinned " + done + " · failed " + failed + " → games/ipfs-manifest.json now carries retrievable CIDs");
