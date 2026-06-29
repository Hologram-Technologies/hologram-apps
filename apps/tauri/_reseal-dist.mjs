// _reseal-dist.mjs — robust reseal of dist/os-closure.json, byte-identical in format to make-dist's seal
// (same holo-blake3 + sha256 + sri + bytes), but long-path-safe and tolerant of unreadable blocks (the
// pre-existing skift .holo deep-path quirk that crashes make-dist's seal walk on Windows). Reseals the
// WHOLE current dist tree so every served byte re-derives to its pin (Law L5), then re-bakes the SW anchor.
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const OS2 = join(HERE, "../../../holo-os/system/os");
const { blake3hex } = await import(pathToFileURL(join(OS2, "usr/lib/holo/holo-blake3.mjs")).href);

const lp = (p) => (process.platform === "win32" ? "\\\\?\\" + resolve(p) : p);
const statS = (p) => { try { return statSync(p); } catch { return statSync(lp(p)); } };
const readS = (p) => { try { return readFileSync(p); } catch { return readFileSync(lp(p)); } };

const OUT_OF_CLOSURE = new Set(["os-closure.json", "holo-fhs-sw.js"]);
const sealed = {}; const skipped = [];
function walk(root, prefix = "") {
  for (const name of readdirSync(root)) {
    const abs = join(root, name); const key = prefix ? prefix + "/" + name : name;
    let st; try { st = statS(abs); } catch (e) { skipped.push(key + " (stat)"); continue; }
    if (st.isDirectory()) { walk(abs, key); continue; }
    const flat = key.replace(/\\/g, "/");
    if (OUT_OF_CLOSURE.has(flat)) continue;
    let buf; try { buf = readS(abs); } catch (e) { skipped.push(flat + " (read)"); continue; }
    const hex = createHash("sha256").update(buf).digest("hex");
    sealed[flat] = { kappa: "did:holo:sha256:" + hex, blake3: "did:holo:blake3:" + blake3hex(buf), sri: "sha256-" + createHash("sha256").update(buf).digest("base64"), bytes: st.size };
  }
}
walk(DIST);
const manifest = { "@context": "https://hologram.os/ns/closure", name: "hologram-native-image", algo: "sha256+blake3", note: "Self-sealed native OS image (Law L5, dual-axis). Every byte re-derives to BOTH its sha256 κ and its blake3 σ-axis; the host refuses a mismatch on either, and refuses any unpinned byte in this sealed image (SEC-1/SEC-6).", files: Object.keys(sealed).length, closure: sealed };
writeFileSync(join(DIST, "os-closure.json"), JSON.stringify(manifest, null, 0));
const anchor = createHash("sha256").update(readFileSync(join(DIST, "os-closure.json"))).digest("hex");
const swPath = join(DIST, "holo-fhs-sw.js");
if (existsSync(swPath)) {
  const sw = readFileSync(swPath, "utf8");
  if (/const CLOSURE_KAPPA = "[0-9a-f]{0,64}"/.test(sw)) writeFileSync(swPath, sw.replace(/const CLOSURE_KAPPA = "[0-9a-f]{0,64}"/, `const CLOSURE_KAPPA = "${anchor}"`));
}
console.log(`reseal-dist: sealed ${Object.keys(sealed).length} pins · skipped ${skipped.length} · anchor ${anchor.slice(0, 16)}…`);
if (skipped.length) console.log("  skipped:", skipped.slice(0, 6).join(", ") + (skipped.length > 6 ? " …" : ""));
