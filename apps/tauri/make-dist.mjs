#!/usr/bin/env node
// make-dist.mjs — build the flat, content-addressed OS image the native host serves over holo://.
//
// The OS lives FHS-shaped (system/os/usr/lib/holo/…) but the apps speak a flat URL space
// (/_shared/…, /apps/<id>/…, /home.html). The dev server bridges the two live via
// os/lib/holo-fhs-map.mjs; here we materialize that bridge AHEAD of time into `dist/`, so the host
// is a dumb, fast, content-verifying file reader (lib.rs) with no mapping logic to drift. The result
// boots byte-identically to `node tools/holo-serve-fhs.mjs` and to a GitHub Pages deploy.
//
//   node make-dist.mjs            # → native/dist/  (≈ the 18 MB thin OS image + the pinned apps)

import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
// This project lives at Hologram Apps/apps/tauri (kept OUT of the lean OS repo). Both repos are
// referenced by absolute path — overridable for CI, which checks out both side by side.
const OS2 = process.env.HOLO_OS2_DIR || "C:/Users/pavel/Desktop/Hologram OS2/system/os";
const APPS = process.env.HOLO_APPS_DIR || join(HERE, "..", "..");   // the live apps repo (two up from apps/tauri)
const DIST = join(HERE, "dist");

// The host bundles APP CODE (holospace shells + engines), not DATA (model weights, demo media
// libraries). Data objects are content-addressed and fetched/minted on demand by κ — never shipped
// in the host. This keeps the image lean. The q app's quantized model κ-disk (`models/**`) and the
// video/music demo libraries are the canonical offenders (see memory: relock sweeps _qwen7b).
// `tauri` = THIS project — never sweep the native host's own source/dist into the image it builds.
const SKIP_DIR = /^(node_modules|\.git|_qwen7b\.2bit|_qwen|\.cache|userdata|models|yt|cmaf|tauri)$/i;
const MEDIA_EXT = /\.(m4s|m4a|mp3|wav|flac|aac|ogg|webm|mp4|mov|m3u8)$/i;       // demo content libs
const HEAVY_EXT = /\.(gguf|safetensors|onnx|weights|bin|pt|ckpt|tar|zip|7z|dmg|iso)$/i; // model/archive blobs
const MAX_BYTES = 24 * 1024 * 1024;                            // a single file over 24 MB is not host-bundled

let copied = 0, skipped = 0, bytes = 0;

function ensureDir(p) { mkdirSync(dirname(p), { recursive: true }); }

function copyOne(src, dest) {
  const st = statSync(src);
  if (st.size > MAX_BYTES) { skipped++; return; }
  if (MEDIA_EXT.test(src) && st.size > 256 * 1024) { skipped++; return; }      // demo media → on demand
  if (HEAVY_EXT.test(src) && st.size > 2 * 1024 * 1024) { skipped++; return; } // weights/archives → on demand
  ensureDir(dest);
  copyFileSync(src, dest);
  copied++; bytes += st.size;
}

// recursively copy a tree, honoring the skip rules. destFor maps an absolute src → absolute dest.
function copyTree(srcRoot, destRoot) {
  if (!existsSync(srcRoot)) return;
  for (const name of readdirSync(srcRoot)) {
    const src = join(srcRoot, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (SKIP_DIR.test(name)) { skipped++; continue; }
      copyTree(src, join(destRoot, name));
    } else if (st.isFile()) {
      copyOne(src, join(destRoot, name));
    }
  }
}

// flatten a source dir's contents directly under a flat prefix (e.g. usr/lib/holo/** → _shared/**).
function project(srcRoot, flatPrefix) {
  if (!existsSync(srcRoot)) return;
  copyTree(srcRoot, join(DIST, flatPrefix));
}

// project a single file to a flat name.
function projectFile(src, flatName) {
  if (existsSync(src) && statSync(src).isFile()) copyOne(src, join(DIST, flatName));
}

console.log("make-dist: building", relative(HERE, DIST));
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });

// 1) IDENTITY copy of the OS2 FHS tree → dist/  (so every real /usr, /etc, /boot, /srv path resolves
//    by passthrough — the last fhsMap rule). This is the thin ~18 MB image.
copyTree(OS2, DIST);

// 2) FLAT PROJECTIONS — every rewrite rule in holo-fhs-map.mjs, precomputed.
project(join(OS2, "usr/lib/holo"), "_shared");                                 // /_shared/* → engines
project(join(OS2, "usr/lib/pkg"), "pkg");                                      // /pkg/*     → vendored libs
for (const html of ["holospace.html", "home.html", "find.html", "splash.html", "login.html", "workspace.html", "pair.html"])
  projectFile(join(OS2, "usr/share/frame", html), html);                      // the boot chain frames
