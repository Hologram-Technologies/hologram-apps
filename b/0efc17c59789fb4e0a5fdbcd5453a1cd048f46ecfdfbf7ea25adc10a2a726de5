// holo-app-worker.mjs — holds the resumed machine and serves the app's HTTP requests from the LIVE guest.
// The machine ticks continuously; each request from the service worker (relayed by the page) is dialed to
// the guest over the loopback bridge and its real response returned — so navigations, assets, and XHR all
// hit the running app, making it fully functional in the tab.
import init, { X64Workspace, kappa_manifest_pages } from "./pkg/holospaces_web.js";

const enc = new TextEncoder(), dec = new TextDecoder();
const bytesOf = async (p) => new Uint8Array(await (await fetch(p)).arrayBuffer());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const append = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
function indexOfSeq(buf, seq) { outer: for (let i = 0; i <= buf.length - seq.length; i++) { for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer; return i; } return -1; }

let ws = null, port = 80, running = false;
let diskStats = null; // lazy mode: {faults, bytes} — disk κ-objects Range-streamed on fault

// ── OPFS object cache: one append-only local pack shared by every app on this origin. Objects are
// content-named (κ), so cross-app reuse is free — httpd finds the alpine base nginx already pulled,
// and a repeat open needs no network for objects at all. Exclusive sync-handle lock: if another tab
// holds it we silently run network-only.
const opfs = { ready: false, pack: null, idxH: null, idx: new Map(), size: 0, dir: null, dirty: [] };
async function opfsOpen() {
  try {
    const root = await navigator.storage.getDirectory();
    opfs.dir = await root.getDirectoryHandle("holo-fabric", { create: true });
    const pf = await opfs.dir.getFileHandle("objects.pack", { create: true });
    opfs.pack = await pf.createSyncAccessHandle();
    opfs.size = opfs.pack.getSize();
    const xf = await opfs.dir.getFileHandle("objects.idx", { create: true });
    opfs.idxH = await xf.createSyncAccessHandle();
    const buf = new Uint8Array(opfs.idxH.getSize());
    if (buf.length) opfs.idxH.read(buf, { at: 0 });
    for (const line of dec.decode(buf).split("\n")) {
      const [n, off, len] = line.split(" ");
      if (n && len) opfs.idx.set(n, [Number(off), Number(len)]);
    }
    opfs.ready = true;
  } catch (_) { opfs.ready = false; }
}
function opfsGet(name) {
  if (!opfs.ready) return null;
  const e = opfs.idx.get(name);
  if (!e) return null;
  const b = new Uint8Array(e[1]);
  opfs.pack.read(b, { at: e[0] });
  return b;
}
function opfsPut(name, bytes) {
  if (!opfs.ready || opfs.idx.has(name)) return;
  opfs.pack.write(bytes, { at: opfs.size });
  opfs.idx.set(name, [opfs.size, bytes.length]);
  opfs.dirty.push(`${name} ${opfs.size} ${bytes.length}\n`);
  opfs.size += bytes.length;
}
function opfsFlush() {
  if (!opfs.ready || !opfs.dirty.length) return;
  const chunk = new TextEncoder().encode(opfs.dirty.join(""));
  opfs.idxH.write(chunk, { at: opfs.idxH.getSize() });
  opfs.dirty = [];
  opfs.pack.flush(); opfs.idxH.flush();
}
function opfsPutBatch(entries) {
  // One concatenated pack append instead of thousands of small sync writes.
  if (!opfs.ready) return;
  const fresh = entries.filter(([n]) => !opfs.idx.has(n));
  if (!fresh.length) return;
  let total = 0;
  for (const [, b] of fresh) total += b.length;
  const blob = new Uint8Array(total);
  let at = 0;
  for (const [n, b] of fresh) {
    blob.set(b, at);
    opfs.idx.set(n, [opfs.size + at, b.length]);
    opfs.dirty.push(`${n} ${opfs.size + at} ${b.length}\n`);
    at += b.length;
  }
  opfs.pack.write(blob, { at: opfs.size });
  opfs.size += total;
  opfsFlush();
}
// Small async side-files (manifest/idx twins) so a repeat open works fully offline.
async function opfsFileRead(name) {
  try { const fh = await opfs.dir.getFileHandle(name); return new Uint8Array(await (await fh.getFile()).arrayBuffer()); } catch { return null; }
}
async function opfsFileWrite(name, bytes) {
  try { const fh = await opfs.dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(bytes); await w.close(); } catch {}
}

