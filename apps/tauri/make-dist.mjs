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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
// This project lives at Hologram Apps/apps/tauri (kept OUT of the lean OS repo). The canonical OS is
// resolved via HOLO_OS2_DIR (CI checks out both repos side by side); locally it defaults to the OS repo
// checked out BESIDE this one (…/HOLOGRAM/holo-os/system/os). Never a hardcoded absolute dev path — a
// missing OS dir must FAIL LOUD (below), never silently build an empty image (the stale/empty dist is
// exactly what derailed the 2026-06-20 audit). Single source of truth: this dist is GENERATED, not authored.
const OS2 = process.env.HOLO_OS2_DIR || join(HERE, "../../../holo-os/system/os");
const APPS = process.env.HOLO_APPS_DIR || join(HERE, "..", "..");   // the live apps repo (two up from apps/tauri)
const DIST = join(HERE, "dist");

// Fail loud if the canonical OS isn't where we expect — a silent empty build is worse than no build.
if (!existsSync(OS2)) {
  console.error(`make-dist: canonical OS not found at\n  ${OS2}\nSet HOLO_OS2_DIR to the OS repo's system/os (CI checks it out side by side).`);
  process.exit(1);
}
// --check: a CI/pre-build preflight — verify the source resolves without building. Exit 0 if OK.
if (process.argv.includes("--check")) { console.log("make-dist --check: canonical OS resolves →", OS2); process.exit(0); }

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

// IN-IMAGE weight bundles: faculty .holo models that MUST ship in the host image (served same-origin by
// the κ-route, per-block L5). GitHub-release κ-delivery is CORS-blocked for in-browser fetch, so the
// native host can't heal these cross-origin — they ride in the closure. Keep this list tight (each adds
// its full size to the image). The 0.5B WASM brain is the responsive floor (Q's `respond` faculty).
const INIMAGE_HOLO = /[\\/]apps[\\/]q[\\/]forge[\\/]\.models[\\/]qwen2\.5-0\.5b-onnx\.holo$/;

