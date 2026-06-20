// holo-x86-kblocks-sw.js — the κ-BLOCK DISK seam for v86.
//
// v86's async disk backend (libv86.js `ya`) reads the image one fixed_chunk_size-aligned
// range at a time, over an XHR `Range` request, and ABORTS if it gets a 200 instead of a 206.
// This worker intercepts exactly those ranged reads on the image URL and answers each from the
// κ-block DAG (built by tools/holo-disk-encode.mjs): map offset → block index → block κ, fetch
// the block object, RE-DERIVE its sha256 and refuse on mismatch (Law L5), then return the exact
// requested bytes as 206 Partial Content. The guest sees an ordinary disk; the substrate sees a
// content-addressed, lazily-resolved, individually-verifiable set of objects.
//
// Only blocks the guest actually touches are ever fetched — image size is irrelevant. Every
// served byte is re-derived before it reaches the decoder, so a corrupted block fails exactly
// like a corrupted download (integrity is never trusted, only re-derived).
//
// This is a DEV/measurement seam: block objects are served from the app-relative store
// (images/<base>.kblocks/.holo/sha256/<hex>). The production step folds those same objects into
// the app closure via relock-app so they resolve at the canonical OS-wide /.holo/sha256 route.

const SCOPE = new URL(self.registration.scope).pathname; // /apps/holo-x86/
const MANIFEST_URL = SCOPE + "images/linux4.iso.kblocks.json";
const IMAGE_PATH = SCOPE + "images/linux4.iso";          // the URL v86 issues ranged GETs against
// Resolve blocks by κ. Canonical first: the OS-wide content route (/.holo/sha256/<hex>) that
// relock-app folds the block objects into — so blocks are shared substrate-wide, not app-local.
// Fallback: the app-relative store, so the seam works before the dev server re-indexes the closure.
const KAPPA_ROUTE = "/.holo/sha256/";
const STORE_FALLBACK = SCOPE + "images/linux4.iso.kblocks/.holo/sha256/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ── κ-block DAG state ───────────────────────────────────────────────────────────
let manifestP = null;                 // Promise<manifest>
const blockCache = new Map();         // hex → Uint8Array (verified, in-memory)
const stats = { reads: 0, blockFetches: 0, cacheHits: 0, bytes: 0, maxStallMs: 0, totalStallMs: 0 };

const hexOf = (did) => String(did).split(":").pop();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function loadManifest() {
  if (!manifestP) manifestP = fetch(MANIFEST_URL, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("kblocks manifest HTTP " + r.status);
    return r.json();
  });
  return manifestP;
}

// Fetch one block by its κ and RE-DERIVE before admitting it (Law L5). Cached after first read.
async function getBlock(hex) {
  const cached = blockCache.get(hex);
  if (cached) { stats.cacheHits++; return cached; }
  const t0 = performance.now();
  let r = await fetch(KAPPA_ROUTE + hex, { cache: "force-cache" });
  if (!r.ok) r = await fetch(STORE_FALLBACK + hex, { cache: "force-cache" }); // pre-reindex fallback
  if (!r.ok) throw new Error("block " + hex.slice(0, 10) + " HTTP " + r.status);
  const buf = await r.arrayBuffer();
  const actual = toHex(await crypto.subtle.digest("SHA-256", buf));
  if (actual !== hex) throw new Error("κ mismatch on block " + hex.slice(0, 10) + " (refused, Law L5)");
  const dt = performance.now() - t0;
  stats.blockFetches++; stats.totalStallMs += dt; stats.maxStallMs = Math.max(stats.maxStallMs, dt);
  const bytes = new Uint8Array(buf);
  blockCache.set(hex, bytes);
  return bytes;
}

// Best-effort read-ahead: warm the next N blocks without blocking the response (overlaps fetch
// with the guest chewing on the bytes it just got — the holo-tube AHEAD-window trick).
function prefetch(blocks, fromIndex, n) {
  for (let i = fromIndex; i < Math.min(fromIndex + n, blocks.length); i++) {
    const hex = hexOf(blocks[i]);
    if (!blockCache.has(hex)) getBlock(hex).catch(() => {});
  }
}

// Serve a chunk-aligned (or arbitrary) byte range [start, end] from the κ-block DAG.
async function serveRange(start, end, m) {
  const { blockSize, blocks, image } = m;
  const total = image.bytes;
  end = Math.min(end, total - 1);
  const out = new Uint8Array(end - start + 1);
  const firstBlock = Math.floor(start / blockSize);
  const lastBlock = Math.floor(end / blockSize);
  for (let bi = firstBlock; bi <= lastBlock; bi++) {
    const block = await getBlock(hexOf(blocks[bi]));
    const blockStart = bi * blockSize;
    const from = Math.max(start, blockStart) - blockStart;
    const to = Math.min(end, blockStart + block.length - 1) - blockStart;
    out.set(block.subarray(from, to + 1), (blockStart + from) - start);
  }
  prefetch(blocks, lastBlock + 1, 4);
  return { out, total };
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname !== IMAGE_PATH) return; // only the disk URL
  const range = req.headers.get("range");
  if (!range) return; // non-ranged hit (shouldn't happen in async mode) → let the network serve it
  event.respondWith(handleRange(req, range));
});

async function handleRange(req, range) {
  try {
    const m = await loadManifest();
    const total = m.image.bytes;
    const mm = /bytes=(\d+)-(\d*)/.exec(range);
    if (!mm) return new Response("bad range", { status: 416 });
    const start = +mm[1];
    const end = mm[2] === "" ? total - 1 : +mm[2];
    stats.reads++;
    const { out } = await serveRange(start, end, m);
    stats.bytes += out.length;
    return new Response(out, {
      status: 206,
      headers: {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": String(out.length),
        "Content-Range": `bytes ${start}-${start + out.length - 1}/${total}`,
      },
    });
  } catch (e) {
    return new Response("κ-block error: " + (e && e.message || e), { status: 502 });
  }
}

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "kblocks-stats") {
    const avg = stats.blockFetches ? (stats.totalStallMs / stats.blockFetches) : 0;
    const data = { type: "kblocks-stats", ...stats, avgStallMs: +avg.toFixed(2) };
    if (event.source) event.source.postMessage(data);
    else if (event.ports && event.ports[0]) event.ports[0].postMessage(data);
  }
});