async function open(msg) {
  const T = { t0: performance.now() };
  await init(); T.init = performance.now();
  port = msg.port || 80;
  let bytesFetched = 0;
  if (msg.pack && msg.lazy) {
    // ── LAZY PACK path: fetch the manifest + ONLY the RAM working set (coalesced HTTP Range over
    // the shared packfile); disk κ-objects stream ON FAULT via sync XHR Range. The pack index is
    // itself lazy: it locates objects we DON'T have, so when OPFS covers the working set it is
    // never fetched — a repeat open costs zero network and works fully offline.
    const inflate = async (u8) => new Uint8Array(await new Response(
      new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    const parseIdx = (text) => {
      // objstore.idx: `<64-hex κ name> <off> <len>` per line.
      const m = new Map();
      for (const line of text.split("\n")) {
        if (line.charCodeAt(64) !== 32) continue;
        const sp = line.indexOf(" ", 65);
        m.set(line.slice(0, 64), [Number(line.slice(65, sp)), Number(line.slice(sp + 1))]);
      }
      return m;
    };
    await opfsOpen();
    // Manifest is content-keyed (immutable) → OPFS-first; only a miss touches the network.
    const mKey = "m-" + msg.manifestZ.split("/").pop();
    let netBytes = 0;
    let mzB = opfs.ready ? await opfsFileRead(mKey) : null;
    if (!mzB) {
      mzB = await bytesOf(msg.manifestZ);
      netBytes += mzB.length;
      if (opfs.ready) opfsFileWrite(mKey, mzB);
    }
    const manifest = await inflate(mzB);
    // Index grows with the fabric → network-first when needed, OPFS fallback for offline.
    let idx = null;
    const loadIdx = async () => {
      try {
        const b = msg.idxZ ? await bytesOf(msg.idxZ) : await fetch(msg.idx).then((r) => r.text());
        netBytes += b.length;
        if (opfs.ready && msg.idxZ) opfsFileWrite("objstore.idx.z", b);
        return parseIdx(typeof b === "string" ? b : dec.decode(await inflate(b)));
      } catch (e) {
        const c = opfs.ready ? await opfsFileRead("objstore.idx.z") : null;
        if (c) return parseIdx(dec.decode(await inflate(c)));
        throw e;
      }
    };
    // NOTHING is prefetched (CC-82 inc-3): RAM pages are FAULT-LAZY inside wasm and stream through
    // the same κ-fetch as disk sectors. The only planning here is an OPFS coverage check — the pack
    // idx is fetched only if some κ-object will have to come over the network.
    const names = kappa_manifest_pages(manifest).map((s) => s.slice(7));
    let covered = 0;
    for (const n of names) if (opfs.ready && opfs.idx.has(n)) covered++;
    if (covered < names.length) idx = await loadIdx();
    bytesFetched = netBytes;
    T.opfs = { covered, of: names.length, on: opfs.ready, idxSkipped: !idx };
    T.fetch = performance.now();
    // Disk objects: OPFS first, else sync XHR Range on fault (allowed in a worker). If a fault
    // misses OPFS on an open that skipped the idx, sync-fetch the RAW idx once (rare escape hatch;
    // deflate can't be inflated synchronously).
    const idxSync = () => {
      if (idx) return idx;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", msg.idx, false);
      xhr.send();
      idx = xhr.status === 200 ? parseIdx(xhr.responseText) : new Map();
      return idx;
    };
    const stats = (diskStats = { faults: 0, bytes: 0 });
    const diskCache = new Map();
    const rangeSync = (off, len) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", msg.pack, false);
      xhr.setRequestHeader("Range", `bytes=${off}-${off + len - 1}`);
      try {
        xhr.responseType = "arraybuffer";
        xhr.send();
        if (xhr.status !== 206 && xhr.status !== 200) return null;
        return new Uint8Array(xhr.response);
      } catch (_) {
        // sync-XHR arraybuffer refused in this engine → binary-string fallback
        const x2 = new XMLHttpRequest();
        x2.open("GET", msg.pack, false);
        x2.overrideMimeType("text/plain; charset=x-user-defined");
        x2.setRequestHeader("Range", `bytes=${off}-${off + len - 1}`);
        x2.send();
        if (x2.status !== 206 && x2.status !== 200) return null;
        const s = x2.responseText, b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
        return b;
      }
    };
    // The ONE κ-fetch backing both RAM faults and disk faults: OPFS first; on a network fault,
    // READ-AHEAD — pull a ~256 KiB window of neighboring κ-objects in one sync Range (objects that
    // fault together sit together in the pack, which is written in manifest order) and persist the
    // whole window, so a fault storm costs dozens of round-trips, not thousands.
    let idxArr = null;
    const idxArrOf = (m) => {
      if (!idxArr) idxArr = [...m.entries()].map(([n, [o, l]]) => [o, l, n]).sort((a, b) => a[0] - b[0]);
      return idxArr;
    };
    // Read-ahead size: the pack is DENSE (~560 B/object), so a big window is pure over-fetch —
    // 256 KiB windows measured 32 MiB streamed for a ~3 MiB working set. 32 KiB keeps the
    // sequential-fault clustering (manifest order = RAM page order) at bounded waste.
    const WINDOW = 32768;
    const kappaFetch = (name) => {
      const c = diskCache.get(name);
      if (c) return c;
      const hit = opfsGet(name);
      if (hit) { stats.faults++; diskCache.set(name, hit); return hit; }
      const m = idxSync();
      const e = m.get(name);
      if (!e) return null;
      const arr = idxArrOf(m);
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < e[0]) lo = mid + 1; else hi = mid; }
      const w = [];
      let end = e[0] + e[1];
      for (let i = lo; i < arr.length && arr[i][0] + arr[i][1] - e[0] <= WINDOW; i++) { w.push(arr[i]); end = arr[i][0] + arr[i][1]; }
      if (!w.length) w.push([e[0], e[1], name]);
      const buf = rangeSync(e[0], end - e[0]);
      if (!buf) return null;
      stats.faults++; stats.bytes += buf.length;
      const fresh = [];
      for (const [o, l, n2] of w) {
        const b = buf.subarray(o - e[0], o - e[0] + l);
        if (!diskCache.has(n2)) { diskCache.set(n2, b); fresh.push([n2, b]); }
      }
      opfsPutBatch(fresh);
      return diskCache.get(name) || null;
    };
    ws = X64Workspace.resume_kappa_pack_lazy_ram(manifest, kappaFetch);
    T.resume = performance.now();
  } else if (msg.pack) {
    // ── PACK path (CC-81 M4 in the tab): fetch the deflate manifest + shared packfile + index —
    // ~3x fewer bytes than the flat .holo, and the pack is SHARED across images (a 2nd alpine app
    // re-fetches almost nothing once HTTP-cached). All inflate + L5 verify happens inside wasm;
    // disk sectors stay LAZY (inflated from the resident pack on first guest read).
    const [mz, idxText, pack] = await Promise.all([
      bytesOf(msg.manifestZ),
      fetch(msg.idx).then((r) => r.text()),
      bytesOf(msg.pack),
    ]);
    bytesFetched = mz.length + idxText.length + pack.length;
    T.fetch = performance.now();
    ws = X64Workspace.resume_kappa_pack(mz, idxText, pack); T.resume = performance.now();
  } else {
    const blob = await bytesOf(msg.src); T.fetch = performance.now(); // fetch the whole .holo over HTTP
    bytesFetched = blob.length;
    ws = X64Workspace.resume_kappa(blob); T.resume = performance.now(); // rebuild the RUNNING machine — no boot
  }
  ws.enable_loopback();
  running = true;
  const tick = () => { if (!running) return; ws.run(2_000_000); setTimeout(tick, 0); };
  tick();
  self.postMessage({ type: "ready", timing: {
    wasmInitMs: Math.round(T.init - T.t0),
    blobFetchMs: Math.round(T.fetch - T.init),
    resumeMs: Math.round(T.resume - T.fetch),
    blobMiB: Math.round(bytesFetched / 1048576),
    pack: !!msg.pack,
    lazy: !!(msg.pack && msg.lazy),
    opfs: T.opfs || null,
  } });
}