function copyOne(src, dest) {
  const st = statSync(src);
  if (!INIMAGE_HOLO.test(src)) {
    if (st.size > MAX_BYTES) { skipped++; return; }
    if (MEDIA_EXT.test(src) && st.size > 256 * 1024) { skipped++; return; }      // demo media → on demand
    if (HEAVY_EXT.test(src) && st.size > 2 * 1024 * 1024) { skipped++; return; } // weights/archives → on demand
  }
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
// Project EVERY frame page to the flat root (holo://os/<page>.html). The canonical OS desktop is
// shell.html (home.html redirects to it); a hardcoded subset silently dropped it and others, so the
// desktop 404'd. Projecting the whole frame dir keeps the flat URL space complete.
for (const f of readdirSync(join(OS2, "usr/share/frame")).filter((n) => n.endsWith(".html")))
  projectFile(join(OS2, "usr/share/frame", f), f);
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

// ── SEAL the image (Law L5, DUAL-AXIS) ─────────────────────────────────────────────────────────────
// Re-derive the content address of every byte we are about to ship and write dist/os-closure.json so
// the host's κ-route verifies the WHOLE image against itself: a self-consistent, tamper-evident
// snapshot. We pin BOTH axes — sha256 (the serving κ, did:holo:sha256:…) AND the substrate σ-axis
// blake3 (holospaces ADR-052 / SEC-6 "verify on the κ's own axis"). The σ-axis is computed with the
// OS's OWN standard-BLAKE3 (usr/lib/holo/holo-blake3.mjs, witnessed == the `blake3` crate), so the
// native host's blake3 verification is byte-identical to the substrate's. We also cross-check each pin
// against the CANONICAL OS closure (provenance) and report drift — files newer than the OS's last
// reseal (dev-in-flight apps), which is expected, not tamper.
const { blake3hex } = await import(pathToFileURL(join(OS2, "usr/lib/holo/holo-blake3.mjs")).href);
const canon = (() => { try { const c = JSON.parse(readFileSync(join(OS2, "etc/os-closure.json"), "utf8")).closure || {}; const m = new Map(); for (const [p, v] of Object.entries(c)) m.set(p, String(typeof v === "string" ? v : v.kappa || "").split(":").pop()); return m; } catch { return new Map(); } })();
// Bootstrap files are fetched BY NAME (the bootstrap boundary) and are intentionally OUT of the closure:
// os-closure.json cannot pin itself, and holo-fhs-sw.js is RE-BAKED below (its CLOSURE_KAPPA anchor) so
// any pin taken here would go stale the moment we anchor it. The host exempts exactly these two from its
// fail-closed unpinned check (lib.rs). Everything else MUST be pinned.
const OUT_OF_CLOSURE = new Set(["os-closure.json", "holo-fhs-sw.js"]);
const sealed = {};
let matched = 0, drifted = 0;
function sealTree(root, prefix = "") {
  for (const name of readdirSync(root)) {
    const abs = join(root, name); const key = prefix ? prefix + "/" + name : name;
    const st = statSync(abs);
    if (st.isDirectory()) { sealTree(abs, key); continue; }
    const flat = key.replace(/\\/g, "/");
    if (OUT_OF_CLOSURE.has(flat)) continue;                           // bootstrap boundary — never pinned
    const buf = readFileSync(abs);
    const hex = createHash("sha256").update(buf).digest("hex");
    sealed[flat] = { kappa: "did:holo:sha256:" + hex, blake3: "did:holo:blake3:" + blake3hex(buf), sri: "sha256-" + createHash("sha256").update(buf).digest("base64"), bytes: st.size };
    if (canon.has(flat)) { if (canon.get(flat) === hex) matched++; else drifted++; }
  }
}
sealTree(DIST);
const manifest = { "@context": "https://hologram.os/ns/closure", name: "hologram-native-image", algo: "sha256+blake3", note: "Self-sealed native OS image (Law L5, dual-axis). Every byte re-derives to BOTH its sha256 κ and its blake3 σ-axis; the host refuses a mismatch on either, and refuses any unpinned byte in this sealed image (SEC-1/SEC-6).", files: Object.keys(sealed).length, closure: sealed };
writeFileSync(join(DIST, "os-closure.json"), JSON.stringify(manifest, null, 0));
console.log(`make-dist: sealed ${Object.keys(sealed).length} κ pins  (vs canonical OS: ${matched} match, ${drifted} drift = dev-in-flight)`);

// ── ANCHOR the worker (G1/SEC-1) ───────────────────────────────────────────────────────────────────
// Bake sha256(dist/os-closure.json) into the image's holo-fhs-sw.js CLOSURE_KAPPA so the native host's
// content-verify worker checks the pin set against an anchor a tamperer cannot forge — the SAME
// fail-closed root the web build gets from tools/holo-anchor-sw.mjs. MUST run after the seal above: the
// dist closure is now final, and the SW copied from the OS carried the *canonical* anchor, which would
// mismatch the *native* closure and fail-closed every boot. The worker is fetched by name (the bootstrap
// boundary) so it is in no closure — re-baking it drifts nothing.
const swPath = join(DIST, "holo-fhs-sw.js");
if (existsSync(swPath)) {
  const anchor = createHash("sha256").update(readFileSync(join(DIST, "os-closure.json"))).digest("hex");
  const sw = readFileSync(swPath, "utf8");
  if (/const CLOSURE_KAPPA = "[0-9a-f]{0,64}"/.test(sw)) {
    writeFileSync(swPath, sw.replace(/const CLOSURE_KAPPA = "[0-9a-f]{0,64}"/, `const CLOSURE_KAPPA = "${anchor}"`));
    console.log(`make-dist: anchored worker → CLOSURE_KAPPA ${anchor.slice(0, 12)}…  (G1/SEC-1, fail-closed)`);
  } else {
    console.warn("make-dist: WARNING — holo-fhs-sw.js has no CLOSURE_KAPPA constant; native image cannot anchor (G1/SEC-1).");
  }
}
console.log("make-dist: dist ready →", DIST);
