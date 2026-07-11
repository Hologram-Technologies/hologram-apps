// sw.js — the service worker that IS the app server (HOLO-ANIMATE-SERVERLESS, SL-P0). It serves what the
// in-page animator stored in the Cache-API κ-store:
//   /run/<id>/<path>  → the animated app's file tree (exact asset or HONEST 404 — never page-HTML for an
//                       asset; the L2/L3 serving laws of holo-animate-conformance, host-invariant)
//   /vendor/<κ>       → a κ-vendored runtime module, BLAKE3-VERIFIED against its own name BEFORE serving
//                       (L5: tampered bytes → 409, refused — trustless because verification, not trust)
// Everything else falls through to the network (the static origin).
//
// Module SW: imports the CANONICAL blake3 (served unmodified from /lib/) — the same bytes the OS uses.

import { blake3hex } from "./lib/holo-blake3.mjs";

const RUN_CACHE = "holo-run-v1";
// SUBPATH RELOCATION (SS-P3): routes key off the REGISTRATION SCOPE, not the origin root — the same SW
// serves at "/" locally and at "/<repo>/" on a Pages origin. Cache keys are scope-absolute URLs (the
// client stores them the same way), so scope and keys always agree.
const SCOPE = new URL(self.registration.scope).pathname;   // e.g. "/" or "/animate/"

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// vm-fetch RPC correlation: reqId → resolve (answers arrive as messages from the page owning the machine)
const vmPending = new Map();
self.addEventListener("message", (e) => {
  const r = e.data && e.data.vmFetchResult;
  if (!r) return;
  const resolve = vmPending.get(r.reqId);
  if (resolve) { vmPending.delete(r.reqId); resolve(r); }
});

const honest404 = (p) => new Response("not found: " + p, { status: 404, headers: { "content-type": "text/plain" } });

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // cross-origin (jsdelivr/raw/esm.sh build-time ingest) → network

  if (url.pathname.startsWith(SCOPE + "run/")) {
    e.respondWith((async () => {
      const cache = await caches.open(RUN_CACHE);
      let p = url.pathname;
      if (p.endsWith("/")) p += "index.html";
      let hit = await cache.match(url.origin + p);
      if (!hit) { try { hit = await cache.match(url.origin + decodeURIComponent(p)); } catch {} }
      // a bare <scope>run/<id> (no trailing slash) opens the app's index
      if (!hit && new RegExp("^" + SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "run/[^/]+$").test(p)) hit = await cache.match(url.origin + p + "/index.html");
      return hit || honest404(p);   // L3: a missing asset 404s honestly — NEVER echoes HTML
    })());
    return;
  }

  // ── VT-P2: <scope>vm/<vmid>/<path> — the in-tab MACHINE as a URL. The SW does not own the emulator (it
  //    lives in a page), so this is an RPC: broadcast {vmFetch} to window clients; the page owning that
  //    vmid answers with the guest's real HTTP response (status/headers/body bytes, binary-faithful).
  //    No owner / guest down → honest 404/502, never a phantom page (the L2/L3 laws hold for machines too).
  if (url.pathname.startsWith(SCOPE + "vm/")) {
    e.respondWith((async () => {
      const rest = url.pathname.slice((SCOPE + "vm/").length);
      const slash = rest.indexOf("/");
      const vmid = slash < 0 ? rest : rest.slice(0, slash);
      const path = (slash < 0 ? "/" : rest.slice(slash)) + (url.search || "");
      if (!vmid) return honest404(url.pathname);
      const reqId = Math.random().toString(36).slice(2);
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!clientsList.length) return new Response("no page owns machine '" + vmid + "'", { status: 404, headers: { "content-type": "text/plain" } });
      const answer = new Promise((resolve) => {
        vmPending.set(reqId, resolve);
        setTimeout(() => { if (vmPending.delete(reqId)) resolve(null); }, 15000);
      });
      for (const c of clientsList) c.postMessage({ vmFetch: { reqId, vmid, path } });
      const r = await answer;
      if (!r) return new Response("machine '" + vmid + "' did not answer (no owning page, or guest hung)", { status: 502, headers: { "content-type": "text/plain" } });
      if (!r.ok) return new Response("machine error: " + r.error, { status: 502, headers: { "content-type": "text/plain" } });
      const headers = { "content-type": (r.headers && r.headers["content-type"]) || "application/octet-stream" };
      if (r.headers && r.headers["content-length"]) headers["content-length"] = r.headers["content-length"];
      return new Response(r.body, { status: r.status, statusText: r.statusText || "", headers });
    })());
    return;
  }

  if (url.pathname.startsWith(SCOPE + "vendor/")) {
    e.respondWith((async () => {
      const hex = url.pathname.slice((SCOPE + "vendor/").length).split("?")[0];
      if (!/^[0-9a-f]{64}$/.test(hex)) return honest404(url.pathname);
      const cache = await caches.open(RUN_CACHE);
      const hit = await cache.match(url.origin + SCOPE + "vendor/" + hex);
      if (!hit) return honest404(url.pathname);
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (blake3hex(bytes) !== hex) return new Response("vendor κ mismatch (tamper) — refused", { status: 409, headers: { "content-type": "text/plain" } });   // L5
      return new Response(bytes, { headers: { "content-type": "text/javascript", "cache-control": "immutable, max-age=31536000" } });
    })());
    return;
  }
});
