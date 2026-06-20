// forge-sw.js — the Service Worker that makes Holo Forge 100% serverless. It mirrors the canonical
// substrate resolver (os/sbin/holo-resolver.mjs): every asset is fetched BY ITS κ, re-derived
// (Law L5), and cached in the persistent κ-store (IndexedDB) so the ORIGIN BECOMES OPTIONAL. Once
// primed, the app loads, compiles and verifies with the server dead and the network off — content
// is served by what it IS, from wherever it is. Classic worker (no ESM) so it runs on every
// browser, desktop and mobile. Scope: /apps/forge/.

const DB = "holo-kstore", STORE = "kappa", SCOPE = "/apps/forge/";
const hexOf = (k) => String(k).split(":").pop();
const TE = new TextEncoder(), TD = new TextDecoder();
const MIME = { html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  json: "application/json", svg: "image/svg+xml", wasm: "application/wasm", txt: "text/plain", hc: "text/plain" };
const mimeOf = (p) => MIME[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

let CLOSURE = null;                 // serve-path → κ
let sealed = false;                 // origin-free mode (the "kill the server" switch)
const stats = { fromStore: 0, fromOrigin: 0, reDerived: 0, refused: 0, primed: 0, total: 0 };

// ── κ-store (IndexedDB) — shared with the page's holo-kstore.mjs (same DB) ──
let _db = null;
const db = () => _db || (_db = new Promise((res, rej) => { const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function kget(k) { const d = await db(); return reqP(d.transaction(STORE, "readonly").objectStore(STORE).get(hexOf(k))); }
async function kput(k, u) { const d = await db(); const t = d.transaction(STORE, "readwrite"); t.objectStore(STORE).put(u, hexOf(k)); return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); }); }

async function reDerive(bytes) { const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = await crypto.subtle.digest("SHA-256", u); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

const broadcast = async (extra = {}) => { const cs = await self.clients.matchAll({ includeUncontrolled: true });
  cs.forEach((c) => c.postMessage({ type: "holo-forge-sw", sealed, stats, ...extra })); };

// build serve-path → κ from the app closure (build-app keys: apps/forge/* and _shared/*)
function buildClosure(lock) {
  const map = {};
  for (const [key, meta] of Object.entries(lock.closure || {})) map[key.startsWith("apps/") ? "/" + key : SCOPE + key] = meta.kappa;
  return map;                       // navigation (/apps/forge/) is mapped to index.html in the fetch handler
}

// prime: fetch the lock + every closure asset once (origin alive), re-derive, store by κ
async function ensureClosure() {
  if (CLOSURE) return CLOSURE;
  const lb = await kget("_lock");                 // rebuild from the persisted lock (survives worker restart → offline)
  if (lb) CLOSURE = buildClosure(JSON.parse(TD.decode(lb)));
  return CLOSURE;
}

async function prime() {
  const lock = await (await fetch(SCOPE + "holospace.lock.json", { cache: "no-store" })).json();
  await kput("_lock", TE.encode(JSON.stringify(lock)));     // persist the manifest so offline can rebuild the map
  CLOSURE = buildClosure(lock);
  for (const [path, kappa] of Object.entries(CLOSURE)) {
    if (await kget(kappa)) { stats.primed++; continue; }
    try {
      const buf = new Uint8Array(await (await fetch(path, { cache: "no-store" })).arrayBuffer());
      if (await reDerive(buf) !== hexOf(kappa)) { stats.refused++; continue; }   // Law L5: refuse a wrong byte
      await kput(kappa, buf); stats.primed++;
    } catch {}
  }
  stats.total = Object.keys(CLOSURE).length;
  await broadcast({ event: "primed" });
}

async function resolve(path) {
  const kappa = CLOSURE && CLOSURE[path];
  if (!kappa) return null;
  let bytes = await kget(kappa);
  if (bytes) {                                  // O(1) local hit — content-addressed lookup, not a round-trip
    if (await reDerive(bytes) !== hexOf(kappa)) { stats.refused++; return new Response("κ mismatch — refused", { status: 409 }); }
    stats.reDerived++; stats.fromStore++;
    return new Response(bytes, { headers: { "content-type": mimeOf(path), "x-holo-source": "kstore", "x-holo-kappa": kappa } });
  }
  if (sealed) { stats.refused++; return new Response("origin-free: not in κ-store", { status: 504, headers: { "x-holo-source": "none" } }); }
  try {                                          // fetch from origin once, verify, store, then serve
    const buf = new Uint8Array(await (await fetch(path, { cache: "no-store" })).arrayBuffer());
    if (await reDerive(buf) !== hexOf(kappa)) { stats.refused++; return new Response("κ mismatch — refused", { status: 409 }); }
    await kput(kappa, buf); stats.fromOrigin++;
    return new Response(buf, { headers: { "content-type": mimeOf(path), "x-holo-source": "origin", "x-holo-kappa": kappa } });
  } catch { return null; }
}

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type === "prime") e.waitUntil(prime());
  else if (m.type === "seal") { sealed = true; broadcast({ event: "sealed" }); }
  else if (m.type === "unseal") { sealed = false; broadcast({ event: "unsealed" }); }
  else if (m.type === "stats") broadcast();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;   // only our app scope
  e.respondWith(handle(e.request, url));
});

async function handle(request, url) {
  await ensureClosure();
  let path = url.pathname;
  if (request.mode === "navigate" && (path === SCOPE || path === SCOPE + "index.html")) path = SCOPE + "index.html";
  if (CLOSURE && path in CLOSURE) {
    const r = await resolve(path);
    stats.total = Object.keys(CLOSURE).length;
    broadcast();
    if (r) return r;
  }
  return fetch(request);            // forge-sw.js itself, the lock, favicon, anything unmapped
}
