// pin-homebrew-all.mjs — decentralize the WHOLE freely-shared Game Boy homebrew library.
// For every real game in the gbdev Homebrew Hub (all free to redistribute): fetch the ROM, compile it
// into a κ-addressable object (blake3 κ = CIDv1 raw block, via holo-ipfs), pin it to IPFS (Pinata), and
// record {title, cid=blake3κ, ipfs=servable CID, art, bytes}. Output → games/homebrew-manifest.json,
// the decentralized address book the app browses + plays from. 100% legal (homebrew), 100% content-
// addressed, verify-on-read. Resumable + idempotent (skips already-pinned); rate-limit friendly.
//
//   PINATA_JWT=<jwt> node _dev/pin-homebrew-all.mjs [--limit N]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const OUT = join(APP, "homebrew-manifest.json");
const IPFS = pathToFileURL(join(APP, "holo-ipfs.js")).href;
const { cidOf, cidToString, CODEC, HASH, blake3, toHex } = await import(IPFS);

const JWT = process.env.PINATA_JWT;
if (!JWT) { console.error("set PINATA_JWT"); process.exit(2); }
const LIMIT = process.argv.includes("--limit") ? +process.argv[process.argv.indexOf("--limit") + 1] : 1e9;
const RAW = "https://raw.githubusercontent.com/gbdev/database/master/entries/";
const MAX = 1 << 20;                       // single raw block ceiling (1 MiB) — bigger would need a DAG
const NOTGAME = /\b(demo|beta|proto(type)?|tool|test|wip|alpha|preview|teaser|sample|homage|tech|benchmark|hello world)\b/i;

const j = (u) => fetch(u, { headers: { "user-agent": "holo-homebrew/1" }, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
const buf = (u) => fetch(u, { headers: { "user-agent": "holo-homebrew/1" }, signal: AbortSignal.timeout(30000) }).then(async (r) => r.ok ? new Uint8Array(await r.arrayBuffer()) : null);

let man = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { built: "gbdev-hh", hash: "blake3", games: {} };

console.log("fetching gbdev tree…");
const tree = await j("https://api.github.com/repos/gbdev/database/git/trees/master?recursive=1");
const bySlug = new Map();
for (const n of tree.tree) { const m = /^entries\/([^/]+)\/(.+)$/.exec(n.path); if (m && n.type === "blob") (bySlug.get(m[1]) || bySlug.set(m[1], []).get(m[1])).push({ file: m[2], size: n.size }); }
const slugs = [...bySlug.keys()].filter((s) => bySlug.get(s).some((f) => f.file === "game.json")).sort();
console.log("entries: " + slugs.length + " · already pinned: " + Object.keys(man.games).length);

let pinned = 0, skip = 0, fail = 0, checked = 0;
for (const slug of slugs) {
  if (pinned >= LIMIT) break;
  checked++;
  let meta; try { meta = await j(RAW + slug + "/game.json"); } catch { continue; }
  if (!meta || meta.typetag !== "game" || (meta.platform && !/^GBC?$/i.test(meta.platform))) continue;
  const title = meta.title || slug;
  if (man.games[title] && man.games[title].ipfs) { skip++; continue; }         // resume
  if (NOTGAME.test(title)) continue;
  const rf = (meta.files || []).find((f) => f.playable && f.default) || (meta.files || []).find((f) => f.playable);
  if (!rf || !/\.(gb|gbc)$/i.test(rf.filename)) continue;
  const rm = bySlug.get(slug).find((f) => f.file === rf.filename);
  if (!rm || rm.size > MAX || rm.size < 8192) continue;
  try {
    const bytes = await buf(RAW + slug + "/" + encodeURIComponent(rf.filename));
    if (!bytes || bytes.length > MAX || bytes.length < 8192) { fail++; continue; }
    const cid = cidToString(await cidOf(bytes, CODEC.RAW, HASH.BLAKE3));         // blake3 κ = CID
    const shot = (meta.screenshots || [])[0];
    // pin to Pinata → the servable (sha256) CID
    const fd = new FormData();
    fd.append("file", new Blob([bytes]), rf.filename);
    fd.append("pinataMetadata", JSON.stringify({ name: title, keyvalues: { blake3: toHex(blake3(bytes)), system: "gb" } }));
    const pr = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { authorization: "Bearer " + JWT }, body: fd });
    if (!pr.ok) { console.log("✗ pin " + title + " → " + pr.status); fail++; continue; }
    const ipfs = (await pr.json()).IpfsHash;
    man.games[title] = { cid, ipfs, bytes: bytes.length, system: "gb", ext: /\.gbc$/i.test(rf.filename) ? "gbc" : "gb",
      art: shot ? RAW + slug + "/" + encodeURIComponent(shot) : "", source: "https://hh.gbdev.io/entries/" + slug };
    pinned++;
    if (pinned % 10 === 0) { writeFileSync(OUT, JSON.stringify(man)); console.log("  … " + pinned + " pinned (" + title + ")"); }
  } catch (e) { console.log("✗ " + title + " → " + e.message); fail++; }
}
writeFileSync(OUT, JSON.stringify(man));
console.log("\nDONE · pinned " + pinned + " · resumed-skip " + skip + " · fail " + fail + " · total in commons " + Object.keys(man.games).length + " → homebrew-manifest.json");
