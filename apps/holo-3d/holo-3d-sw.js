// holo-3d-sw.js — Holo 3D's offline engine. Two jobs:
//
//  1. Cross-origin isolation. Stamp COOP/COEP/CORP on every response so v86's
//     SharedArrayBuffer path works even on a static host that sends no such headers.
//  2. 100% serverless after first load. Cache the WHOLE app — shell, Three.js, the
//     κ-pinned v86 engine + BIOSes + the KolibriOS image — so it boots with the
//     origin server OFF, serving every byte from Cache Storage (the κ-store tier).
//
// Every asset is vendored under this SW's scope. The page's κ-gate still re-derives
// each artifact's SHA-256 on every boot, so serving from cache is safe: a corrupted
// cache entry fails the gate exactly like a corrupted download — integrity is never
// trusted, only re-derived (Law L5).

const VERSION = "h3d-v1";
const CACHE = "holo-3d-" + VERSION;
const SCOPE = new URL(self.registration.scope).pathname; // /apps/holo-3d/

const COI = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

// The complete set needed to cold-boot offline (relative to scope).
const BOOT_SET = [
  "index.html", "kappa.json",
  "holo-screen-gpu.js",   // WebGPU render backend (vendored; Three.js fallback stays in index.html)
  "vendor/three.min.js", "vendor/libv86.js", "vendor/v86.wasm",
  "vendor/seabios.bin", "vendor/bochs-vgabios.bin",
  "images/kolibri.img",
];

// "Airplane mode" — when set, the SW refuses ALL network and serves cache only, so the
// serverless claim is self-evident: block the network at the worker boundary, cold-boot,
// and if the OS still comes up, the boot used zero network by construction.
let NET_BLOCKED = false;
const netFetch = (req) => NET_BLOCKED ? Promise.reject(new Error("holo: network blocked (airplane mode)")) : fetch(req);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("holo-3d-") && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

function withCOI(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(COI)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
async function coiFrom(resp) {
  const buf = await resp.arrayBuffer();
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(COI)) h.set(k, v);
  return new Response(buf, { status: 200, headers: h });
}

// Heavy, content-stable artifacts → cache-first (never re-download per boot; the κ-gate
// re-verifies regardless). Everything else → network-first with cache as offline fallback.
const HEAVY = /\/(v86\.wasm|kolibri\.img)(\?|$)/;
const VENDORED = (p) => p.includes("/vendor/") || p.includes("/images/");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  event.respondWith(handle(req, url));
});

async function handle(req, url) {
  const cache = await caches.open(CACHE);
  const cacheFirst = HEAVY.test(url.pathname) || VENDORED(url.pathname);

  if (cacheFirst) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return coiFrom(hit);
    try {
      const resp = await netFetch(req);
      if (resp.ok) cache.put(req, resp.clone());
      return withCOI(resp);
    } catch (e) {
      const any = await cache.match(req, { ignoreSearch: true });
      if (any) return coiFrom(any);
      throw e;
    }
  }

  if (NET_BLOCKED) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match(SCOPE + "index.html"));
    if (hit) return coiFrom(hit);
    return new Response("holo: offline, not cached", { status: 504, headers: COI });
  }
  try {
    const resp = await netFetch(req);
    if (resp.ok) cache.put(req, resp.clone());
    return withCOI(resp);
  } catch (e) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match(SCOPE + "index.html"));
    if (hit) return coiFrom(hit);
    throw e;
  }
}

// ── message API (page ↔ SW) ────────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "holo-warm") event.waitUntil(warm(event));
  else if (msg.type === "holo-cache-status") event.waitUntil(reportStatus(event));
  else if (msg.type === "holo-netblock") { NET_BLOCKED = !!msg.on; reply(event, { type: "holo-netblock", on: NET_BLOCKED }); }
});

async function warm(event) {
  const cache = await caches.open(CACHE);
  let done = 0, bytes = 0;
  for (const rel of BOOT_SET) {
    const u = SCOPE + rel;
    try {
      let hit = await cache.match(u, { ignoreSearch: true });
      if (!hit) { const r = await fetch(u, { cache: "reload" }); if (r.ok) { await cache.put(u, r.clone()); hit = r; } }
      if (hit) { bytes += (await hit.clone().arrayBuffer()).byteLength; done++; }
    } catch (_) {}
    reply(event, { type: "holo-warm-progress", done, total: BOOT_SET.length, bytes });
  }
  reply(event, { type: "holo-warm-done", done, total: BOOT_SET.length, bytes });
}

async function reportStatus(event) {
  const cache = await caches.open(CACHE);
  let cached = 0, bytes = 0;
  for (const rel of BOOT_SET) {
    const hit = await cache.match(SCOPE + rel, { ignoreSearch: true });
    if (hit) { cached++; try { bytes += (await hit.clone().arrayBuffer()).byteLength; } catch (_) {} }
  }
  reply(event, { type: "holo-cache-status", cached, total: BOOT_SET.length, bytes, ready: cached >= BOOT_SET.length });
}

function reply(event, data) {
  if (event.source) event.source.postMessage(data);
  else if (event.ports && event.ports[0]) event.ports[0].postMessage(data);
}
