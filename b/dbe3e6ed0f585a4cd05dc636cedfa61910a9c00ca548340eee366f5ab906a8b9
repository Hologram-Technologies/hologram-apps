// animate-client.mjs — the ANIMATOR, IN THE BROWSER (HOLO-ANIMATE-SERVERLESS, SL-P0/P1). Everything the
// local Node daemon (holo-animate-serve.mjs) did per repo now happens in the page — and since SL-P1 the
// per-request logic (MIME, fidelity rewriteIndex, entry resolution, buildSPA, κ-vendor graph, tree assembly)
// is the ONE SHARED CORE at /lib/holo-animate-core.mjs, consumed VERBATIM by both hosts. This file only owns
// what is genuinely browser-side: the CORS fetch ladder, the Cache-API κ-store, and the κ-pinned esbuild-wasm
// loading (verified against ESBUILD_PIN before it may build — L5 on the compiler).
//
// FETCH LADDER (empirical, from a real page origin — SL-P0a, witnessed):
//   codeload tarball        → BLOCKED (ACAO locked to render.githubusercontent.com, incl. via the
//                             api.github.com/…/tarball redirect — the browser checks the FINAL response)
//   data.jsdelivr.com list  → OPEN (ACAO *) — the file listing, no GitHub rate limit
//   cdn.jsdelivr.net files  → OPEN (ACAO *) — per-file, CDN-cached planet-wide
//   raw.githubusercontent   → OPEN (ACAO *) — per-file fallback
//   api.github.com trees    → OPEN (ACAO *) — listing fallback (60/hr unauth — last resort)
// NOTE (SL-P2): the κ-registry becomes the PRIMARY rung — anyone who animated repo@commit before you means
// zero GitHub traffic at all. GitHub is only for first-animation of a novel repo.

import { parseRepoRef } from "./lib/holo-import.mjs";
import { detectProvider } from "./lib/holo-providers.mjs";
import { blake3hex } from "./lib/holo-blake3.mjs";
import { loadBrowserEsbuild } from "./lib/holo-forge-esbuild.mjs";
import { sealHolo, openHolo, packHolo, unpackHolo } from "./lib/holo-dotholo.mjs";
import { mimeOf, rewriteIndex, makeVendor, buildSPA as coreBuildSPA, assembleR0Tree, classicIndexPath, assembleClassicTree, assembleR1Tree, asText, packTree, unpackTree } from "./lib/holo-animate-core.mjs";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
export const RUN_CACHE = "holo-run-v1";
// SUBPATH RELOCATION (SS-P3): everything keys off the page's directory (== the SW scope), NOT the origin
// root — so the same bundle serves at "/" locally and at "/<repo>/" on a Pages origin, unchanged.
const SCOPE_URL = new URL("./", location.href);            // e.g. https://x.github.io/animate/
const SCOPE = SCOPE_URL.pathname;                          // e.g. /animate/
const scoped = (p) => new URL(p, SCOPE_URL).href;          // "run/<id>/x" → absolute under the scope

// ── SL-P0a: the empirical ladder probe — run each rung FROM THIS ORIGIN and report what the browser lets
//    through. This is the witnessed answer to "can a page fetch GitHub without our server?" ───────────────
export async function probeLadder(slug = "mdn/todo-react", ref = "main") {
  const out = {};
  const attempt = async (name, fn) => { try { const r = await fn(); out[name] = { ok: true, note: r }; } catch (e) { out[name] = { ok: false, note: String(e && e.message || e).slice(0, 120) }; } };
  await attempt("codeload-tarball", async () => { const r = await fetch(`https://codeload.github.com/${slug}/tar.gz/${ref}`); return "HTTP " + r.status + " " + (await r.blob()).size + "B"; });
  await attempt("api-tarball-redirect", async () => { const r = await fetch(`https://api.github.com/repos/${slug}/tarball/${ref}`); return "HTTP " + r.status + " " + (await r.blob()).size + "B"; });
  await attempt("jsdelivr-list", async () => { const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${slug}@${ref}`); if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); return (j.files || []).length + " top-level entries"; });
  await attempt("jsdelivr-file", async () => { const r = await fetch(`https://cdn.jsdelivr.net/gh/${slug}@${ref}/package.json`); if (!r.ok) throw new Error("HTTP " + r.status); return (await r.text()).length + " chars"; });
  await attempt("raw-file", async () => { const r = await fetch(`https://raw.githubusercontent.com/${slug}/${ref}/package.json`); if (!r.ok) throw new Error("HTTP " + r.status); return (await r.text()).length + " chars"; });
  await attempt("api-trees", async () => { const r = await fetch(`https://api.github.com/repos/${slug}/git/trees/${ref}?recursive=1`); if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); return (j.tree || []).length + " entries"; });
  await attempt("esm-sh", async () => { const r = await fetch("https://esm.sh/react?bundle"); if (!r.ok) throw new Error("HTTP " + r.status); return (await r.text()).length + " chars"; });
  return out;
}

// ── repo fetch over the working rungs: jsdelivr list → parallel per-file (jsdelivr, raw fallback) ─────────
const SKIP_RE = /(^|\/)(node_modules|\.git|\.github)\//;
const TEXT_EXT = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "html", "htm", "css", "md", "txt", "yml", "yaml", "toml", "xml", "svg", "lock", "cfg", "ini", "py", "rb", "go", "rs", "php", "java", "sh", "vue", "svelte", "astro", "env", "csv", "map", "webmanifest", "gitignore", "npmrc", "nvmrc", "editorconfig", "csproj", "sln", "gradle", "kts", "procfile"]);
const looksText = (p, size) => { const base = p.split("/").pop(); const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : ""; return ext ? TEXT_EXT.has(ext) : size <= 512 * 1024; };

