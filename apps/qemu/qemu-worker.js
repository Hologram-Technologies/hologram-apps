// qemu-worker.js — the "QEMU" holospace workload worker.
//
// Runs REAL QEMU (qemu-system-x86_64) off the main thread as a κ-addressed Wasm
// code module over the hologram host ABI — the ADR-008 execution surface (CC-6),
// booted by the holospaces engine itself (wasmi in the browser). QEMU is a
// *workload*, not the engine: it is "authoring a program" (ADR-004/008), so this
// is not the emulator path (os-worker.js) and not the Emscripten qemu-wasm build
// (which binds a browser/WASI host and bypasses the substrate — ADR-009 refuses
// it, Law L1/CC-5). The holospace IS the machine — no server boots QEMU (Law L1/L4).
//
// The console is the holospace's terminal channel (CC-11): QEMU runs with
// `-nographic`/`-serial` so the guest's COM1 is the console; we stream the
// `terminal_delta()` to the xterm.js front-end (ADR-010) and forward keystrokes
// back through `feed_input()`. The guest disk is a κ-addressed block device (CC-7);
// guest networking is virtio/slirp → the userspace NAT → a WebSocket relay (CC-16).
//
// Artifacts (produced by build-qemu-wasm.sh in CI/devcontainer — see QEMU-HOLOSPACE.md):
//   qemu-system-x86_64.cc6.wasm   real QEMU compiled to wasm32 over the host ABI
//   qemu-guest.img.gz             the x86-64 guest disk (gzipped raw/qcow2)
// Optional warm-start (κ snapshot, CC-30/CC-31) — instant resume, O(1) not cold boot:
//   ./qemu-snapshot.bin.gz        shipped alongside the site, or
//   <OPFS>/qemu-snapshot.bin.gz   persisted from a previous session
//
// Protocol (main <-> worker): identical to os-worker.js, so qemu.html drives this
// worker with the same message shapes.
//   main -> worker:  {type:'stdin',  data:Uint8Array}   raw keystrokes
//                    {type:'suspend'}                    snapshot -> OPFS (CC-30)
//   worker -> main:  {type:'status', text} | {type:'booted'} | {type:'stdout', data}
//                    {type:'mips', mips} | {type:'suspended'} | {type:'halt', reason}
//                    {type:'error', text, hint?}

// `?v=` busts the HTTP cache when the wasm peer is rebuilt. Bump on each peer build.
import init, {
  validate_userland,
  // The interactive userland Workspace is the engine seam this holospace needs
  // (see QEMU-HOLOSPACE.md "Staged work"): the emulator Workspace's
  // run/terminal_delta/feed_input/suspend surface, backed by a ContainerRuntime-
  // spawned CC-6 module instead of the ISA core. It is built **in-tree** in the
  // product crate crates/holospaces-web/src/lib.rs (kept in hologram-os for now,
  // not pushed upstream). `boot_userland` exists today but is a one-shot
  // boot→suspend→resume→terminate proof, not an interactive session, so we import
  // it conditionally and report honestly when the interactive form is absent.
  // (Optional chaining on the namespace below keeps this loadable now.)
} from "./pkg/holospaces_web.js?v=rv2";
import * as engine from "./pkg/holospaces_web.js?v=rv2";

const Q = new URLSearchParams(self.location.search);
// The QEMU machine type (QEMU's own -M flag): q35 (modern PCIe) or pc (i440fx).
const MACHINE = Q.get("machine") === "pc" ? "pc" : "q35";
// Guest RAM, MiB. Tunable via ?mem=<MiB>; 512 is a sane default beside the module
// and disk in the wasm32 address space.
const MEM_MIB = parseInt(Q.get("mem") || "512", 10);
// Egress relay for guest networking (CC-16, ADR-014). Absent → boot without net.
const RELAY_URL = Q.get("relay") || "";

