// ipfs-worker.js — Holo IPFS retrieval + verification, off the UI thread.
//
// The page renders; the EXPENSIVE work — fetching blocks, re-deriving every block's
// multihash to verify it against its CID (Law L5 = the Trustless Gateway contract),
// reassembling UnixFS file DAGs, and computing CIDs for a local "add" — runs HERE so
// the UI never janks. The worker is the verifier: a gateway is never trusted. It races
// several trustless gateways and accepts only the FIRST block that re-derives to the
// requested CID; a gateway that returns a wrong or tampered block simply loses the race.
//
// Protocol (postMessage):
//   → { type:"config", gateways:[{origin, viaProxy}], proxyBase }
//   → { type:"resolve",   id, cid, path }            browse: resolve path → inspect block
//   → { type:"reassemble",id, cid, mime }            file: fetch+verify+concat → bytes
//   → { type:"add",       id, name, bytes }          local ipfs add (no network): real CID
//   ← { type:"ready" } | "resolved" | "block" | "file" | "added" | "error"
//
// One source of truth: the SAME _shared/holo-ipfs.js the page + the Node witness use.

import * as IPFS from "./_shared/holo-ipfs.js";

let GATEWAYS = [
  { origin: "https://trustless-gateway.link", viaProxy: true },
  { origin: "https://ipfs.io", viaProxy: true },
  { origin: "https://dweb.link", viaProxy: true },
  { origin: "https://4everland.io", viaProxy: true },
  { origin: "https://w3s.link", viaProxy: true },        // web3.storage — content backed by Filecoin storage deals
];
let PROXY_BASE = "/ipfs?url=";
let STATIC_BLOCKS = "ipfs-demo/blocks/";   // bundled blocks, relative to the worker (works on static hosting)
let lastGw = "";

const blockUrl = (gw, cidStr) => {
  const direct = `${gw.origin.replace(/\/$/, "")}/ipfs/${cidStr}?format=raw`;
  return gw.viaProxy ? PROXY_BASE + encodeURIComponent(direct) : direct;
};

