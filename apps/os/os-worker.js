// os-worker.js — the "OS" holospace VM worker.
//
// Boots a REAL arm64 Debian devcontainer off the main thread on the holospaces
// system emulator (ADR-009), so the tab stays responsive while the kernel boots
// and the shell runs. This is the ADR-011 devcontainer path verbatim: a real,
// unmodified Linux 6.6 arm64 kernel mounts a Debian `ext4` rootfs over the
// emulator's `virtio-blk` device, with `virtio-net` tunnelled to a relay
// (ADR-014) so `apt` / `git` reach the internet from the tab. The holospace
// itself IS the machine — no server boots the OS (Law L1/L4).
//
// The console is the holospace's terminal channel (CC-11): we stream
// `Workspace.terminal_delta()` to the xterm.js front-end (ADR-010) and forward
// its keystrokes back through `Workspace.feed_input()` — a real tty, so the
// guest's own line discipline echoes, edits, and raises SIGINT on Ctrl-C.
//
// Artifacts (produced by scripts/build-os-debian-arm64.sh, staged into this
// web dir by the build — see OS-HOLOSPACE.md):
//   os-kernel.gz        a real arm64 Linux Image, gzipped
//   os-rootfs.tar.gz    a Debian arm64 OCI image layer (tar+gzip)
// Optional warm-start (κ snapshot, CC-30) — instant shell, O(1) instead of a
// cold boot:
//   ./os-snapshot.bin.gz          shipped alongside the site, or
//   <OPFS>/os-snapshot.bin.gz     persisted from a previous session
//
// Protocol (main <-> worker):
//   main -> worker:  {type:'stdin',  data:Uint8Array}   raw keystrokes
//                    {type:'suspend'}                    snapshot -> OPFS (CC-30)
//   worker -> main:  {type:'status', text}              boot progress
//                    {type:'booted'}                     machine running
//                    {type:'stdout', data:Uint8Array}    console delta
//                    {type:'mips',   mips}               live throughput
//                    {type:'suspended'}                  snapshot persisted
//                    {type:'halt',   reason}             guest powered off
//                    {type:'error',  text, hint?}        fatal

// `?v=` busts the HTTP cache when the wasm peer is rebuilt (holo-serve sends no
// cache headers, so browsers heuristically cache pkg/*). Bump on each peer build.
import init, { DevcontainerImage, Workspace, Aarch64Workspace } from "./pkg/holospaces_web.js?v=rv10";

const Q = new URLSearchParams(self.location.search);
// The guest ISA (ADR-021). riscv64 runs on the RISC-V core (CC-14/CC-16) — the
// engine's COMPLETE in-browser core (streamed κ-disk + snapshot, boots to a shell);
// aarch64 (CC-36/CC-37) boots into kernel init but currently stalls in-browser on a
// V8/TurboFan JIT frontier (see OS-HOLOSPACE/memory), so it is opt-in (`?arch=aarch64`).
// Default riscv64 — the foundation that actually boots.
const ARCH = Q.get("arch") === "aarch64" ? "aarch64" : "riscv64";
// Init flavor: a real OCI base (Debian — its own /bin/bash + glibc + coreutils,
// CC-42) with the REAL_IMAGE_INIT, which execs `/bin/bash -l`. The default OS
// holospace ships **Debian 13 (trixie) riscv64** + a login overlay
// (os-overlay.tar.gz: an /etc/profile.d gate that adds a `holo` user on first boot
// and `exec`s a login loop → `su -l holo`) → a real holo/holo sign-in prompt.
// `?img=busybox` selects the static-busybox init (CC-22) instead.
const REAL_IMG = Q.get("img") !== "busybox";
// An optional second OCI layer overlaid on the base rootfs (lowest-first): the OS
// holospace uses it to add a real user + the login launcher (real userspace sign-in)
// without rebuilding the base image. 404 → no overlay (plain shell).
const OVERLAY_URL = "./os-overlay.tar.gz";
// The relay is passed in the worker URL query (so the worker can read it without
// a round-trip). Absent → boot without networking. NOTE the AArch64 core's
// virtio-net is the continued engine build, so arm64 ignores the relay today.
const RELAY_URL = (ARCH === "riscv64" && Q.get("relay")) || "";
// Per-TAB session id (from os.html). OPFS hands a κ-disk file to one tab at a time,
// so each tab namespaces its own disk/snapshot files → multiple tabs each run an
// INDEPENDENT machine without contending. Sanitized; defaults to a shared slot.
const SID = (Q.get("sid") || "default").replace(/[^a-z0-9]/gi, "").slice(0, 16) || "default";

