# κ-native OS platform substrate — architecture, inventory, and proof-spikes

Status: exploration + architecture + spikes. Honest about what's proven vs. designed
vs. moonshot. Companion to the working apps `holo-linux`, `holo-x86`, and `holo-3d`.

## Verdict up front
The vision decomposes into pieces that range from **already-shipped** to **research-grade
moonshot**. The honest spine: browser-native emulators (v86 et al.) are the OS compute +
pixels; the riscv64 κ-Linux is the orchestration spine, NOT the renderer; content
addressing is the integrity + O(1) cache layer; the existing WebRTC video mesh is the
realistic live-streaming transport; per-frame κ at 60fps is not viable (use κ for
snapshots/recordings, transient media for the hot path).

## Phase 0 — Stack inventory (capability → file → role)

| Capability | File(s) | Role in the vision |
|---|---|---|
| Platform-encoding template | `holo-apps/apps/holo-x86/{index.html,kappa.json}` | v86 engine+BIOS+image content-addressed, κ-gated, fed only verified ArrayBuffers. The pattern for Phase 1. **Proven** (boots real x86 Linux). |
| Real κ-Linux spine | `holo-apps/apps/holo-linux/` + `cli/holo-linux-cli.mjs` | riscv64 Debian, κ-gated, offline-proven; Node stdio host. The orchestration host OS. |
| O(1) L1/L2 tier | `holo-os/system/os/holo-fhs-sw.js`, `usr/lib/holo/holo-opfs-kappastore.mjs`, KCACHE | Content-addressed delivery: identical blob → one κ → network-free re-serve, dedup across apps/users. L1 = Cache Storage, L2 = OPFS κ-store. |
| Composition | `usr/share/frame/shell.html` (iframe + `HoloGov.register`), `usr/lib/holo/holo-embed.js`, engine `dial_guest/guest_send/guest_recv` (lib.rs) | Holospaces nest as sandboxed iframes + postMessage; guest-socket bridge reaches a service *inside* the guest. How platforms compose. |
| AI seam | `usr/lib/holo/holo-gov.js` (`holo-privacy:rpc`, `q.ask/q.act/q.create`, streaming deltas), `holo-privacy.js` (gate), `mcp/holo-mcp-core.mjs` (tools), `apps/q/core/agents.js` (agents as κ-objects) | The governed channel a companion uses to invoke Q + tools. **Exists**; needs perception + input-injection glue. |
| Streaming transport | `sbin/holo-webrtc-link.mjs`, `holo-mesh-blocks.mjs` (bitswap-lite), `holo-peers.mjs`, `usr/lib/holo/holo-rtc.js` (adaptive video mesh 180p→4K) | Serverless WebRTC mesh + κ-block exchange. Real for media + blocks; **no framebuffer/tile/delta model yet**. |
| Rendering | `usr/lib/holo/voice/lib/three.min.js` (Three.js, already vendored) | WebGL/Three.js already in-stack (voice viz, vanta). Reused by `holo-3d` to texture an emulator framebuffer. |
| UI kit | `/ui` (56 shadcn components via HoloRender) | Build the OS-builder + companion UI from κ-objects. |
| Snapshot/share | engine `suspend()/resume_devcontainer_streamed()/state_kappa()`; v86 `save_state()/restore_state()` | "git for whole machines": snapshot → κ → share URL → byte-identical reboot. |

## Phased architecture (feasibility × value)

- **P1 Encode the catalog as κ-objects** — feasibility HIGH, value HIGH. Generalize
  holo-x86's manifest (engine+firmware+image+bootcfg+peripherals, each κ-pinned). Per-OS
  caveat: each guest needs a known-good v86 boot config (boot device, video/VBE mode,
  serial-vs-VGA). This is the real per-platform cost — see "Image-config tax" below.
- **P2 Composition + system access** — feasibility HIGH (with honest limits), value HIGH.
  "Full local system access" = web APIs: compute = WASM+SharedArrayBuffer+Workers+WebGPU
  (cross-origin isolation already on); network = fetch/WS/WebRTC + relay-NAT
  (`boot_devcontainer_net`) + mesh; storage = OPFS κ-store + File System Access; devices =
  WebUSB/WebSerial/WebHID/WebGPU/WebAudio/gamepad. Hard limit: the browser sandbox — no raw
  kernel/hardware beyond these APIs. Emulators are browser-native peers; **do NOT run them
  inside the ~10-MIPS riscv64 guest**.
- **P3 O(1) via content addressing** — feasibility HIGH (boot artifacts), value HIGH.
  Engine/BIOS/image/snapshot blobs dedup and re-serve network-free. Measured: holo-linux's
  36 MB boot set served at `transferSize: 0` / `deliveryType: "cache"` after warm. Extends
  to snapshot/tile blobs; per-frame at 60fps does NOT (see streaming).
- **P4 AI-native (Q + companion)** — feasibility MEDIUM, value HIGH. The `holo-privacy:rpc`
  seam + MCP tools exist; a companion adds: (a) perception — read the framebuffer/canvas
  (VGA text directly; pixels via getImageData; OCR for graphical), (b) action — inject
  input (already done: v86 `keyboard_send_text`/`serial0_send`; κ-Linux via stdio host),
  (c) governance — route through holo-gov/holo-privacy. The LLM itself needs the shell's
  `HoloQServe` (absent in a standalone app) or `q.remote.*`. Clippy-style overlay = an
  iframe companion calling `q.ask`.