function flattenJsdelivr(entries, prefix = "") {
  const out = [];
  for (const e of entries || []) {
    if (e.type === "file") out.push({ path: prefix + e.name, size: e.size || 0 });
    else if (e.type === "directory") out.push(...flattenJsdelivr(e.files, prefix + e.name + "/"));
  }
  return out;
}

async function listRepo(slug, ref) {
  // rung 1: jsdelivr's data API (no GitHub rate limit)
  try {
    const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${slug}@${ref}`);
    if (r.ok) { const j = await r.json(); const files = flattenJsdelivr(j.files); if (files.length) return { files, via: "jsdelivr" }; }
  } catch {}
  // rung 2: GitHub trees API (rate-limited — last resort)
  const r = await fetch(`https://api.github.com/repos/${slug}/git/trees/${ref}?recursive=1`, { headers: { accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error("could not list " + slug + "@" + ref + " (jsdelivr + api both failed, HTTP " + r.status + ")");
  const j = await r.json();
  return { files: (j.tree || []).filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size || 0 })), via: "api-trees" };
}

async function fetchFile(slug, ref, p) {
  for (const url of [`https://cdn.jsdelivr.net/gh/${slug}@${ref}/${p}`, `https://raw.githubusercontent.com/${slug}/${ref}/${p}`]) {
    try { const r = await fetch(url); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch {}
  }
  throw new Error("fetch failed: " + p);
}

const MAX_FILES = 1200, MAX_FILE_BYTES = 12 * 1024 * 1024;
export async function fetchRepo(slug, ref, onStatus = () => {}) {
  let listing = null, used = ref;
  for (const r of [ref, ref === "main" ? "master" : "main"]) {
    try { listing = await listRepo(slug, r); used = r; break; } catch {}
  }
  if (!listing) throw new Error("could not fetch " + slug + " (tried " + ref + ")");
  let entries = listing.files.filter((f) => !SKIP_RE.test(f.path));
  const skippedBig = entries.filter((f) => f.size > MAX_FILE_BYTES).map((f) => f.path);
  entries = entries.filter((f) => f.size <= MAX_FILE_BYTES);
  if (entries.length > MAX_FILES) throw new Error("repo too large for the in-tab spike: " + entries.length + " files (cap " + MAX_FILES + ") — named honestly, not truncated");
  onStatus("fetching " + entries.length + " files via " + listing.via + (skippedBig.length ? " (skipped " + skippedBig.length + " >12MB)" : ""));
  const files = new Map();
  let done = 0;
  const queue = entries.slice();
  const workers = Array.from({ length: 24 }, async () => {
    for (;;) { const e = queue.shift(); if (!e) return;
      files.set(e.path, await fetchFile(slug, used, e.path));
      if (++done % 25 === 0) onStatus("fetched " + done + "/" + entries.length);
    }
  });
  await Promise.all(workers);
  return { files, commit: used, via: listing.via, skippedBig };
}

// ── provider detection over the fetched bytes: the canonical registry wants text values for the files it
//    inspects — decode texty files, mark the rest {text:null} (keys still count for path detection). ──────
export function detectFromBytes(files) {
  const dmap = new Map();
  for (const [p, bytes] of files) dmap.set(p, looksText(p, bytes.length) ? { text: dec(bytes) } : { text: null });
  let pkg = null; try { pkg = JSON.parse(dec(files.get("package.json") || new Uint8Array())); } catch {}
  return { det: detectProvider(dmap, pkg), pkg };
}

// ── the Cache-API κ-store the SW serves from: /run/<id>/<path> + /vendor/<κ> ──────────────────────────────
async function storeTree(id, tree) {
  const cache = await caches.open(RUN_CACHE);
  for (const [p, v] of tree) {
    const bytes = typeof v === "string" ? enc(v) : v;
    const body = p === "index.html" ? enc(rewriteIndex(dec(bytes), id, SCOPE)) : bytes;   // prefix-neutral .holo → scoped doc at serve time
    await cache.put(scoped("run/" + id + "/" + p), new Response(body, { headers: { "content-type": mimeOf(p) } }));
  }
}
async function storeVendor(hex, text) {
  const cache = await caches.open(RUN_CACHE);
  await cache.put(scoped("vendor/" + hex), new Response(enc(text), { headers: { "content-type": "text/javascript" } }));
}

// ── R1: esbuild-wasm, κ-VERIFIED before it may build (holo-forge-esbuild's pin gate = L5 on the compiler) ──
let _esbuild = null;
export async function loadEsbuild(onStatus = () => {}) {
  if (_esbuild) return _esbuild;
  onStatus("fetching κ-pinned esbuild-wasm toolchain");
  const [js, wasm] = await Promise.all([
    fetch("/vendor-toolchain/browser.min.js").then((r) => { if (!r.ok) throw new Error("toolchain js HTTP " + r.status); return r.arrayBuffer(); }),
    fetch("/vendor-toolchain/esbuild.wasm").then((r) => { if (!r.ok) throw new Error("toolchain wasm HTTP " + r.status); return r.arrayBuffer(); }),
  ]);
  onStatus("verifying toolchain against ESBUILD_PIN (L5)");
  _esbuild = await loadBrowserEsbuild({
    toolchainBytes: { "browser.min.js": new Uint8Array(js), "esbuild.wasm": new Uint8Array(wasm) },
    loadScript: (jsBytes) => new Promise((res, rej) => {
      const url = URL.createObjectURL(new Blob([jsBytes], { type: "text/javascript" }));
      const s = document.createElement("script"); s.src = url;
      s.onload = () => res(globalThis.esbuild); s.onerror = () => rej(new Error("esbuild-wasm script failed to load"));
      document.head.appendChild(s);
    }),
    initialize: async (api, wasmBytes) => { await api.initialize({ wasmModule: await WebAssembly.compile(wasmBytes.buffer ? wasmBytes : new Uint8Array(wasmBytes)) }); },
  });
  return _esbuild;
}

// ── κ-vendoring: the graph walk + rewrite are the CORE's (makeVendor); this host injects Cache-API
//    boundaries (the daemon injects disk). Same κs out on both hosts. ─────────────────────────────────────
const vendorIndexKey = "holo-vendor-index-v1";
const vendorIndex = (() => { try { return JSON.parse(localStorage.getItem(vendorIndexKey) || "{}"); } catch { return {}; } })();
const vendorKappa = makeVendor({
  fetchText: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error("vendor fetch HTTP " + r.status + " " + url); return r.text(); },
  store: storeVendor,
  exists: async (hex) => !!(await (await caches.open(RUN_CACHE)).match(scoped("vendor/" + hex))),
  hash: blake3hex,
  index: { get: async (u) => vendorIndex[u], set: async (u, hex) => { vendorIndex[u] = hex; try { localStorage.setItem(vendorIndexKey, JSON.stringify(vendorIndex)); } catch {} } },
});