const KERNEL_URL = "./os-kernel.gz";
const ROOTFS_URL = "./os-rootfs.tar.gz";
const SHIPPED_SNAPSHOT_URL = "./os-snapshot.bin.gz";
const OPFS_SNAPSHOT = `os-snapshot-${SID}.bin.gz`;
// The substrate-native lean path (ADR/CC-50, CC-9.d): the rootfs ext4 is streamed
// sparsely into an OPFS file, then the κ-disk pages its sectors off the wasm heap
// from an OPFS pack — so a real (even multi-GiB) disk boots beside guest RAM
// without holding the image in wasm memory ("the KappaStore IS the memory").
const OPFS_ROOTFS = `os-rootfs-${SID}.ext4`;
const OPFS_DISK_PACK = `os-disk-${SID}.kpack`;
// Stream the disk off-heap (riscv64 non-net dev box). ?stream=0 forces the legacy
// flat in-RAM disk (for an A/B memory comparison).
const STREAMED = ARCH === "riscv64" && !RELAY_URL && Q.get("stream") !== "0";
// The OCI layer media type — the in-crate Layer Assembler gunzips + untars it.
const LAYER_MEDIA = "application/vnd.oci.image.layer.v1.tar+gzip";
// The writable ext4 disk the OS gets to work in. With the lazy + **sparse** κ-disk,
// boot time AND wasm-heap cost are independent of this size — the disk lives in a
// sparse, deduped, disk-backed OPFS pack, and the in-RAM index holds only the
// touched non-zero sectors. So 1 GiB is a comfortable default (witnessed booting in
// ~9 s at a ~540 MB heap; 2 GiB works the same). The ceiling is ~3 GiB: a 4 GiB
// capacity overflows the disk's 32-bit (wasm32) byte length. Tunable via ?disk=.
// Clamp to [16, 3072] MiB: a 4 GiB capacity overflows the disk's 32-bit byte
// length on wasm32 (silent wrap → unmountable), so cap well below it.
const DISK_MIB = Math.max(16, Math.min(3072, parseInt(Q.get("disk") || "1024", 10) || 1024));
const DISK_BYTES = DISK_MIB * 1024 * 1024;

// Adaptive tick: aim each `run()` chunk at ~TARGET_MS of wall time, so the
// worker yields to deliver stdin (and let the relay WebSocket pump host bytes)
// about once per frame — native-class input latency — while per-chunk overhead
// stays negligible. `budget` is the instruction count, steered toward the target.
const TARGET_MS = 8;
let budget = 2_000_000; // initial guess; converges within a few ticks

const status = (text) => postMessage({ type: "status", text });

const fetchBytes = async (url) => {
  // no-store: the kernel/rootfs artifacts are swapped during dev; always fetch the
  // current bytes rather than a heuristically-cached copy (holo-serve sets no
  // cache headers). In production these are content-addressed and immutable.
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  return new Uint8Array(await resp.arrayBuffer());
};
const exists = async (url) => {
  try { return (await fetch(url, { method: "HEAD" })).ok; } catch { return false; }
};
// Decompress / compress gzip with the platform's native streams (no deps).
const gunzip = async (bytes) =>
  new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const gzip = async (bytes) =>
  new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

