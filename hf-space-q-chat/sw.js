// sw.js — Q's offline shell. Makes the 2nd open instant and lets Q install as an app (PWA). It caches only
// SAME-ORIGIN static assets; it NEVER touches the cross-origin HuggingFace model stream. App code (html/js/mjs)
// is network-FIRST so a new deploy is always picked up; the heavy immutable runtime (vendor/, pkg/, wallpaper,
// wasm) is cache-FIRST for instant warm loads. Cross-origin isolation is NOT required — the brain (qvac-gpu) and
// the neural voice both run without SAB — so this SW deliberately does not meddle with COOP/COEP.
const CACHE = "q-shell-v1";
const IMMUTABLE = /\/(vendor|pkg)\/|\.(wasm|jpg|png|svg|woff2?)$/i;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // HuggingFace weights + any cross-origin: leave untouched

  if (IMMUTABLE.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) (await caches.open(CACHE)).put(req, res.clone()); return res; }
      catch { return hit || Response.error(); }
    })());
    return;
  }
  e.respondWith((async () => {
    try { const res = await fetch(req); if (res.ok) (await caches.open(CACHE)).put(req, res.clone()); return res; }
    catch { return (await caches.match(req)) || (await caches.match("./index.html")) || Response.error(); }
  })());
});