// ── the OPFS warm tier (SS-P0): a sealed .holo per slug@ref — the browser's κ-cache. Warm reopen = open the
//    .holo from OPFS, VERIFY (L5), unpack, serve — zero network. Same key discipline as the daemon's disk cache.
const holoKey = (slug, ref) => (slug + "@" + ref).replace(/[^\w.@-]/g, "_");
async function opfsDir() { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle("holo-store", { create: true }); }
async function opfsLoad(key) { try { const dir = await opfsDir(); const fh = await dir.getFileHandle(key + ".holo"); return await (await fh.getFile()).text(); } catch { return null; } }
async function opfsSave(key, packed) { try { const dir = await opfsDir(); const fh = await dir.getFileHandle(key + ".holo", { create: true }); const w = await fh.createWritable(); await w.write(packed); await w.close(); } catch {} }
async function opfsDelete(key) { try { const dir = await opfsDir(); await dir.removeEntry(key + ".holo"); } catch {} }

// unpack + VERIFY a packed tree .holo (L5 before render — manifest→κ, bytes→resultκ, else refused)
function openSealedTree(packed) {
  let u; try { u = unpackHolo(packed); } catch (e) { return { ok: false, error: "unreadable .holo: " + e.message }; }
  const o = openHolo({ kappa: u.kappa, manifest: u.manifest, result: u.result });
  if (!o.ok) return { ok: false, error: o.error, kappa: u.kappa };
  if (u.manifest["holo:contentType"] !== "application/holo-tree") return { ok: false, error: "not a tree .holo (" + u.manifest["holo:contentType"] + ")", kappa: u.kappa };
  let tree; try { tree = unpackTree(o.html); } catch (e) { return { ok: false, error: "tree unpack failed: " + e.message, kappa: u.kappa }; }
  return { ok: true, kappa: u.kappa, manifest: u.manifest, tree };
}