// Serve one request from the guest over the loopback bridge.
async function serve(id, method, pth) {
  if (!ws) return self.postMessage({ type: "served", id, status: 503, headers: {}, body: enc.encode("not ready") });
  const conn = ws.dial_guest(port);
  if (conn == null) return self.postMessage({ type: "served", id, status: 502, headers: {}, body: enc.encode("no guest") });
  ws.guest_send(conn, enc.encode(`${method} ${pth} HTTP/1.0\r\nHost: app\r\nConnection: close\r\n\r\n`));

  let raw = new Uint8Array(0), idle = 0, headEnd = -1, need = -1;
  for (let i = 0; i < 4000; i++) {
    const c = ws.guest_recv(conn);
    if (c && c.length) { raw = append(raw, c); idle = 0; } else { idle++; }
    if (headEnd < 0) {
      headEnd = indexOfSeq(raw, enc.encode("\r\n\r\n"));
      if (headEnd >= 0) { const m = /content-length:\s*(\d+)/i.exec(dec.decode(raw.slice(0, headEnd))); if (m) need = headEnd + 4 + Number(m[1]); }
    }
    if (headEnd >= 0 && need >= 0 && raw.length >= need) break;   // full body received
    if (headEnd >= 0 && need < 0 && idle > 160) break;            // no content-length: idle after data = done
    if (idle > 400) break;                                        // give up if the guest never answers
    await sleep(2);
  }

  let status = 200, headers = {}, body = raw;
  if (headEnd >= 0) {
    const lines = dec.decode(raw.slice(0, headEnd)).split("\r\n");
    const ms = /HTTP\/\d\.\d (\d+)/.exec(lines[0] || ""); if (ms) status = Number(ms[1]);
    for (const l of lines.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    body = raw.slice(headEnd + 4);
  }
  self.postMessage({ type: "served", id, status, headers, body, disk: diskStats && { ...diskStats } }, [body.buffer]);
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === "open") open(d).catch((err) => self.postMessage({ type: "error", error: String((err && err.stack) || err) }));
  else if (d.type === "serve") serve(d.id, d.method, d.path);
};