projectFile(join(OS2, "boot/index.html"), "boot.html");                       // rEFInd at the root
project(join(OS2, "boot/boot"), "boot");                                       // …its own asset subdir
for (const f of ["holo-boot-sw.js", "coi-serviceworker.min.js"]) projectFile(join(OS2, "boot", f), f);
for (const f of ["holo-sw.js", "holo-launch.mjs", "holo-omni.mjs", "holo-boot-sw-register.mjs", "browser-sw.js"])
  projectFile(join(OS2, "lib", f), f);                                        // loading-seam SWs + launchers
for (const f of ["holo-resolver.mjs", "holo-sources.mjs", "holo-peers.mjs", "holo-uor.mjs", "holo-object.mjs", "holo-wire.mjs"])
  projectFile(join(OS2, "sbin", f), f);                                       // the resolver core
for (const f of ["manifest.webmanifest", "os-closure.json"]) projectFile(join(OS2, "etc", f), f);
for (const f of ["icon-192.png", "icon-512.png"]) projectFile(join(OS2, "usr/share/icons", f), f);
project(join(OS2, "etc/terms"), "terms");
for (const s of ["a2a", "nanda", "skills", "atlas"]) project(join(OS2, "srv", s), s);     // flat service aliases

// 3) LIVE apps from the separate Hologram Apps repo → dist/apps/**  (a holospace boots from anywhere
//    by κ; the dev server's readRel prefers this repo). Heavy artifacts are skipped (above).
copyTree(join(APPS, "apps"), join(DIST, "apps"));
projectFile(join(APPS, "apps/index.jsonld"), "apps/index.jsonld");            // the apps catalog (flat)

const mb = (bytes / 1048576).toFixed(1);
console.log(`make-dist: ${copied} files, ${mb} MB  (skipped ${skipped} heavy/vcs)`);
if (!existsSync(join(DIST, "apps/browser/index.html"))) {
  console.error("make-dist: WARNING — apps/browser/index.html missing; the host has no boot page.");
  process.exit(1);
}

// ── SEAL the image (Law L5) ──────────────────────────────────────────────────────────────────────
// Re-derive the content address of every byte we are about to ship and write dist/os-closure.json so
// the host's κ-route verifies the WHOLE image against itself: a self-consistent, tamper-evident
// snapshot. We also cross-check each pin against the CANONICAL OS closure (provenance) and report
// drift — files newer than the OS's last reseal (dev-in-flight apps), which is expected, not tamper.
const canon = (() => { try { const c = JSON.parse(readFileSync(join(OS2, "etc/os-closure.json"), "utf8")).closure || {}; const m = new Map(); for (const [p, v] of Object.entries(c)) m.set(p, String(typeof v === "string" ? v : v.kappa || "").split(":").pop()); return m; } catch { return new Map(); } })();
const sealed = {};
let matched = 0, drifted = 0;
function sealTree(root, prefix = "") {
  for (const name of readdirSync(root)) {
    const abs = join(root, name); const key = prefix ? prefix + "/" + name : name;
    const st = statSync(abs);
    if (st.isDirectory()) { sealTree(abs, key); continue; }
    if (key === "os-closure.json") continue;                          // the manifest never pins itself
    const flat = key.replace(/\\/g, "/");
    const buf = readFileSync(abs);
    const hex = createHash("sha256").update(buf).digest("hex");
    sealed[flat] = { kappa: "did:holo:sha256:" + hex, sri: "sha256-" + createHash("sha256").update(buf).digest("base64"), bytes: st.size };
    if (canon.has(flat)) { if (canon.get(flat) === hex) matched++; else drifted++; }
  }
}
sealTree(DIST);
const manifest = { "@context": "https://hologram.os/ns/closure", name: "hologram-native-image", note: "Self-sealed native OS image (Law L5). Every byte re-derives to its κ; the host refuses a mismatch.", files: Object.keys(sealed).length, closure: sealed };
writeFileSync(join(DIST, "os-closure.json"), JSON.stringify(manifest, null, 0));
console.log(`make-dist: sealed ${Object.keys(sealed).length} κ pins  (vs canonical OS: ${matched} match, ${drifted} drift = dev-in-flight)`);
console.log("make-dist: dist ready →", DIST);