// ── the static κ-REGISTRY rung (SS-P1): pre-sealed .holos shipped as files beside this page — built once
//    per planet, streamed + verified. Relative fetches so the origin can live under a subpath. ────────────
let _registryIndex;
export async function registryIndex() {
  if (_registryIndex !== undefined) return _registryIndex;
  try { const r = await fetch("registry/index.json", { cache: "no-cache" }); _registryIndex = r.ok ? await r.json() : null; } catch { _registryIndex = null; }
  return _registryIndex;
}
async function registryLoad(slugRef, onStatus) {
  const idx = await registryIndex();
  const e = idx && idx.apps && idx.apps[slugRef];
  if (!e) return null;
  try {
    onStatus("streaming from the κ-registry (built once per planet)");
    const r = await fetch("registry/" + e.file); if (!r.ok) return null;
    const packed = await r.text();
    // seed the app's κ-vendored runtime modules (importmap points at <scope>vendor/<κ>) — verify before caching
    for (const hex of e.vendors || []) {
      const cache = await caches.open(RUN_CACHE);
      if (await cache.match(scoped("vendor/" + hex))) continue;
      const vr = await fetch("registry/vendor/" + hex + ".js"); if (!vr.ok) continue;
      const bytes = new Uint8Array(await vr.arrayBuffer());
      if (blake3hex(bytes) !== hex) { onStatus("registry vendor κ mismatch — refused " + hex.slice(0, 8)); continue; }   // L5
      await cache.put(scoped("vendor/" + hex), new Response(bytes, { headers: { "content-type": "text/javascript" } }));
    }
    return { packed, expectKappa: e.kappa };
  } catch { return null; }
}

// ── animate — the SAME rungs as the daemon (R0 tree · classic→R0 · R1 esbuild), all in-tab, all via core.
//    Open ladder: OPFS .holo → static κ-registry → live animate (GitHub only for a NOVEL repo). ───────────
let seq = 0;
async function realize(id, tree, rung, meta) { await storeTree(id, tree); return { rung, id, meta: { ...meta, treeFiles: tree.size, paths: [...tree.keys()] } }; }

