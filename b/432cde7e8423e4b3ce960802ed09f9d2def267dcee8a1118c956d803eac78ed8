// holo-animate-core.mjs — the ONE per-request animate core (HOLO-ANIMATE-SERVERLESS, SL-P1): everything
// that turns a fetched repo file-tree into a servable app tree, shared VERBATIM by BOTH hosts —
//   · the Node store daemon (holo-apps/apps/tauri/holo-animate-serve.mjs)
//   · the in-browser animator (holo-apps/apps/tauri/animate-web/animate-client.mjs, via /lib/)
// One codebase, two hosts: parity is DEFINED by the standing gates (holo-animate-conformance L1–L4 +
// holo-animate-fidelity F1–F5) running green against either origin, because both serve THIS logic.
//
// PURE + ISOMORPHIC (no Node globals, no DOM): bytes are Uint8Array (Node Buffers are Uint8Arrays),
// text via TextEncoder/TextDecoder. Every effect is INJECTED at the boundary (Law L4):
//   · the COMPILER (native esbuild in Node · κ-pinned esbuild-wasm in the tab — same API, same κ-transform)
//   · the VENDOR store + fetch (disk in Node · Cache-API in the tab), hash = blake3hex passed in
// The fit/fidelity engine (rewriteIndex) is the FID-P0/P1/P4 result — fit=contain faithful default,
// fill/actual opt-in, backdrop fills letterbox bars, mobile zoom-to-fit. Change it HERE only.

export const VERSION = "holo-animate-core/0.2.0";

import { b64encode, b64decode } from "./holo-dotholo.mjs";   // isomorphic base64 (Node Buffer · browser atob)

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
export const asText = (v) => v == null ? "" : (typeof v === "string" ? v : dec(v));
export const asBytes = (v) => typeof v === "string" ? enc(v) : v;

// ── tree .holo wire format: a built site is a multi-file TREE (Map<path,bytes>); its .holo result is the
//    JSON {path: base64} — ONE format packed/unpacked identically by the daemon and the tab (SS-P0). ──────
export const packTree = (files) => JSON.stringify(Object.fromEntries([...files].map(([k, v]) => [k, b64encode(asBytes(v))])));
export const unpackTree = (s) => new Map(Object.entries(JSON.parse(typeof s === "string" ? s : dec(s))).map(([k, v]) => [k, b64decode(v)]));

// ── MIME — engines (melonJS/Phaser/three) reject wrong content-types; audio/video/game-data included ──────
export const MIME = { html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", cur: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject", map: "application/json", wasm: "application/wasm", txt: "text/plain", xml: "application/xml", webmanifest: "application/manifest+json",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", weba: "audio/webm",
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", m4v: "video/mp4", mov: "video/quicktime",
  tmx: "application/xml", tsx: "application/xml", fnt: "application/xml", atlas: "text/plain", csv: "text/csv",
  glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "text/plain", mtl: "text/plain", glsl: "text/plain", vert: "text/plain", frag: "text/plain",
  bin: "application/octet-stream", dat: "application/octet-stream", mem: "application/octet-stream", data: "application/octet-stream", md: "text/markdown" };
