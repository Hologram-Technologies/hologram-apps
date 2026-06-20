// ipfs-sw.js — the Holo IPFS service-worker gateway. THIS is what makes the dweb feel
// like Chrome: a whole IPFS website renders and navigates natively, with EVERY subresource
// (HTML, CSS, JS, images, fonts) re-derived against its CID in the browser before it is
// served (Law L5 = the IETF Trustless Gateway contract). No gateway is trusted.
//
// Base-path aware: it derives its mount point from its own registration scope, so it works
// at the origin root (holo-serve) OR under a subpath like /<repo>/ (GitHub Pages). A request
// for <base>ipfsview/<cid>/<path> is resolved in the UnixFS DAG, every block verified, and
// served with the right content-type. A site's root-absolute subresource ("/style.css") is
// mapped back to its site via the Referer. Blocks come from: a bundled static block file
// (pure-static hosting), else the Cache API, else a race of trustless gateways — each
// re-verified. The page renders the site in a sandboxed iframe and drives back/forward.
//
// Module service worker → it imports the SAME engine the page + worker + witness use.

import * as IPFS from "./_shared/holo-ipfs.js";

const BLOCKS = "holo-ipfs-blocks-v1";   // Cache API store of verified raw blocks
const CFG = "holo-ipfs-cfg-v1";
// Mount point + app base, derived from the SW's own scope (e.g. /repo/ipfsview/ → /repo/).
const VIEW = new URL(self.registration.scope).pathname.replace(/\/?$/, "/");
const APP_BASE = VIEW.replace(/ipfsview\/$/, "");
const STATIC = APP_BASE + "ipfs-demo/blocks/";        // bundled blocks (works on GitHub Pages)
const DEFAULT_GW = [
  { origin: "https://trustless-gateway.link", viaProxy: false },
  { origin: "https://ipfs.io", viaProxy: false },
  { origin: "https://dweb.link", viaProxy: false },
  { origin: "https://4everland.io", viaProxy: false },
  { origin: "https://w3s.link", viaProxy: false },
];
let CONFIG = null;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type === "config") { CONFIG = { gateways: m.gateways || DEFAULT_GW, proxyBase: m.proxyBase || (APP_BASE + "ipfs?url=") }; caches.open(CFG).then((c) => c.put("/__cfg", new Response(JSON.stringify(CONFIG)))).catch(() => {}); if (e.ports && e.ports[0]) e.ports[0].postMessage("ok"); }
});
async function config() {
  if (CONFIG) return CONFIG;
  try { const c = await caches.open(CFG); const r = await c.match("/__cfg"); if (r) CONFIG = await r.json(); } catch {}
  return CONFIG || { gateways: DEFAULT_GW, proxyBase: APP_BASE + "ipfs?url=" };
}

// ── block retrieval: static file → cache → race gateways → verify → cache (trustless) ─
const blockUrl = (gw, cid, proxyBase) => { const direct = `${gw.origin.replace(/\/$/, "")}/ipfs/${cid}?format=raw`; return gw.viaProxy ? proxyBase + encodeURIComponent(direct) : direct; };
async function fetchFrom(gw, cid, cidObj, proxyBase, signal) {
  const r = await fetch(blockUrl(gw, cid, proxyBase), { headers: { accept: "application/vnd.ipld.raw" }, signal, cache: "no-store" });
  if (!r.ok) throw new Error(gw.origin + " HTTP " + r.status);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!(await IPFS.verifyBlock(cidObj, bytes))) throw new Error(gw.origin + " block refused");
  return bytes;
}
async function getBlock(cidStr) {
  const cid = IPFS.cidToString(IPFS.parseCID(cidStr));
  const cidObj = IPFS.parseCID(cid);
  const cache = await caches.open(BLOCKS);
  const key = "/__block/" + cid;
  const hit = await cache.match(key);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  // 1) bundled static block — pure static hosting (GitHub Pages) needs no server, no gateway
  try { const r = await fetch(STATIC + cid + ".block", { cache: "force-cache" }); if (r.ok) { const b = new Uint8Array(await r.arrayBuffer()); if (await IPFS.verifyBlock(cidObj, b)) { await cache.put(key, new Response(b)); return b; } } } catch {}
  // 2) race trustless gateways; only a re-derived block wins
  const { gateways, proxyBase } = await config();
  const ac = new AbortController();
  let bytes;
  try { bytes = await Promise.any(gateways.map((gw) => fetchFrom(gw, cid, cidObj, proxyBase, ac.signal))); }
  catch (e) { const errs = (e && e.errors) || [e]; throw new Error("no gateway verified " + cid + " — " + errs.map((x) => x.message).join("; ")); }
  ac.abort();
  await cache.put(key, new Response(bytes, { headers: { "content-type": "application/vnd.ipld.raw" } }));
  return bytes;
}

