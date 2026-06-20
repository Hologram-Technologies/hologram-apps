// holo-linux-worker.js — the Holo Linux boot worker.
//
// Boots a REAL riscv64 Linux 6.6 kernel on a real Debian 13 (trixie) rootfs, off
// the main thread, on the holospaces in-browser ISA core (the same engine the OS
// holospace uses — crates/holospaces-web, compiled to wasm). The holospace IS the
// machine: no server boots the kernel (Law L1/L4).
//
// What this worker adds over the plain OS path is a HARD κ-GATE (Law L5): before a
// single guest instruction runs, it re-derives the SHA-256 of the fetched kernel +
// rootfs and refuses to boot unless each matches its content address in kappa.json.
// The kernel's κ is the SAME content address pinned canonically at /boot/kernel.uor.json
// — so "anchored in the k-addressable substrate" is proven at load, not asserted.
//
// The console is the holospace's terminal channel: the guest's own serial tty is
// streamed to xterm.js via `terminal_delta()` and keystrokes go back through
// `feed_input()` — a real tty, so the guest's line discipline echoes, edits and
// raises SIGINT on Ctrl-C. Real PIDs, real syscalls hitting a real kernel.
//
// Protocol (main <-> worker):
//   main -> worker:  {type:'stdin', data:Uint8Array}     raw keystrokes
//   worker -> main:  {type:'status', text}               boot progress
//                    {type:'kappa', which, name, expected, actual, ok, canonical}
//                    {type:'booted'}                      machine running
//                    {type:'stdout', data:Uint8Array}     console delta
//                    {type:'mips', mips}                  live throughput
//                    {type:'halt', reason}                guest powered off
//                    {type:'error', text, hint?}          fatal (gate failure included)

import init, { DevcontainerImage, Workspace } from "./pkg/holospaces_web.js?v=hl1";

const Q = new URLSearchParams(self.location.search);
// Per-TAB session id: OPFS hands the κ-disk file to one tab at a time, so each tab
// namespaces its own writable disk → multiple tabs each run an INDEPENDENT machine.
const SID = (Q.get("sid") || "default").replace(/[^a-z0-9]/gi, "").slice(0, 16) || "default";
// Writable ext4 the OS works in. The κ-disk is sparse + disk-backed (OPFS), so boot
// time and wasm-heap cost are independent of this size. 1 GiB default; cap < 4 GiB
// (a 32-bit wasm byte length would wrap). Tunable via ?disk=<MiB>.
const DISK_MIB = Math.max(16, Math.min(3072, parseInt(Q.get("disk") || "1024", 10) || 1024));
const DISK_BYTES = DISK_MIB * 1024 * 1024;

const KERNEL_URL = "./os-kernel.gz";
const ROOTFS_URL = "./os-rootfs.tar.gz";
const PINS_URL = "./kappa.json";
const OPFS_ROOTFS = `hl-rootfs-${SID}.ext4`;
const OPFS_DISK_PACK = `hl-disk-${SID}.kpack`;
const LAYER_MEDIA = "application/vnd.oci.image.layer.v1.tar+gzip";

// Adaptive tick: aim each run() chunk at ~TARGET_MS so the worker yields ~once per
// frame to deliver stdin — native-class input latency — while per-chunk overhead
// stays negligible.
const TARGET_MS = 8;
let budget = 2_000_000;

const status = (text) => postMessage({ type: "status", text });
const fail = (text, hint) => postMessage({ type: "error", text, hint });