// ── OPFS warm-snapshot persistence (CC-30) ────────────────────────────────
async function opfsRead(name) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name); // throws if absent
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch { return null; }
}
async function opfsWrite(name, bytes) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  const ws = await fh.createWritable();
  await ws.write(bytes);
  await ws.close();
}
// A worker-only synchronous access handle (the κ-disk's off-heap backing). OPFS
// allows only ONE access handle per file across the whole origin, so after a reload
// or reboot the *previous* worker's handle can still be releasing — retry briefly
// while it does. If it never frees (another Hologram OS tab holds it), surface a
// clear, actionable error rather than a cryptic DOMException + boot flicker.
async function opfsSyncHandle(name, truncate) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  let lastErr;
  for (let i = 0; i < 40; i++) { // ~8s of retries (a terminated worker frees its handle within ~1s)
    try {
      const h = await fh.createSyncAccessHandle();
      if (truncate) h.truncate(0);
      return h;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw Object.assign(new Error(`the OPFS disk file "${name}" is locked by another session`), { opfsLocked: true, cause: lastErr });
}
// Delete a stale OPFS file so the next sync handle starts from a brand-new file
// (never inherits a prior session's size/holes). No-op if absent; throws (ignored)
// only if a handle is still open — which never happens on a fresh page load, since
// the prior worker was terminated.
async function opfsRemove(name) {
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(name); } catch (_) {}
}
// Open the persisted rootfs ext4 as a sync handle for a streamed warm-resume — but
// only if it actually exists and is non-empty (a prior cold boot wrote it). Returns
// null otherwise, so the caller cold-boots instead of resuming over a blank disk.
async function openExistingRootfs() {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(OPFS_ROOTFS); // no create → throws if absent
    const h = await fh.createSyncAccessHandle();
    if (h.getSize() === 0) { h.close(); return null; }
    return h;
  } catch (_) { return null; }
}
// Garbage-collect dead sessions' κ-disks so multi-tab use doesn't leak OPFS. A
// session's disk-pack handle is held for the machine's whole life, so a pack that
// `removeEntry` CAN delete (no open handle) belongs to a closed tab → drop its
// rootfs + snapshot too. A live tab holds its pack → removeEntry throws → we leave
// that whole session untouched. Never touches THIS session's files.
async function sweepDeadSessions() {
  try {
    const root = await navigator.storage.getDirectory();
    const others = [];
    for await (const name of root.keys()) {
      const m = /^os-disk-(.+)\.kpack$/.exec(name);
      if (m && m[1] !== SID) others.push(m[1]);
    }
    for (const sid of others) {
      try {
        await root.removeEntry(`os-disk-${sid}.kpack`); // throws if a live tab holds it
        try { await root.removeEntry(`os-rootfs-${sid}.ext4`); } catch (_) {}
        try { await root.removeEntry(`os-snapshot-${sid}.bin.gz`); } catch (_) {}
      } catch (_) { /* live tab — leave its session alone */ }
    }
  } catch (_) {}
}

let ws = null;            // the running Workspace
let wasmMod = null;       // the wasm module exports (for memory.buffer.byteLength)
const pendingInput = [];  // keystrokes that arrived before boot finished
const wasmMemBytes = () => (wasmMod && wasmMod.memory ? wasmMod.memory.buffer.byteLength : 0);

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "stdin") {
    if (ws) ws.feed_input(msg.data);
    else pendingInput.push(msg.data);
  } else if (msg.type === "suspend") {
    if (!ws) return;
    if (typeof ws.suspend !== "function") {
      postMessage({ type: "status", text: "snapshot not supported on this ISA yet" });
      return;
    }
    try {
      const pack = await gzip(ws.suspend());
      await opfsWrite(OPFS_SNAPSHOT, pack);
      postMessage({ type: "suspended" });
    } catch (err) {
      postMessage({ type: "error", text: `suspend: ${err && err.message}` });
    }
  }
};