- **P5 Build/run/share your OS** — feasibility MEDIUM-HIGH, value HIGH. v86 `save_state()`
  → bytes → κ; share κ → `restore_state()` boots byte-identical. Compose {platform κ +
  image κ + customizations + companions + snapshot κ} into one manifest κ. Dedup makes
  sharing cheap.
- **P6 Rendering + streaming** — split:
  - LOCAL WebGL render — feasibility HIGH, value HIGH. **Proven** (holo-3d): live emulator
    canvas → Three.js CanvasTexture → barrel/CRT/scanline shader → curved 3D screen at
    60fps. 3D desktop / many OSes in one scene / 8k canvas all follow. Bound by emulator +
    GPU.
  - κ-STREAMED remote 8k/high-FPS — **MOONSHOT**. The streaming substrate today is
    content-objects + media + bitswap-lite blocks; there is **no framebuffer capture,
    tiling, or delta model**, and per-frame κ at 60fps thrashes the resolver. Realistic
    staged path: (1) live = `canvas.captureStream()` over the existing WebRTC video mesh
    (transient, like Meet, no per-frame κ); (2) κ only for snapshots/recordings/keyframes;
    (3) research: content-addressed tiles where unchanged tiles are O(1) cache hits +
    delta patches as tiny κ-blobs. Give bandwidth/latency math before promising 8k.

### Critical path & keystones
1. Generalized platform manifest + per-image boot configs (P1) — the catalog.
2. WebGL framebuffer compositor (P6 local) — **keystone, proven**.
3. Companion perception/action glue over the existing RPC seam (P4).
4. Snapshot→κ→share (P5) via v86 save_state.
Remote κ-streaming (P6b) is explicitly deferred as research.

## abeto.co (messenger.abeto.co) study
Could NOT load it — the site returns HTTP 403 (Cloudflare/auth). Not going to fabricate a
study of a page I couldn't read. At the technique level, what a WebGL/Three.js-driven
real-time experience would contribute here: GPU-composited surfaces (each OS framebuffer as
a texture), post-process shaders (CRT/bloom/curvature/retina upscaling), instanced/3D
layout of many surfaces, and `requestVideoFrameCallback`/`captureStream` for live sources —
all of which the local-render spike already exercises. Re-fetch with an authenticated tool
to extract its specific techniques.

## Proof-spikes — what's built and what each proves
- **(a) 2nd platform from a κ-manifest** — DONE. `holo-3d` encodes KolibriOS (1.44 MB) +
  the v86 engine as content-addressed, κ-gated objects beside holo-x86's Buildroot; the
  loader re-derives all five SHA-256 and feeds v86 only verified bytes (3 green κ pins).
  Proves the encoding generalizes across platforms.
- **(b) framebuffer → live WebGL/Three.js texture** — FULLY PROVEN with a graphical OS.
  `holo-3d` boots KolibriOS to its **1024×768 graphical desktop** (100% painted, 132
  distinct colours, a distinct darker taskbar band) and renders the live v86 framebuffer
  as a Three.js CanvasTexture on a curved, CRT-shaded (barrel + scanlines + vignette + glow)
  3D screen at **60 fps**. Screenshot-verified: the OS desktop with its icon clusters on a
  visibly curved screen, κ pins green. The fix that unlocked it: use the **Bochs VGA BIOS**
  (`bochs-vgabios.bin`, VBE-capable) instead of the basic `vgabios.bin`, and drop the
  `boot_order` override (let v86 default boot the floppy). This is the rendering keystone
  for the whole streamed-OS vision, proven locally. (Next: forward 3D-plane pointer/keys to
  v86 for in-scene interactivity.)
- **(c) AI companion perceiving + driving a platform** — DESIGNED, not built. Seam mapped
  (holo-gov `q.ask` + v86 input injection + canvas perception). Buildable; the LLM needs
  the shell's HoloQServe or `q.remote.*`.
- **(d) snapshot→κ→reboot-identical** — DESIGNED, not built. v86 `save_state()` →
  sha256 → κ; `restore_state()` from those bytes. Straightforward next spike.

## Honest boundaries (the spec is honesty)
- **Image-config tax (the real per-platform cost).** Each guest needs a known-good v86
  boot config. Resolved examples: Buildroot `linux4.iso` boots to a *serial* console (wire
  serial0 → xterm, as holo-x86 does); KolibriOS needs the **VBE-capable Bochs VGA BIOS**
  and NO `boot_order` override to reach its 1024×768 GUI (the basic vgabios + a bad
  boot_order left it stuck in text mode). Encoding a platform as a κ-object is cheap; the
  work is the per-OS {boot device, VGA/VBE BIOS, video mode, serial-vs-VGA} config. Budget
  it; curate a verified set.
- **κ-Linux can't host emulators** (~10 MIPS) and **can't render** (serial console only,
  no display device, engine source not even in this checkout). It is the spine, not the
  pixels.
- **Remote 8k/high-FPS κ-streaming is not a checkbox.** Local WebGL render is. Live remote
  via the existing video mesh is. Content-addressed-tile streaming at 8k is research.
- **"Full system access" = web APIs**, with the sandbox as the hard ceiling. Every claim
  above is mapped to a real API or marked as a gap.