// Boot artifacts are content-addressed + immutable and the κ-gate re-derives their SHA-256 on
// EVERY boot, so the HTTP cache is safe to lean on: a stale or corrupt cached byte simply fails
// the gate (Law L5) rather than booting. "force-cache" lets repeat boots skip the network entirely
// (cold boot still downloads once). The pins themselves are fetched no-store so they stay fresh.
const fetchBytes = async (url, cache = "force-cache") => {
  const resp = await fetch(url, { cache });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  // A static host (or a SW fallback) can answer a MISSING artifact with an HTML page (its 404/index)
  // at HTTP 200 — which would then explode in JSON.parse as "Unexpected token '<'". Treat any HTML
  // body where we expect a binary/JSON artifact as a clean "missing artifact" (404), so the boot fails
  // gracefully ("Boot artifacts missing.") instead of leaking a raw parse error.
  if (/^text\/html\b/i.test(resp.headers.get("content-type") || "")) {
    throw Object.assign(new Error(`expected the artifact at ${url}, got an HTML page — it is not present on this deploy`), { status: 404 });
  }
  return new Uint8Array(await resp.arrayBuffer());
};
// Public IPFS gateways — content-addressed, NEVER trusted: gate() re-derives the whole-file sha256 below
// and refuses a mismatch (Law L5), so a wrong byte from any gateway is rejected, not booted.
const IPFS_GATEWAYS = ["https://ipfs.io", "https://dweb.link", "https://cloudflare-ipfs.com"];
// Fetch a boot artifact location-agnostically: prefer the same-origin path (dev / vendored image), else
// stream it from IPFS by its content (the κ-DAG CID pinned in kappa.json). The OS is agnostic to WHERE the
// bytes live — the κ is the only link — and the κ-gate verifies whatever source served them.
async function fetchArtifact(localUrl, ipfsCid) {
  try { return await fetchBytes(localUrl); }
  catch (e) {
    if (!ipfsCid) throw e;
    let last = e;
    for (const gw of IPFS_GATEWAYS) {
      try { return await fetchBytes(`${gw}/ipfs/${ipfsCid}`); } catch (g) { last = g; }
    }
    throw last;
  }
}
const gunzip = async (bytes) =>
  new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

// ── κ re-derivation (Law L5) ──────────────────────────────────────────────────
// The browser's own SubtleCrypto computes the content address — no engine, no
// trust. `did:holo:sha256:<hex>` is the κ; we compare it to the pin and to the
// canonical /boot pin. This is the whole point: bytes are admitted by identity.
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256hex(bytes) {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
// Verify one artifact against its κ-pin. Posts the result to the UI and THROWS on a
// mismatch — a failed gate must stop the boot, never warn-and-continue.
async function gate(which, pin, bytes) {
  status(`re-deriving κ of the ${which}…`);
  const actual = await sha256hex(bytes);
  const ok = actual === pin.sha256;
  postMessage({
    type: "kappa", which, name: pin.name,
    expected: "did:holo:sha256:" + pin.sha256,
    actual: "did:holo:sha256:" + actual,
    multibase: pin.digestMultibase, ok,
    canonical: pin.canonicalPin || null,
  });
  if (!ok) {
    throw Object.assign(
      new Error(`κ mismatch on the ${which}: the fetched bytes do not match their content address.`),
      { gate: true, which, expected: pin.sha256, actual },
    );
  }
}

// ── OPFS κ-disk helpers (the streamed, off-heap writable disk) ─────────────────
async function opfsSyncHandle(name, truncate) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  let lastErr;
  for (let i = 0; i < 40; i++) { // ~8s of retries — a terminated worker frees its handle within ~1s
    try { const h = await fh.createSyncAccessHandle(); if (truncate) h.truncate(0); return h; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  throw Object.assign(new Error(`the OPFS disk file "${name}" is locked by another session`), { opfsLocked: true, cause: lastErr });
}
async function opfsRemove(name) {
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(name); } catch (_) {}
}
// GC dead tabs' κ-disks so multi-tab use doesn't leak OPFS. A live tab holds its
// pack handle → removeEntry throws → we leave that session alone. Never touches THIS session.
async function sweepDeadSessions() {
  try {
    const root = await navigator.storage.getDirectory();
    const others = [];
    for await (const name of root.keys()) { const m = /^hl-disk-(.+)\.kpack$/.exec(name); if (m && m[1] !== SID) others.push(m[1]); }
    for (const sid of others) {
      try { await root.removeEntry(`hl-disk-${sid}.kpack`); await opfsRemove(`hl-rootfs-${sid}.ext4`); } catch (_) {}
    }
  } catch (_) {}
}

// Smallest κ-disk we'll fall back to when storage is tight — still comfortably fits the
// Debian rootfs (~70 MiB used) plus working room. Below this we surface a clear error.
const DISK_FLOOR = 384 * 1024 * 1024;
const isSpaceError = (e) => {
  const m = String((e && (e.message || e.name)) || e);
  return (e && e.name === "QuotaExceededError") || /no space|quota|insufficient|allocat/i.test(m);
};
// Best-effort: persistent storage isn't evicted under pressure and tends to grant a larger,
// stabler quota. Not available in every worker context — ignore if absent.
async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
}
// Size the κ-disk to the space actually free RIGHT NOW. OPFS shares ONE origin quota with the
// service-worker caches and every other holospace, so a fixed 1 GiB truncate fails with "No
// space available" when the origin is near quota. Fit to free space (less a safety margin),
// never below the floor; the caller still retries smaller if even this overshoots.
async function fitDiskBytes(requested) {
  try {
    const est = (await navigator.storage.estimate()) || {};
    const quota = est.quota || 0, usage = est.usage || 0;
    if (quota > 0) {
      const usable = (quota - usage) - 96 * 1024 * 1024; // keep 96 MiB headroom for fs metadata + caches
      if (usable < requested) return Math.max(DISK_FLOOR, Math.min(requested, usable));
    }
  } catch (_) {}
  return requested;
}
// Provision a fresh rootfs handle + assemble the bootable image into it. Fresh OPFS files each
// attempt, so a retry never inherits a half-written disk. Closes the handle and rethrows on
// failure so the caller can reclaim space and retry at a smaller size.
async function provisionRootfs(image, diskBytes) {
  await opfsRemove(OPFS_ROOTFS);
  await opfsRemove(OPFS_DISK_PACK);
  const h = await opfsSyncHandle(OPFS_ROOTFS, true);
  try { image.assemble_bootable_into_opfs(h, diskBytes, true); return h; } // REAL_IMG=true → execs /bin/bash -l
  catch (e) { try { h.close(); } catch (_) {} throw e; }
}