export async function animate(input, onStatus = () => {}, { noCache = false } = {}) {
  const ref = parseRepoRef(input); if (!ref) throw new Error("not a GitHub URL: " + input);
  const slug = ref.owner + "/" + ref.repo, gitref = ref.ref || "main", key = holoKey(slug, gitref);
  const id = "r" + (++seq) + Date.now().toString(36);

  // 1) OPFS warm tier — verify before render; tampered → discard (self-heal online, REFUSE offline).
  //    noCache skips the read rungs (fresh animate — the seal still writes, so the next open is warm).
  const cached = noCache ? null : await opfsLoad(key);
  if (cached) {
    const o = openSealedTree(cached);
    if (o.ok) { onStatus("⚡ streamed from OPFS (0 net), verified κ:" + o.kappa.slice(-8)); return realize(id, o.tree, o.manifest["holo:tier"], { repo: slug, provider: o.manifest["holo:provider"], tier: o.manifest["holo:tier"], fetchMs: 0, buildMs: 0, cached: true, source: "opfs", kappa: o.kappa }); }
    await opfsDelete(key);
    if (!navigator.onLine) throw new Error("cached .holo failed verification (" + o.error + ") — offline, refusing to render (L5)");
    onStatus("cached .holo failed verify (" + o.error + ") — discarded, re-animating live");
  }

  // 2) the static κ-registry — someone (the build) animated this for the planet already
  const reg = noCache ? null : await registryLoad(slug + "@" + gitref, onStatus);
  if (reg) {
    const o = openSealedTree(reg.packed);
    if (o.ok && (!reg.expectKappa || reg.expectKappa === o.kappa)) {
      await opfsSave(key, reg.packed);   // next open = OPFS, offline-capable
      return realize(id, o.tree, o.manifest["holo:tier"], { repo: slug, provider: o.manifest["holo:provider"], tier: o.manifest["holo:tier"], fetchMs: 0, buildMs: 0, cached: true, source: "registry", kappa: o.kappa });
    }
    onStatus("registry .holo REFUSED (" + (o.ok ? "κ != index (" + reg.expectKappa + ")" : o.error) + ") — falling to live animate");   // L5: never render refused bytes
  }

  // 3) live animate (first animation of a novel repo)
  const t0 = performance.now();
  onStatus("fetching " + slug);
  const { files, commit, via } = await fetchRepo(slug, gitref, onStatus);
  const fetchMs = Math.round(performance.now() - t0);
  const { det } = detectFromBytes(files);
  onStatus("provider: " + det.provider + " → " + det.tier);
  const base = { repo: slug, commit, via, provider: det.provider, tier: det.tier, fetchMs, files: files.size, source: "live" };
  const sealSave = async (tree, provider, tier) => {   // seal + OPFS = build once, reopen offline
    const sealed = sealHolo({ repo: "https://github.com/" + slug, commit, provider, tier, result: packTree(tree), name: ref.repo, contentType: "application/holo-tree" });
    await opfsSave(key, packHolo(sealed));
    return sealed.kappa;
  };

  if (det.tier === "R0") {
    const tree = assembleR0Tree(files, det.recipe.entry || "index.html");
    const kappa = await sealSave(tree, det.provider, "R0");
    return realize(id, tree, "R0", { ...base, buildMs: 0, kappa });
  }

  if (det.tier === "R1" && det.provider === "node-spa") {
    const idxPath = classicIndexPath(files);   // FAITHFUL-AS-IS: classic global-script index → tree, not bundle
    if (idxPath) {
      const tree = assembleClassicTree(files, idxPath);
      const kappa = await sealSave(tree, "static", "R0");
      return realize(id, tree, "R0", { ...base, provider: "static", tier: "R0", buildMs: 0, kappa });
    }
    const b0 = performance.now();
    const esbuild = await loadEsbuild(onStatus);
    const built = await coreBuildSPA(files, { esbuild, vendorKappa, onStatus });
    const tree = assembleR1Tree(files, built);
    const kappa = await sealSave(tree, det.provider, "R1");
    return realize(id, tree, "R1", { ...base, buildMs: Math.round(performance.now() - b0), deps: built.deps, entry: built.entry, vendor: built.vendor, kappa });
  }

  if (det.tier === "R3") throw new Error("R3 (" + det.provider + ") — a server app: in-tab VM (SL-P4) or a Hologram host (SL-P5); named honestly, not faked");
  throw new Error("could not classify a runnable app (" + det.provider + ") — " + (det.recipe.reason || "no app entry"));
}

// witness/debug hooks: OPFS tamper + wipe (drive the L5 refusal path deterministically)
export async function _opfsTamper(slug, ref = "main") { const key = holoKey(slug, ref); const packed = await opfsLoad(key); if (!packed) return false; const j = JSON.parse(packed); j.result_b64 = b64tamper(j.result_b64); await opfsSave(key, JSON.stringify(j)); return true; }
const b64tamper = (b64) => (b64.slice(0, 10) + (b64[10] === "A" ? "B" : "A") + b64.slice(11));
export async function _opfsWipe() { try { const root = await navigator.storage.getDirectory(); await root.removeEntry("holo-store", { recursive: true }); } catch {} }

export { mimeOf, rewriteIndex, asText };   // re-exported for the page/witness (single source: the core)
