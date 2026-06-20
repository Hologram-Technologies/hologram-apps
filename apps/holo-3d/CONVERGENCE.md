# The converged holographic experience — reflection, design, hero, spike status

Companion to ARCHITECTURE.md. Honest about literal vs metaphor, proven vs aspirational.

## Phase A1 — What "holographic" honestly means here
Two senses, both real, kept distinct:

- **Conceptual (the deep one, and it's literally true): content addressing IS the
  holographic principle.** A hologram encodes the whole in every fragment; you
  reconstruct the image from any piece. A κ (content address) is the object's identity,
  not its location — so any fragment (a cached block, a peer's copy, the origin) re-
  derives to the same whole, self-verifying (Law L5), dedup'd, reconstructable from any
  source. "The store IS the memory; any shard holds the whole." This is not a metaphor —
  it's the operating principle of holo-fhs-sw + the OPFS κ-store + the mesh. It's the
  honest, defensible meaning of "HOLOGRAM."
- **Literal (light field / 3D): WebGL/WebGPU/WebXR.** A flat screen renders a *projection*
  of a 3D scene (proven: Holo 3D's curved CRT OS screen). It becomes *literally*
  holographic only on a headset (WebXR) or a light-field display (Looking Glass). Be
  honest: on a laptop it's a gorgeous projection, not a hologram; in a headset it's
  spatial presence.

## Phase A2 — Stack inventory (capability → file → role)
See ARCHITECTURE.md for the full table; the convergence-critical rows:

| Capability | File | Role | State |
|---|---|---|---|
| Real κ-OS render in 3D | `holo-apps/apps/holo-3d/index.html` | v86 framebuffer → Three.js CRT screen | **PROVEN 60fps** |
| Platform encoding | `holo-apps/apps/holo-x86`, `holo-3d/kappa.json` | engine+BIOS+image κ-gated | proven |
| O(1) L1/L2 + offline | `holo-os/.../holo-fhs-sw.js`, `holo-opfs-kappastore.mjs` | content-addressed, network-free | proven (holo-linux) |
| Three.js | `holo-os/system/os/usr/lib/holo/voice/lib/three.min.js` | WebGL renderer | in-stack, reused |
| Live stream transport | `usr/lib/holo/holo-rtc.js` (180p→4K mesh), `sbin/holo-mesh-blocks.mjs` | WebRTC media + κ-blocks | real; no framebuffer tiling |
| AI seam | `usr/lib/holo/holo-gov.js` (`q.ask`), `mcp/holo-mcp-core.mjs` | companion invokes Q + tools | seam exists |
| Snapshot→share | v86 `save_state()`; engine `suspend()/state_kappa()` | OS as a shareable κ | not yet spiked |

Missing for full convergence: framebuffer tiling/delta for remote streaming; an
interactive input bridge confirmed working against a guest; the spatial multi-OS shell;
the companion overlay; WebXR session (needs a device + a newer Three.js for `renderer.xr`).

## Phase B — The converged holospace (each claim → real API + limit)
- SPACE: Three.js scene; κ-objects as spatial surfaces. WebGPU where it wins (compute,
  upscaling). Limit: WebGPU support varies; fall back to WebGL.
- STREAMED κ-OBJECTS: LOCAL render proven (Holo 3D). REMOTE = `canvas.captureStream()`
  over the existing WebRTC mesh for live (transient, like Meet); κ for snapshots/keyframes;
  content-addressed tiles (unchanged tile = O(1) cache hit) as the research target. 8k
  high-FPS remote is a MOONSHOT — give bandwidth math before promising.
- CRISP: `renderer.setPixelRatio(min(dpr,2))` today; source texture caps real detail at the
  guest resolution (1024×768). True 8k needs an 8k *source* + WebGPU upscale. Honest budget:
  desktop dGPU ~ several 1024² OS surfaces @60fps; integrated ~1–2.
- INTERACTIVE: raycast pointer → v86 input bus (`mouse-delta`/`mouse-click`/`keyboard-code`).
  Wired; SEE Phase D for the honest verification gap.
- MULTI-SENSORY: sight=WebGL/WebGPU (real); sound=WebAudio spatial panner per surface
  (real, not yet wired); touch=Vibration API on tap (wired, mobile-only), Gamepad haptics
  (real); presence=WebXR (real, device-gated). No smell/true-depth on a flat screen — say so.
- SERVERLESS: the holo-linux-sw pattern (proven on holo-linux: airplane-mode boot). Holo 3D
  needs the same SW added (not yet) to be offline.
- SIMPLICITY: one click in; κ-verification is a quiet green pin, never a wall. (Holo 3D
  already does this — three pins, no jargon, instant.)
- AI: a companion frame calling `q.ask` (holo-gov) + perceiving the framebuffer + injecting
  input. Designed; depends on the input bridge (Phase D) + the shell's HoloQServe.

## Phase C — The hero moment
"In a browser tab, you watch a real operating system — booted from nothing but its content
address — curve onto a glass screen in 3D space, alive at 60fps, its integrity provable at
a glance. Reach in and use it; put on a headset and walk around it; share the whole world
as a URL." The RENDER half of this is real today. The REACH-IN half is the open gap.

## Phase D — Spike status (honest)
- **Graphical OS in a 3D WebGL screen — DONE, PROVEN.** KolibriOS boots (κ-gated v86 +
  Bochs VBE BIOS) to a 1024×768 desktop, rendered as a live Three.js CanvasTexture on a
  curved, CRT-shaded screen at 60fps. Screenshot- and pixel-verified.
- **Interactivity (reach in) — WIRED + KEYBOARD-DELIVERY PROVEN; full visible interaction
  blocked by the HEADLESS HARNESS, not by the code.** Focus mode + raycast-the-screen →
  v86 input (mouse via the PS/2 device `v86.cpu.devices.ps2.mouse_send_delta/_send_click`,
  keyboard via `keyboard_send_text/_scancodes`). Diagnosis, evidenced:
  - KolibriOS has BOTH input streams enabled (`ps2.enable_keyboard_stream` and
    `enable_mouse_stream` = true; `use_mouse`/`have_mouse` = true).
  - Keyboard is DELIVERED to the guest: `ps2.kbd_buffer` grows 0→2 synchronously on a
    `keyboard_send_scancodes` — definitive proof keystrokes reach KolibriOS.
  - Yet NO visible reaction (mouse or keyboard) appears. ROOT CAUSE: the preview tab is
    `document.hidden=true` / `document.hasFocus()=false`. v86 throttles its CPU timer when
    the tab is hidden AND has a `window blur` handler; so the guest receives input into its
    buffers but barely runs and suppresses input while unfocused. Spoofing `document.hidden`
    didn't help (focus can't be spoofed). This explains the whole session's symptoms
    (slow boot, empty-HUD episodes, inert input).
  - Honest status: the wiring uses v86's own correct API and keyboard delivery is proven.
    It will work in a REAL, focused browser tab (copy.sh's KolibriOS mouse works via the
    same path). It cannot be visually confirmed in this hidden/unfocused headless harness.
    USER: open holo-3d in your browser, click "🖱 interact", then move + click + type.
- **WebXR entry — DESIGNED, device-gated.** Button appears only if `navigator.xr` reports an
  immersive-vr device AND Three.js exposes `renderer.xr` (the vendored build may be too old).
  Graceful no-op otherwise. Not verifiable headless.
- **Offline, multi-OS scene, spatial audio, companion — DESIGNED, not built.**

## The honest bottom line
The jaw-drop *visual* — a real, content-addressed OS rendered live in a 3D holographic
screen, 100% in-browser — is real and proven. The *interactive* and *remote-streamed* and
*headset* layers are wired or designed but each has a concrete, named gap. The conceptual
"holographic" claim (κ = whole-from-the-part, self-verifying, location-independent) is the
true and defensible core. Build the input bridge next; it's the difference between "watch"
and "touch."