// ── resolve <base>ipfsview/<cid>/<path> → the file CID to serve (index.html for dirs) ─
async function resolveTarget(rootCid, path) {
  let cid = IPFS.cidToString(IPFS.parseCID(rootCid));
  const parts = String(path || "").split("/").filter(Boolean);
  for (const part of parts) {
    const info = IPFS.inspectBlock(cid, await getBlock(cid));
    if (info.kind !== "dir") throw new Error("not a directory: " + part);
    const hit = info.entries.find((e) => e.name === part);
    if (!hit) throw new Error("not found: " + part);
    cid = hit.cid;
  }
  const info = IPFS.inspectBlock(cid, await getBlock(cid));
  if (info.kind === "dir") {
    const idx = info.entries.find((e) => e.name === "index.html");
    if (idx) return { cid: idx.cid, name: "index.html" };
    return { cid, name: "", dir: info };
  }
  return { cid, name: parts[parts.length - 1] || "" };
}

function listingHtml(rootCid, path, info) {
  const rows = info.entries.map((e) => `<li><a href="${e.name}${e.isDir ? "/" : ""}">${e.isDir ? "📁 " : "📄 "}${e.name}</a></li>`).join("");
  return `<!doctype html><meta charset=utf-8><title>${path || rootCid}</title>
  <style>body{font:15px ui-sans-serif,system-ui;background:#0b0f17;color:#e6edf3;padding:2rem;max-width:760px;margin:auto}a{color:#4dd0e1;text-decoration:none}a:hover{text-decoration:underline}li{padding:.25rem 0;list-style:none}h1{font-size:1rem;color:#8b97a5;word-break:break-all}</style>
  <h1>/ipfs/${rootCid}/${path}</h1><ul>${rows || "<li>(empty)</li>"}</ul>`;
}

async function serveIpfsView(rootCid, path) {
  const t = await resolveTarget(rootCid, path);
  let bytes, ctype;
  if (t.dir) { bytes = new TextEncoder().encode(listingHtml(rootCid, path, t.dir)); ctype = "text/html; charset=utf-8"; }
  else { bytes = await IPFS.reassembleFile(t.cid, getBlock); ctype = IPFS.mimeByExt(t.name || path) || "application/octet-stream"; }
  return new Response(bytes, { status: 200, headers: { "content-type": ctype, "x-holo-cid": t.cid, "x-holo-verified": "L5", "cache-control": "public, max-age=31536000, immutable" } });
}

const refused = (e) => new Response("Holo IPFS could not verify this resource:\n" + e.message, { status: 502, headers: { "content-type": "text/plain" } });
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;                 // only our origin
  if (url.pathname.startsWith(VIEW)) {
    const rest = url.pathname.slice(VIEW.length);
    const m = rest.match(/^([^/]+)(\/.*)?$/);
    if (m) { event.respondWith(serveIpfsView(m[1], (m[2] || "").replace(/^\//, "")).catch(refused)); }
    return;
  }
  // root-absolute subresource from a site (e.g. "/style.css") → map back to its CID via Referer
  const rm = (event.request.referrer || "").match(new RegExp(VIEW.replace(/[/]/g, "\\/") + "([^/]+)\\/"));
  if (rm && url.pathname !== APP_BASE && !url.pathname.startsWith(APP_BASE + "_shared/") && !url.pathname.startsWith(APP_BASE + "ipfs")) {
    const sub = url.pathname.startsWith(APP_BASE) ? url.pathname.slice(APP_BASE.length) : url.pathname.replace(/^\//, "");
    event.respondWith(serveIpfsView(rm[1], sub + url.search).catch(() => fetch(event.request)));
  }
});