// Default is the real QEMU artifact (404 until built → the honest "not built yet"
// state). `?module=<url>` overrides it — e.g. ?module=./cc6-fixture.wasm boots the
// CC-6 ABI conformance guest (the executable contract), proving the pipeline today.
const MODULE_URL = Q.get("module") || "./qemu-system-x86_64.cc6.wasm";
const DISK_URL = Q.get("disk") || "./qemu-guest.img.gz";
const SHIPPED_SNAPSHOT_URL = "./qemu-snapshot.bin.gz";
const OPFS_SNAPSHOT = "qemu-snapshot.bin.gz";

// Adaptive tick (identical model to os-worker.js): aim each run() chunk at
// ~TARGET_MS so the worker yields ~once per frame for input + the relay pump.
const TARGET_MS = 8;
let budget = 2_000_000;

const status = (text) => postMessage({ type: "status", text });
const fail = (text, hint) => postMessage({ type: "error", text, hint });

const fetchBytes = async (url) => {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  return new Uint8Array(await resp.arrayBuffer());
};
const exists = async (url) => {
  try { return (await fetch(url, { method: "HEAD" })).ok; } catch { return false; }
};
const gunzip = async (bytes) =>
  new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const gzip = async (bytes) =>
  new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

// ── OPFS warm-snapshot persistence (CC-30/CC-31) ──────────────────────────────
async function opfsRead(name) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name);
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

const BUILD_HINT =
  "Run build-qemu-wasm.sh (in the devcontainer/CI) to produce qemu-system-x86_64.cc6.wasm + qemu-guest.img.gz, then reload.";

let ws = null;            // the running interactive userland Workspace
const pendingInput = [];  // keystrokes that arrived before boot finished

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "stdin") {
    if (ws) ws.feed_input(msg.data);
    else pendingInput.push(msg.data);
  } else if (msg.type === "suspend") {
    if (!ws || typeof ws.suspend !== "function") {
      postMessage({ type: "status", text: "snapshot not supported yet" });
      return;
    }
    try {
      const pack = await gzip(ws.suspend());
      await opfsWrite(OPFS_SNAPSHOT, pack);
      postMessage({ type: "suspended" });
    } catch (err) {
      fail(`suspend: ${err && err.message}`);
    }
  }
};