(async () => {
  try {
    status("loading machine…");
    wasmMod = await init(new URL("./pkg/holospaces_web_bg.wasm?v=rv10", import.meta.url));
    await sweepDeadSessions(); // GC closed tabs' κ-disks (multi-tab: each tab is its own machine)

    // ── Warm start: resume a booted machine from a κ snapshot (O(1)). Prefer a
    //    session-persisted OPFS snapshot, then a shipped one. (CC-30 is the
    //    RISC-V core's today; the AArch64 core's snapshot is the continued build.)
    let warm = false;
    if (ARCH === "riscv64") {
      for (const src of [
        { kind: "opfs", get: () => opfsRead(OPFS_SNAPSHOT) },
        { kind: "shipped", get: async () => ((await exists(SHIPPED_SNAPSHOT_URL)) ? fetchBytes(SHIPPED_SNAPSHOT_URL) : null) },
      ]) {
        try {
          const packed = await src.get();
          if (!packed) continue;
          status("restoring warm snapshot…");
          const snap = await gunzip(packed);
          if (STREAMED) {
            // The content-addressed snapshot carried only the touched disk delta +
            // sparse RAM; the lazy κ-disk resumes by re-attaching the persisted
            // rootfs (untouched sectors page from it). Requires a real os-rootfs.ext4
            // from a prior cold boot — else fall through and cold-boot instead.
            const rootfsH = await openExistingRootfs();
            if (!rootfsH) continue;
            ws = Workspace.resume_devcontainer_streamed(snap, rootfsH);
          } else {
            ws = Workspace.resume_devcontainer(snap);
          }
          warm = true;
          break;
        } catch (_) { /* corrupt/absent → fall through to the next source / cold boot */ }
      }
    }

    // ── Cold boot: fetch the kernel + Debian rootfs layer, assemble the ext4
    //    rootfs, boot it on the emulator over virtio-blk (the AArch64 or RISC-V
    //    core per ARCH; both ride the same substrate device bus, Law L4). ──
    if (!warm) {
      status("fetching kernel + Debian rootfs…");
      let kernelGz, layer;
      try {
        [kernelGz, layer] = await Promise.all([fetchBytes(KERNEL_URL), fetchBytes(ROOTFS_URL)]);
      } catch (err) {
        if (err.status === 404) {
          postMessage({
            type: "error",
            text: "OS image not built yet.",
            hint: "Run build-os-debian-arm64.sh (in the devcontainer/CI) to produce os-kernel.gz + os-rootfs.tar.gz, then reload.",
          });
          return;
        }
        throw err;
      }
      const kernel = await gunzip(kernelGz);

      status("assembling root filesystem…");
      const image = new DevcontainerImage();
      image.add_layer(LAYER_MEDIA, layer); // the assembler gunzips + untars it
      // Overlay (lowest-first wins on top): the real-user + login launcher, so the
      // booted OS presents a real sign-in prompt. Absent (404) → plain shell.
      try {
        const overlay = await fetchBytes(OVERLAY_URL);
        image.add_layer(LAYER_MEDIA, overlay);
        status("applying login overlay (real userspace sign-in)…");
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      if (STREAMED) {
        // ── Substrate-native lean path (CC-50, CC-9.d) ──────────────────────
        // Stream the bootable ext4 *sparsely* into an OPFS file (only non-zero
        // blocks written; no dense buffer in wasm RAM), then page the κ-disk off
        // the wasm heap from an OPFS pack — so even a multi-GiB disk boots beside
        // guest RAM. The /init mounts the pseudo-fs + 9p workspace and execs a
        // login shell (REAL_IMAGE_INIT; /bin/sh works for busybox + Debian alike).
        // Start from brand-new OPFS files (don't inherit a prior session's image).
        await opfsRemove(OPFS_ROOTFS);
        await opfsRemove(OPFS_DISK_PACK);
        const rootfsH = await opfsSyncHandle(OPFS_ROOTFS, true);
        status("provisioning κ-disk into OPFS (sparse, off-heap)…");
        image.assemble_bootable_into_opfs(rootfsH, DISK_BYTES, REAL_IMG);
        const diskH = await opfsSyncHandle(OPFS_DISK_PACK, true);
        status(`powering on (${ARCH}, streamed κ-disk)…`);
        // boot_devcontainer_opfs_streamed eagerly pages the rootfs sectors into
        // the OPFS κ-store (sparse zeros skipped), then drops the rootfs handle.
        ws = Workspace.boot_devcontainer_opfs_streamed(kernel, rootfsH, diskH);
      } else {
        // ── Legacy flat path: the whole disk lives in wasm RAM (heavier). ──
        const rootfs = REAL_IMG
          ? image.assemble_bootable_real(DISK_BYTES) // debian/ubuntu own /bin/sh (CC-42)
          : image.assemble_bootable(DISK_BYTES); // static-busybox base (CC-22)
        status(`powering on (${ARCH})…`);
        ws =
          ARCH === "aarch64"
            ? Aarch64Workspace.boot_devcontainer(kernel, rootfs)
            : RELAY_URL
              ? Workspace.boot_devcontainer_net(kernel, rootfs, RELAY_URL)
              : Workspace.boot_devcontainer(kernel, rootfs);
      }
    }

    for (const buf of pendingInput) ws.feed_input(buf);
    pendingInput.length = 0;

    // On a warm resume the guest comes back blocked in `read()` (WFI) and its
    // console output buffer is not part of the snapshot, so the screen is blank and
    // the very first keystroke burst can be partly lost during the WFI wake-up. Once
    // the run loop has spun up, inject a newline to redraw the prompt and warm the
    // console input path — so the operator sees a prompt and types into a live tty.
    if (warm) setTimeout(() => { try { ws.feed_input(new TextEncoder().encode("\n")); } catch (_) {} }, 700);

    const bootStart = performance.now();
    postMessage({ type: "booted", mem: wasmMemBytes() });

    // A zero-delay yield that, unlike setTimeout(0), is not throttled to 4ms
    // after nested calls — so the run loop stays continuous in ~TARGET_MS chunks
    // and the event loop still runs between chunks (deliver stdin, pump the relay).
    const yieldChan = new MessageChannel();
    yieldChan.port1.onmessage = () => tick();
    const scheduleTick = () => yieldChan.port2.postMessage(0);

    let lastReport = bootStart;
    let instret = 0;
    const tick = () => {
      const t0 = performance.now();
      let halted = false;
      try {
        halted = ws.run(budget);
      } catch (err) {
        postMessage({ type: "error", text: `run: ${err && err.message ? err.message : err}` });
        return;
      }
      instret += budget;

      // Steer the budget toward TARGET_MS per chunk (clamped), so input latency
      // stays ~one frame regardless of the guest's current speed.
      const dt = performance.now() - t0;
      if (dt > 0.1) budget = Math.max(100_000, Math.min(80_000_000, Math.round((budget * TARGET_MS) / dt)));

      const out = ws.terminal_delta();
      if (out.length) postMessage({ type: "stdout", data: out }, [out.buffer]);

      const now = performance.now();
      if (now - lastReport > 400) {
        postMessage({ type: "mips", mips: instret / ((now - bootStart) / 1000) / 1e6, mem: wasmMemBytes() });
        lastReport = now;
      }

      if (halted) postMessage({ type: "halt", reason: "the guest powered off" });
      else scheduleTick();
    };
    tick();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const locked = (err && err.opfsLocked) || /createSyncAccessHandle|Access Handle/i.test(msg);
    postMessage({
      type: "error",
      text: locked ? "The OS disk is open in another tab." : msg,
      hint: locked
        ? "OPFS gives the κ-disk to one tab at a time. Close any other Hologram OS / os.html tabs, then press ⟳ reboot (or reload). If you just reloaded, give it a second and reboot — the previous session's disk handle is still releasing."
        : undefined,
    });
  }
})();