export const mimeOf = (p) => MIME[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

// ── rewriteIndex(html, id, prefix) — <base> under <prefix>run/<id>/ + viewport + the FIDELITY-FIRST fit
// engine (FID-P0 contain+backdrop · FID-P1 pixel-art crisp · FID-P4 Fit/Fill/Actual · mobile zoom-to-fit).
// NON-DESTRUCTIVE: the app's canvas render/aspect/input mapping stay byte-identical.
// SUBPATH RELOCATION (SS-P3): a sealed .holo is PREFIX-NEUTRAL (its importmap says "/vendor/<κ>" by
// convention); the serving host passes its scope prefix ("/" for the daemon, the SW scope for a Pages
// subpath) and THIS rewrite adapts the doc at serve time — the κ never bakes in an origin layout.
export function rewriteIndex(html, id, prefix = "/") {
  html = html.replace(/((?:src|href)\s*=\s*["'])\/(?!\/)/gi, "$1");   // "/assets/x" → "assets/x" (strip FIRST)
  if (prefix !== "/") html = html.split('"/vendor/').join('"' + prefix + 'vendor/').split("'/vendor/").join("'" + prefix + "vendor/");   // importmap κ paths → scoped
  const hasVp = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html);
  const fill = '<script>(function(){function S(e,k,v){try{e.style.setProperty(k,v,"important")}catch(_){}}'
    + 'var bd,alive=true;'
    + 'function mfit(){try{if(mode!=="fit")return;var de=document.documentElement;de.style.removeProperty("zoom");var need=Math.max(de.scrollWidth,(document.body||de).scrollWidth||0),have=de.clientWidth||innerWidth;if(need>have+8){var z=have/need;if(z>0.3&&z<0.999)de.style.setProperty("zoom",z.toFixed(4),"important")}}catch(_){}}'
    + 'function lone(){var cs=[].filter.call(document.querySelectorAll("canvas"),function(x){return x.id!=="__holo_bd"});if(cs.length!==1)return null;if(((document.body||{}).innerText||"").trim().length>400)return null;return cs[0];}'
    + 'var mode="fit";'
    + 'function grad(){alive=false;if(!bd)return;S(bd,"filter","none");S(bd,"transform","none");S(bd,"background","radial-gradient(140% 140% at 50% 34%, #171b26 0%, #0b0e16 55%, #05070c 100%)");}'
    + 'function mk(c){bd=document.createElement("canvas");bd.id="__holo_bd";bd.width=96;bd.height=54;'
    + 'S(bd,"position","fixed");S(bd,"inset","0");S(bd,"z-index","-1");S(bd,"pointer-events","none");S(bd,"width","100vw");S(bd,"height","100vh");S(bd,"object-fit","cover");S(bd,"filter","blur(38px) saturate(1.35) brightness(.6)");S(bd,"transform","scale(1.25)");'
    + 'document.body.insertBefore(bd,document.body.firstChild);'
    + 'var bx=bd.getContext("2d"),lt=0,ok=false;var lp=function(t){if(!alive)return;if(t-lt>80){lt=t;try{bx.drawImage(c,0,0,bd.width,bd.height);if(!ok){var s=bx.getImageData(0,0,3,3).data,q=0;for(var i=0;i<s.length;i++)q+=s[i];if(q>18)ok=true;}}catch(_){}}requestAnimationFrame(lp)};requestAnimationFrame(lp);'
    + 'setTimeout(function(){if(!ok)grad();},800);}'   // engine frame unreadable (offscreen/webgl) → clean gradient
    + 'function run(){try{var c=lone();if(!c)return;if(!bd||!bd.parentNode)mk(c);'
    + 'S(document.documentElement,"background-color","transparent");S(document.body,"background-color","transparent");'
    + 'var p=c.parentElement;while(p&&p!==document.body&&p!==document.documentElement){S(p,"background-color","transparent");p=p.parentElement;}'
    + 'var iw=c.width||c.getBoundingClientRect().width||1,ih=c.height||c.getBoundingClientRect().height||1,vw=innerWidth,vh=innerHeight;'
    + 'var s=mode==="fill"?Math.max(vw/iw,vh/ih):(mode==="actual"?1:Math.min(vw/iw,vh/ih));'
    + 'var dw=Math.round(iw*s),dh=Math.round(ih*s);'
    + 'S(c,"position","fixed");S(c,"left","50%");S(c,"top","50%");S(c,"transform","translate(-50%,-50%)");S(c,"width",dw+"px");S(c,"height",dh+"px");S(c,"max-width","none");S(c,"max-height","none");S(c,"margin","0");S(c,"z-index","1");'
    + 'if(s>1.05&&Math.max(iw,ih)<=512)S(c,"image-rendering","pixelated");else c.style.removeProperty("image-rendering");'
    + 'if(mode==="fill")S(document.documentElement,"overflow","hidden");else document.documentElement.style.removeProperty("overflow");'
    + '}catch(_){}}'
    + 'function announce(){try{parent.postMessage({holoFit:{canvasApp:!!lone()}},"*")}catch(_){}}'
    + 'addEventListener("message",function(e){if(e&&e.data&&e.data.holoMode){mode=e.data.holoMode;run()}});'
    + 'function b(){run();mfit();announce();setTimeout(function(){run();mfit();announce()},300);setTimeout(function(){run();mfit()},1200)}if(document.readyState!=="loading")b();else addEventListener("DOMContentLoaded",b);addEventListener("load",b);addEventListener("resize",function(){run();mfit()})})();<\/script>';
  const inject = '<base href="' + prefix + 'run/' + id + '/">'
    + (hasVp ? '' : '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">')
    + '<style>html,body{margin:0;min-height:100%}</style>' + fill;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + "\n" + inject) : inject + html;
}

// ── module resolution shared by findEntry + buildSPA ──────────────────────────────────────────────────────
export const TRY = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", ".css", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
export const clean = (p) => String(p).replace(/^\.?\//, "").split(/[?#]/)[0];
export const dirOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
export const joinRel = (d, s) => { const parts = (d ? d.split("/") : []).concat(clean(s).split("/")); const o = []; for (const x of parts) { if (x === "" || x === ".") continue; if (x === "..") o.pop(); else o.push(x); } return o.join("/"); };
// .js/.mjs/.cjs → the `jsx` loader (a superset that also parses plain JS): many React repos put JSX in .js.
export const loaderOf = (p) => ({ js: "jsx", mjs: "jsx", cjs: "jsx", jsx: "jsx", ts: "ts", tsx: "tsx", json: "json", css: "css", svg: "dataurl", png: "dataurl", jpg: "dataurl", jpeg: "dataurl", gif: "dataurl", webp: "dataurl", woff: "dataurl", woff2: "dataurl", ttf: "dataurl" }[(p.split(".").pop() || "").toLowerCase()] || "text");
export const PEERS = ["react", "react-dom", "vue", "preact", "solid-js", "@vue/runtime-dom"];

export function findEntry(files) {
  const idx = ["index.html", "public/index.html", "src/index.html"].find((p) => files.has(p));
  let html = idx ? asText(files.get(idx)) : null;
  if (html) { const m = html.match(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["']/i) || html.match(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.[jt]sx?)["']/i); if (m && !/^(?:[a-z]+:)?\/\//i.test(m[1])) { const c = clean(m[1]); for (const e of TRY) if (files.has(c + e)) return { entry: c + e, html, idx }; } }
  let pkg = null; try { pkg = JSON.parse(asText(files.get("package.json"))); } catch {}
  const guesses = [pkg && pkg.module, pkg && pkg.main, "src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js", "src/index.tsx", "src/index.jsx", "src/index.js"].filter(Boolean).map(clean);
  for (const g of guesses) for (const e of TRY) if (files.has(g + e)) return { entry: g + e, html, idx };
  return { entry: null, html, idx };
}

// ── κ-vendoring (SR-P0): fetch a runtime graph ONCE at build time, follow esm.sh's thin re-export shims
//    TRANSITIVELY, rewrite each import to /vendor/<κ>, address every module by hash. The store/index/fetch
//    are injected; the graph walk + rewrite are identical in Node and the tab. ───────────────────────────
export function makeVendor({ fetchText, store, exists, hash, index }) {
  async function vendorGraph(full, seen) {
    if (seen.has(full)) return seen.get(full);
    seen.set(full, "PENDING");                                  // cycle guard
    let src = await fetchText(full);
    const origin = new URL(full).origin;
    const specs = new Set();
    for (const m of src.matchAll(/(?:from|import|export)\s*(?:\(\s*)?["']([^"']+)["']/g)) { const s = m[1]; if (s.startsWith("/") || s.includes("esm.sh")) specs.add(s); }
    for (const s of specs) {
      const childUrl = s.startsWith("http") ? s : origin + s;
      const childK = await vendorGraph(childUrl, seen);
      // SIBLING-relative rewrite ("./<κ>"): a vendor module at <scope>vendor/<a> imports <scope>vendor/<b>
      // with NO prefix knowledge — the κ-addressed bytes work at any origin layout (root, Pages subpath).
      src = src.split('"' + s + '"').join('"./' + childK + '"').split("'" + s + "'").join("'./" + childK + "'");
    }
    const hex = hash(enc(src));
    await store(hex, src);
    seen.set(full, hex);
    return hex;
  }
  return async function vendorKappa(esmUrl) {   // esm.sh url → { kappa(hex), reused } — fully vendored (transitive)
    const known = await index.get(esmUrl);
    if (known && (await exists(known))) return { kappa: known, reused: true };
    const hex = await vendorGraph(esmUrl, new Map());
    await index.set(esmUrl, hex);
    return { kappa: hex, reused: false };
  };
}

// ── buildSPA — compile the ORIGINAL source with the injected esbuild (native or κ-pinned wasm), bare deps
//    → κ-vendored importmap (honest esm.sh fallback if vendoring fails). Same κ-transform on both hosts. ──
export async function buildSPA(files, { esbuild, vendorKappa, onStatus = () => {} }) {
  const { entry, html, idx } = findEntry(files);
  if (!entry) throw new Error("no SPA entry found (index.html module script / src/main.*)");
  onStatus("compiling " + entry);
  const bare = new Set();
  const plugin = { name: "holo", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === "entry-point") return { path: clean(a.path), namespace: "v" };
      const s = a.path;
      if (/^(?:[a-z]+:)?\/\//i.test(s) || s.startsWith("data:")) return { external: true };
      if (s.startsWith(".") || s.startsWith("/")) { const base = joinRel(dirOf(a.importer === "<stdin>" ? entry : a.importer), s); for (const e of TRY) if (files.has(base + e)) return { path: base + e, namespace: "v" }; return { external: true }; }
      bare.add(s); return { path: s, external: true };   // npm dep → external → importmap → κ-vendor
    });
    b.onLoad({ filter: /.*/, namespace: "v" }, (a) => { const f = files.get(a.path); return { contents: asText(f), loader: loaderOf(a.path), resolveDir: dirOf(a.path) }; });
  } };
  const res = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, outdir: "dist", format: "esm", jsx: "automatic", target: "es2020", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"', "import.meta.env.PROD": "true", "import.meta.env.DEV": "false", "import.meta.env.BASE_URL": '"/"', "import.meta.env.SSR": "false", "import.meta.env": "{}" },
    plugins: [plugin] });
  let js = "", css = ""; for (const o of res.outputFiles) { if (o.path.endsWith(".css")) css += o.text; else js += o.text; }
  const peers = PEERS.filter((p) => bare.has(p));
  const imports = {}; let vNovel = 0, vReused = 0;
  for (const s of bare) {
    let u = "https://esm.sh/" + s + "?bundle"; const ext = peers.filter((p) => p !== s); if (ext.length && !peers.includes(s)) u += "&external=" + ext.join(",");
    onStatus("κ-vendoring " + s);
    try { const v = await vendorKappa(u); imports[s] = "/vendor/" + v.kappa; if (v.reused) vReused++; else vNovel++; }   // κ-served vendor, verified — NOT esm.sh at runtime
    catch { imports[s] = "https://esm.sh/" + s; }   // honest fallback if κ-vendoring fails
  }
  const importmap = Object.keys(imports).length ? '<script type="importmap">' + JSON.stringify({ imports }) + "</script>\n" : "";
  // assemble the runnable HTML: keep the repo's index body/mount, inject importmap + css + our module bundle
  let body = "<div id=\"root\"></div><div id=\"app\"></div>";
  if (html) {
    const bm = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bm) {
      // strip ONLY the scripts we replace: module scripts (bundled) + the entry's own <script src=ENTRY>.
      // KEEP the app's other global <script src> (jQuery, engine libs) — they load from the tree.
      const eb = String(entry).split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const entryRe = new RegExp('<script\\b[^>]*\\bsrc\\s*=\\s*["\'][^"\']*' + eb + '["\'][^>]*>\\s*<\\/script>', "gi");
      body = bm[1]
        .replace(/<script\b[^>]*\btype\s*=\s*["']module["'][\s\S]*?<\/script>/gi, "")   // module (bundled)
        .replace(entryRe, "");                                                          // the entry itself (bundled)
    }
  }
  const doc = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
    + importmap + (css ? "<style>\n" + css + "\n</style>\n" : "") + "</head><body>\n" + body + "\n<script type=\"module\">\n" + js + "\n</script></body></html>";
  return { html: doc, deps: [...bare], entry, idx, vendor: { novel: vNovel, reused: vReused, kappas: Object.values(imports).filter((u) => u.startsWith("/vendor/")).map((u) => u.slice(8)) } };
}

// ── tree assembly (the R0 / classic / R1 shapes — the serving-law-critical logic) ─────────────────────────
const TREE_SKIP = /(^|\/)(node_modules|\.git)\//;

// R0: the WHOLE repo as a binary-safe file tree rebased to the entry's dir (runtime-loaded sprites/audio/
// tilemaps resolve at /run/<id>/<path>; an inlined single doc broke every runtime asset — the blank-canvas bug).
export function assembleR0Tree(files, entry) {
  const entryDir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
  const tree = new Map();
  for (const [fp, v] of files) { let tk = fp; if (entryDir) { if (!fp.startsWith(entryDir)) continue; tk = fp.slice(entryDir.length); } tree.set(tk, asBytes(v)); }
  if (!tree.has("index.html")) { const b = entry.split("/").pop(); if (tree.has(b)) tree.set("index.html", tree.get(b)); }   // entry in a subdir → surface it at the tree root
  return tree;
}

// FAITHFUL-AS-IS: a repo whose index has only classic <script src=".js"> (no module/TS/JSX entry) must be
// served AS-IS as a tree — module-bundling a global-script app scopes away its globals ("Foo is not defined").
export function classicIndexPath(files) {
  const idxPath = ["index.html", "public/index.html", "src/index.html", "docs/index.html"].find((p) => files.has(p));
  if (!idxPath) return null;
  const idxHtml = asText(files.get(idxPath));
  const hasModule = /<script[^>]*\btype\s*=\s*["']module["']/i.test(idxHtml);
  const localSrcs = [...idxHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).filter((s) => !/^(?:[a-z]+:)?\/\//i.test(s));
  const classic = !hasModule && localSrcs.length > 0 && localSrcs.every((s) => /\.(?:js|mjs|cjs)(?:[?#]|$)/i.test(s));
  return classic ? idxPath : null;
}
export function assembleClassicTree(files, idxPath) {
  const entryDir = idxPath.includes("/") ? idxPath.slice(0, idxPath.lastIndexOf("/") + 1) : "";
  const tree = new Map();
  for (const [fp, v] of files) { if (TREE_SKIP.test(fp)) continue; let tk = fp; if (entryDir) { if (!fp.startsWith(entryDir)) continue; tk = fp.slice(entryDir.length); } tree.set(tk, asBytes(v)); }
  if (!tree.has("index.html")) { const b = idxPath.split("/").pop(); if (tree.has(b)) tree.set("index.html", tree.get(b)); }
  return tree;
}

// R1: the bundled index at the tree root PLUS the repo's static assets (images/audio/fonts/json the app
// loads at runtime by path — the JS bundle does NOT inline those), rebased to the index's dir.
export function assembleR1Tree(files, built) {
  const idxDir = built.idx && built.idx.includes("/") ? built.idx.slice(0, built.idx.lastIndexOf("/") + 1) : "";
  const tree = new Map();
  for (const [fp, v] of files) { if (TREE_SKIP.test(fp)) continue; let tk = fp; if (idxDir) { if (!fp.startsWith(idxDir)) continue; tk = fp.slice(idxDir.length); } tree.set(tk, asBytes(v)); }
  tree.set("index.html", enc(built.html));   // the bundled doc overrides the repo's raw index
  return tree;
}

export function describeAnimateCore() {
  return { is: "the shared per-request animate core — MIME, fidelity rewriteIndex, entry resolution, buildSPA (esbuild injected), κ-vendor graph, R0/classic/R1 tree assembly",
    hosts: "the Node store daemon AND the in-browser service-worker animator consume this file verbatim",
    parity: "the conformance (L1–L4) + fidelity (F1–F5) gates define parity: both origins serve this one logic" };
}

export default { VERSION, MIME, mimeOf, rewriteIndex, findEntry, makeVendor, buildSPA, assembleR0Tree, classicIndexPath, assembleClassicTree, assembleR1Tree, TRY, clean, dirOf, joinRel, loaderOf, PEERS, asText, asBytes, describeAnimateCore };