// Fetch ONE block from ONE gateway and verify it re-derives to the CID, else reject.
async function fetchFrom(gw, cidStr, cidObj, signal) {
  const r = await fetch(blockUrl(gw, cidStr), { headers: { accept: "application/vnd.ipld.raw" }, signal, cache: "no-store" });
  if (!r.ok) throw new Error(`${gw.origin} → HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!(await IPFS.verifyBlock(cidObj, bytes))) throw new Error(`${gw.origin} → block FAILED verification (refused)`);
  return { bytes, origin: gw.origin };
}

// Persistent block cache (Cache API) — shared origin-wide with the service-worker gateway,
// so a block fetched once (here or by the SW) makes the next visit instant + offline-ready.
const CACHE = "holo-ipfs-blocks-v1";
const blockCache = new Map();                  // hot in-memory layer
async function cacheGet(cid) { try { const c = await caches.open(CACHE); const r = await c.match("/__block/" + cid); return r ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; } }
async function cachePut(cid, bytes) { try { const c = await caches.open(CACHE); await c.put("/__block/" + cid, new Response(bytes, { headers: { "content-type": "application/vnd.ipld.raw" } })); } catch {} }

// Race all gateways; resolve with the first VERIFIED block. A malicious/wrong gateway
// can't win because its bytes won't re-derive to the CID. Lowest-latency honest source wins.
async function tryStatic(cid, cidObj) {
  try { const r = await fetch(STATIC_BLOCKS + cid + ".block", { cache: "force-cache" }); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); return (await IPFS.verifyBlock(cidObj, b)) ? b : null; } catch { return null; }
}
async function fetchBlock(cidStr) {
  const key = IPFS.cidToString(IPFS.parseCID(cidStr));
  if (blockCache.has(key)) return blockCache.get(key);
  const cached = await cacheGet(key);
  if (cached) { blockCache.set(key, cached); return cached; }
  const cidObj = IPFS.parseCID(key);
  // bundled static block (pure static hosting / offline) — verified, then cached
  const st = await tryStatic(key, cidObj);
  if (st) { blockCache.set(key, st); cachePut(key, st); lastGw = "static"; return st; }
  const ac = new AbortController();
  const tasks = GATEWAYS.map((gw) => fetchFrom(gw, key, cidObj, ac.signal));
  let won;
  try { won = await Promise.any(tasks); }
  catch (e) { const errs = (e && e.errors) || [e]; throw new Error("no gateway returned a verified block — " + errs.map((x) => x.message || x).join("; ")); }
  ac.abort();                                  // cancel the losers
  lastGw = won.origin;
  if (blockCache.size > 4096) blockCache.clear();
  blockCache.set(key, won.bytes); cachePut(key, won.bytes);
  return won.bytes;
}

// CAR streaming: pull the whole entity DAG in ONE round-trip, verify + cache each block as
// it arrives, so reassembly then runs from cache. Best-effort — falls back to per-block racing.
async function prefetchCar(rootCid, scope = "entity") {
  const key = IPFS.cidToString(IPFS.parseCID(rootCid));
  for (const gw of GATEWAYS) {
    try {
      const direct = `${gw.origin.replace(/\/$/, "")}/ipfs/${key}?format=car&dag-scope=${scope}`;
      const url = gw.viaProxy ? PROXY_BASE + encodeURIComponent(direct) : direct;
      const r = await fetch(url, { headers: { accept: "application/vnd.ipld.car" }, cache: "no-store" });
      if (!r.ok || !r.body) continue;
      const parser = new IPFS.CarParser(); const reader = r.body.getReader(); let got = 0;
      for (; ;) {
        const { done, value } = await reader.read(); if (done) break;
        for (const blk of parser.push(value)) { if (await IPFS.verifyBlock(blk.cidObj, blk.bytes)) { blockCache.set(blk.cid, blk.bytes); cachePut(blk.cid, blk.bytes); got++; } }
      }
      if (got > 0) { lastGw = gw.origin; return got; }
    } catch {}
  }
  return 0;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === "config") {
      if (Array.isArray(m.gateways) && m.gateways.length) GATEWAYS = m.gateways;
      if (m.proxyBase) PROXY_BASE = m.proxyBase;
      if (m.staticBlocks) STATIC_BLOCKS = m.staticBlocks;
      blockCache.clear();
      return;
    }
    if (m.type === "resolve") {
      const t0 = performance.now();
      const targetCid = m.path ? await IPFS.resolvePath(m.cid, m.path, fetchBlock) : IPFS.cidToString(IPFS.parseCID(m.cid));
      const bytes = await fetchBlock(targetCid);
      const info = IPFS.inspectBlock(targetCid, bytes);
      self.postMessage({
        type: "resolved", id: m.id, cid: targetCid, kind: info.kind, info,
        verified: true, gw: lastGw, ms: Math.round(performance.now() - t0),
        did: IPFS.cidToDid(targetCid), holo: IPFS.holoUri(targetCid),
        codec: IPFS.codecName(IPFS.parseCID(targetCid).codec), hash: IPFS.hashName(IPFS.parseCID(targetCid).hashCode),
      });
      return;
    }
    if (m.type === "reassemble") {
      const t0 = performance.now(); let blocks = 0, bytesSeen = 0;
      if (m.car !== false) { const got = await prefetchCar(m.cid, "entity"); if (got) self.postMessage({ type: "progress", id: m.id, blocks: got, bytes: 0, gw: lastGw, car: true }); }   // one round-trip warms the cache
      const out = await IPFS.reassembleFile(m.cid, fetchBlock, {
        onBlock: (cid, n) => { blocks++; bytesSeen += n; if (blocks % 8 === 0) self.postMessage({ type: "progress", id: m.id, blocks, bytes: bytesSeen, gw: lastGw }); },
      });
      self.postMessage({ type: "file", id: m.id, cid: IPFS.cidToString(IPFS.parseCID(m.cid)), mime: m.mime || "application/octet-stream",
        bytes: out.buffer, size: out.length, blocks, gw: lastGw, ms: Math.round(performance.now() - t0),
        did: IPFS.cidToDid(m.cid), holo: IPFS.holoUri(m.cid) }, [out.buffer]);
      return;
    }
    if (m.type === "add") {
      const bytes = m.bytes instanceof ArrayBuffer ? new Uint8Array(m.bytes) : new Uint8Array(m.bytes);
      const dag = await IPFS.buildFileDag(bytes);
      const dual = await IPFS.cidDualAxis(bytes, IPFS.CODEC.RAW);
      let root = dag.root;
      if (m.wrap) {                                   // wrap the file as dir{<wrap>} so it renders as a site via the SW
        const d = await IPFS.buildDirNode([{ name: m.wrap, cid: dag.root, tsize: dag.size }]);
        dag.blocks.set(d.cid, d.bytes); root = d.cid;
      }
      for (const [cid, b] of dag.blocks) { blockCache.set(cid, b); cachePut(cid, b); }   // make added blocks visible to the SW gateway (shared cache)
      const blocks = [...dag.blocks].map(([cid, b]) => ({ cid, bytes: b.slice().buffer }));
      self.postMessage({ type: "added", id: m.id, name: m.name, root, fileCid: dag.root, count: dag.blocks.size, size: dag.size,
        did: IPFS.cidToDid(root), holo: IPFS.holoUri(root), dual, blocks }, blocks.map((b) => b.bytes));
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
  }
};

(async () => {
  let selftest = { ok: false };
  try { selftest = await IPFS.selfTest(); } catch {}
  self.postMessage({ type: "ready", version: IPFS.VERSION, selftest: selftest.ok });
})();