let ws = null;            // the running Workspace
const pendingInput = [];  // keystrokes that arrived before boot finished

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "stdin") { if (ws) ws.feed_input(msg.data); else pendingInput.push(msg.data); }
};

(async () => {
  try {
    status("loading the machine…");
    await init(new URL("./pkg/holospaces_web_bg.wasm?v=hl1", import.meta.url));
    await requestPersistence();
    await sweepDeadSessions();

    // ── 1. fetch the κ-pins + the two artifacts ──────────────────────────────
    status("fetching the κ-pinned kernel + Debian rootfs…");
    let pins, kernelGz, rootfsLayer;
    try {
      pins = JSON.parse(new TextDecoder().decode(await fetchBytes(PINS_URL, "no-store")));
      [kernelGz, rootfsLayer] = await Promise.all([fetchArtifact(KERNEL_URL, pins.kernel && pins.kernel.ipfs), fetchArtifact(ROOTFS_URL, pins.rootfs && pins.rootfs.ipfs)]);
    } catch (err) {
      if (err.status === 404) return fail("Boot artifacts missing.", "os-kernel.gz / os-rootfs.tar.gz / kappa.json must sit beside this worker.");
      throw err;
    }

    // Tamper test (?tamper=1): flip ONE byte of the rootfs before the gate, to prove
    // the κ-gate is real — the very next step re-derives the address and must refuse.
    if (Q.get("tamper")) {
      rootfsLayer[0] ^= 0xff;
      status("⚠ tamper test — flipped 1 byte of the rootfs; the κ-gate must now refuse it");
    }

    // ── 2. THE κ-GATE: re-derive content addresses, refuse to boot on mismatch ─
    await gate("kernel", pins.kernel, kernelGz);
    await gate("rootfs", pins.rootfs, rootfsLayer);
    status("κ verified — both artifacts match their content address.");

    // ── 3. assemble the bootable ext4 from the verified rootfs layer ──────────
    const kernel = await gunzip(kernelGz);
    status("assembling the root filesystem…");
    const image = new DevcontainerImage();
    image.add_layer(LAYER_MEDIA, rootfsLayer); // the in-engine assembler gunzips + untars it

    // ── 4. provision the κ-disk into OPFS (sparse, off-heap) and boot ─────────
    // Robust against a near-full origin quota: size the disk to the space actually free,
    // and on a "No space available" error reclaim dead sessions and retry at a smaller size
    // (down to DISK_FLOOR) rather than dying. Fresh OPFS files each attempt.
    status("provisioning the κ-disk (sparse, OPFS-backed)…");
    let diskBytes = await fitDiskBytes(DISK_BYTES);
    let rootfsH;
    for (let attempt = 0; ; attempt++) {
      try { rootfsH = await provisionRootfs(image, diskBytes); break; }
      catch (err) {
        if (isSpaceError(err) && attempt < 3 && diskBytes > DISK_FLOOR) {
          status("storage is tight — reclaiming space, retrying with a smaller κ-disk…");
          await sweepDeadSessions();
          diskBytes = Math.max(DISK_FLOOR, Math.floor(diskBytes / 2));
          continue;
        }
        throw err;
      }
    }
    const diskH = await opfsSyncHandle(OPFS_DISK_PACK, true);
    status("powering on (riscv64, streamed κ-disk)…");
    ws = Workspace.boot_devcontainer_opfs_streamed(kernel, rootfsH, diskH);

    for (const buf of pendingInput) ws.feed_input(buf);
    pendingInput.length = 0;

    const bootStart = performance.now();
    postMessage({ type: "booted" });

    // A zero-delay yield that isn't throttled to 4ms (unlike setTimeout(0)) — the
    // run loop stays continuous in ~TARGET_MS chunks, the event loop runs between
    // chunks to deliver stdin.
    const yieldChan = new MessageChannel();
    yieldChan.port1.onmessage = () => tick();
    const scheduleTick = () => yieldChan.port2.postMessage(0);

    let lastReport = bootStart, instret = 0;
    const tick = () => {
      const t0 = performance.now();
      let halted = false;
      try { halted = ws.run(budget); } catch (err) { return fail(`run: ${err && err.message ? err.message : err}`); }
      instret += budget;
      const dt = performance.now() - t0;
      if (dt > 0.1) budget = Math.max(100_000, Math.min(80_000_000, Math.round((budget * TARGET_MS) / dt)));
      const out = ws.terminal_delta();
      if (out.length) postMessage({ type: "stdout", data: out }, [out.buffer]);
      const now = performance.now();
      if (now - lastReport > 400) { postMessage({ type: "mips", mips: instret / ((now - bootStart) / 1000) / 1e6 }); lastReport = now; }
      if (halted) postMessage({ type: "halt", reason: "the guest powered off" });
      else scheduleTick();
    };
    tick();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (err && err.gate) {
      return fail(msg, `Holo Linux refuses to execute bytes that do not match their κ.\nexpected did:holo:sha256:${err.expected}\nactual   did:holo:sha256:${err.actual}`);
    }
    if (isSpaceError(err)) {
      return fail("Browser storage is full — couldn't allocate the κ-disk.",
        "OPFS shares one quota across every Holo app. Close other Holo Linux / Holo tabs (each holds its own disk) or clear this site's data, then press ⟳ reboot. You can also boot a smaller disk with ?disk=256.");
    }
    const locked = (err && err.opfsLocked) || /createSyncAccessHandle|Access Handle/i.test(msg);
    fail(locked ? "The disk is open in another tab." : msg,
      locked ? "OPFS gives the κ-disk to one tab at a time. Close other Holo Linux tabs, then press ⟳ reboot." : undefined);
  }
})();