(async () => {
  try {
    status("loading engine…");
    await init(new URL("./pkg/holospaces_web_bg.wasm?v=rv2", import.meta.url));

    // The interactive userland Workspace is built in-tree (crates/holospaces-web/
    // src/lib.rs) and exported by the peer. This guard is the no-false-green
    // fallback for an older pkg that predates it — then we say so plainly.
    const UserlandWorkspace = engine.UserlandWorkspace;
    if (!UserlandWorkspace || typeof UserlandWorkspace.boot !== "function") {
      fail(
        "interactive userland Workspace not in this engine build yet.",
        "The engine exposes validate_userland (the CC-6 gate) and boot_userland (a " +
          "one-shot boot→suspend→resume proof), but not the interactive " +
          "run/terminal_delta/feed_input surface QEMU needs. That seam is built " +
          "in-tree in the product crate crates/holospaces-web/src/lib.rs (kept in " +
          "hologram-os for now; see QEMU-HOLOSPACE.md → Staged work). The front-end, " +
          "the build recipe (build-qemu-wasm.sh), and the witness are ready to consume it.",
      );
      return;
    }

    // ── Fetch + verify the QEMU module against the CC-6 host-ABI surface ────────
    // validate_userland is the real engine gate (lib.rs): spec-valid WebAssembly
    // that imports ONLY the hologram host ABI and presents the container ABI.
    // Emscripten/WASI-bound QEMU is refused here — that is the whole point.
    status("fetching the CC-6 module…");
    let moduleBytes;
    try {
      moduleBytes = await fetchBytes(MODULE_URL);
    } catch (err) {
      if (err.status === 404) return fail("QEMU module not built yet.", BUILD_HINT);
      throw err;
    }
    status("validating module against the CC-6 host-ABI surface…");
    try {
      validate_userland(moduleBytes); // throws if it binds WASI / a browser host
    } catch (err) {
      return fail(
        "the module is not a valid CC-6 userland.",
        "validate_userland refused it: " + (err && err.message ? err.message : err) +
          "\nIt must import only the hologram host ABI (not WASI/Emscripten) and present " +
          "the container ABI — rebuild against the host-ABI sysroot.",
      );
    }
    // The disk is optional: gunzipped if present, empty otherwise (the ABI fixture
    // needs none; real QEMU's guest image is fetched here once it is built).
    let disk = new Uint8Array(0);
    try {
      disk = await gunzip(await fetchBytes(DISK_URL));
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    // ── Warm start: resume QEMU+guest from a κ snapshot (O(1), CC-30/CC-31) ─────
    let warm = false;
    for (const src of [
      { get: () => opfsRead(OPFS_SNAPSHOT) },
      { get: async () => ((await exists(SHIPPED_SNAPSHOT_URL)) ? fetchBytes(SHIPPED_SNAPSHOT_URL) : null) },
    ]) {
      try {
        const packed = await src.get();
        if (!packed) continue;
        status("restoring warm snapshot…");
        // The module is content (re-fetched/verified), not carried in the snapshot;
        // the snapshot is the guest's linear memory at an hg_event boundary.
        ws = UserlandWorkspace.resume(moduleBytes, await gunzip(packed));
        warm = true;
        break;
      } catch (_) { /* corrupt/absent → fall through to cold boot */ }
    }

    // ── Cold boot: spawn QEMU through the engine over the interpreter engine,
    //    with the same QEMU command line the Debian wiki documents, minus KVM:
    //    -machine <q35|pc> -m <MEM> -nographic -serial mon:stdio
    //    -drive file=<κ-disk> -netdev user → the NAT/relay (CC-16). ───────────────
    if (!warm) {
      status(`powering on QEMU (${MACHINE}, ${MEM_MIB} MiB, TCG)…`);
      const argv = [
        "qemu-system-x86_64",
        "-machine", MACHINE,
        "-m", String(MEM_MIB),
        "-nographic",
        "-serial", "mon:stdio",
        "-drive", "file=guest.img,format=raw,if=virtio",
        ...(RELAY_URL ? ["-netdev", "user,id=n0", "-device", "virtio-net-pci,netdev=n0"] : []),
      ];
      // argv is newline-joined for the wasm-bindgen boundary (one arg per line).
      ws = UserlandWorkspace.boot(moduleBytes, argv.join("\n"), disk, MEM_MIB * 1024 * 1024, RELAY_URL);
    }

    for (const buf of pendingInput) ws.feed_input(buf);
    pendingInput.length = 0;

    const bootStart = performance.now();
    postMessage({ type: "booted" });

    // The same un-throttled zero-delay yield os-worker.js uses, so the run loop
    // stays continuous in ~TARGET_MS chunks while the event loop still runs
    // between chunks (deliver stdin, pump the relay).
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
        return fail(`run: ${err && err.message ? err.message : err}`);
      }
      instret += budget;

      const dt = performance.now() - t0;
      if (dt > 0.1) budget = Math.max(100_000, Math.min(80_000_000, Math.round((budget * TARGET_MS) / dt)));

      const out = ws.terminal_delta();
      if (out.length) postMessage({ type: "stdout", data: out }, [out.buffer]);

      const now = performance.now();
      if (now - lastReport > 400) {
        postMessage({ type: "mips", mips: instret / ((now - bootStart) / 1000) / 1e6 });
        lastReport = now;
      }

      if (halted) postMessage({ type: "halt", reason: "the guest powered off" });
      else scheduleTick();
    };
    tick();
  } catch (err) {
    fail(String(err && err.message ? err.message : err));
  }
})();
