# Hologram — Google-free, κ-substrate-native browser build (build runbook)

## CANONICAL PATH — ungoogled-chromium overlay (Google-free, no hand-written code)

The shipping build is **ungoogled-chromium** + a thin Hologram κ overlay. ungoogled is the Google-free base
(its `domain_substitution.py` rewrites every Google domain to the unreachable `qjz9zk` sink, `prune_binaries.py`
strips proprietary blobs, and its patch set removes account/sync/telemetry — see GOOGLE-FREE.md). We add ONLY
the `holo://` scheme + one κ URLLoaderFactory (reusing the *witnessed* `kappa-route` verifier verbatim) and
the Hologram branding. No browser/UX code is written — the whole browser is upstream.

One command on a build machine/CI (≈120–150 GB disk, 16–32 GB RAM, hours):
```sh
cd holo-apps/apps/tauri/chromium-kappa/ungoogled
OS_IMAGE=../../dist  UC_TAG=149.0.7827.155-1  ./build-kappa-ungoogled.sh   # == Chromium 149.0.7827.155 (CEF parity)
# runs ungoogled's own steps verbatim (downloads.py → prune_binaries.py → patches.py → domain_substitution.py),
# then holo_kappa_overlay.py (stage verifier + bake trust root + the +6-line seams), then flags + gn + ninja.
# → out/Default/chrome  (Google-free, κ-native; OS image at out/Default/holo-os)
# verify:  chrome --holo-os-dir=out/Default/holo-os   then open  holo://os/
```
The overlay (`ungoogled/`) is what's first-party — all of it data/config/glue, none of it browser logic:
- `holo-flags.gn` — Google-free belt + κ build args (appended to ungoogled's `flags.gn`).
- `src/chrome/browser/holo/{holo_url_loader_factory.{h,cc},BUILD.gn}` — the ONE C++ unit; calls `kr_resolve`.
- `holo_kappa_overlay.py` — stages the verifier, bakes `HOLO_CLOSURE_ANCHOR`, applies the +6-line seams
  (anchor-based + idempotent; **fails loud** if a milestone moved a seam). Seam-insertion + idempotency are
  unit-tested against synthetic fixtures; the factory references only real `kappa_route.h` symbols.
- `branding/apply_branding.py` — Chromium → "Hologram OS" + H mark by string/asset substitution (no code).

Windows: use the same overlay against the **ungoogled-chromium-windows** packaging repo (it wraps the
generic steps with `build.py` + `flags.windows.gn`); run `holo_kappa_overlay.py` after its patch stage and
concatenate `holo-flags.gn` before its `gn gen`. macOS/Linux: ungoogled-chromium-macos / -portablelinux.

The detailed engine seams are in **KAPPA-INTEGRATION.md** (§1 scheme, §2–3 factory, §4 link, §5 trust root);
the Google-free guarantees + the one feature trade-off (no Widevine DRM) are in **GOOGLE-FREE.md**. The
sections below document the equivalent steps against *vanilla* `chromium.git` for reference / parity debugging.

---

# Reference — full chromium.git build, κ-substrate-native

Goal: a Chrome browser built from `chromium.git` (full `//chrome` → complete extension system + Web Store
+ authentic top bar) with the `holo://` κ-route wired natively, so **every `holo://` byte is content-
verified before render** and per-κ origins isolate holospaces — reusing the existing `kappa-route` verifier
unchanged. This is the only path to *literal 100% Chrome-extension compatibility* (CEF ships only a subset).

This build runs on a **build machine / CI** — it is not a laptop in-session task. Budget the infra.

## System requirements
- Windows 10/11 x64 (then macOS/Linux each need their own toolchain for those targets).
- Visual Studio 2022 (with "Desktop development with C++") + the Windows SDK version Chromium pins
  (check `chromium/src/build/vs_toolchain.py` for the current required SDK, e.g. 10.0.22621.x).
- Disk: **~120–150 GB** free (checkout + out/). RAM: **16–32 GB+**. Git, Python 3.
- A fast network for the initial `fetch` (tens of GB).

## P0 — toolchain + a vanilla Chrome build
```sh
# 1) depot_tools
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git C:\src\depot_tools
setx PATH "C:\src\depot_tools;%PATH%"          # prepend; new shell after
setx DEPOT_TOOLS_WIN_TOOLCHAIN 0               # use the locally-installed VS2022

# 2) fetch Chromium (pin a milestone after sync; --no-history is smaller/faster)
mkdir C:\src\chromium && cd C:\src\chromium
fetch --no-history chromium
cd src
# pin a stable milestone matching CEF's chromium (149.0.7827.x) for parity, then re-sync:
git checkout -b holo 149.0.7827.156   # or the tag you target
gclient sync -D

# 3) generate build files
gn gen out/Holo --args="is_debug=false symbol_level=1 blink_symbol_level=0 enable_nacl=false is_component_build=true dcheck_always_on=false"
#   (is_component_build=true → much faster iterative builds; flip to is_official_build=true for release)

# 4) build the full browser (includes the extension system + Web Store)
autoninja -C out/Holo chrome
# first build: 1–4h+ depending on cores; incremental builds are minutes.

# 5) run vanilla Chrome to confirm the toolchain
out\Holo\chrome.exe --user-data-dir=C:\src\holo-profile
#   verify chrome://version, chrome://extensions (install a Web Store extension to confirm the full system)
```
**Gate:** stock Chrome runs, Web Store extensions install + run. This proves the (heavy) infra before any κ work.

## P1 — register the `holo://` scheme  →  see KAPPA-INTEGRATION.md §1
Patch `ChromeContentClient::AddAdditionalSchemes` to register `holo` as standard + secure + CORS + fetch.
Gate: `holo://os/x` is treated as a secure, standard-origin scheme (devtools: `location.origin === "holo://os"`).

## P2 — the κ URLLoaderFactory (the verify gate)  →  KAPPA-INTEGRATION.md §2–3
- Build `kappa-route` as a static lib for the MSVC ABI and expose it to GN:
  ```sh
  # from holo-apps/apps/tauri/src-tauri
  cargo build --release -p kappa-route --target x86_64-pc-windows-msvc
  # → target/x86_64-pc-windows-msvc/release/kappa_route.lib  (+ kappa_route.dll for the cdylib path)
  # header: holo-apps/apps/tauri/cef-host/include/kappa_route.h
  ```
- Add a GN target wrapping the prebuilt `kappa_route.lib` + `kappa_route.h` (KAPPA-INTEGRATION.md §3).
- Implement `HoloURLLoaderFactory` (calls `kr_resolve`) and register it in
  `ChromeContentBrowserClient::RegisterNonNetworkNavigationURLLoaderFactories` +
  `RegisterNonNetworkSubresourceURLLoaderFactories` for the `holo` scheme.
- Gate: `holo://os/home.html` loads + renders; a tampered byte is refused (L5); unknown κ → error.

## P3 — trust root + isolation
Bake the closure anchor (sha256 of `os-closure.json`) into the factory init and fail closed on mismatch
(reuse `kr_store_open(root, anchor)`). Verify per-κ origin isolation: two `holo://<κ>/` tabs are distinct
origins (Chromium isolates standard-scheme tuple origins automatically).

## P4 — branding / new-tab
Set the Hologram desktop as the home/new-tab surface (NTP override via the
`NewTabPageLocation` enterprise policy or a built-in NTP component patch). Theme via the standard theme APIs.

## P5 — extensions validation (the requirement)
Install several real Web Store extensions exercising APIs CEF lacked; confirm they run. Being the full
`//chrome` build, the extension surface is complete — document any chromium-level limitation (expected: none).

## P6 — package, sign, update, cross-platform
Installer + code-signing per OS; the updater; repeat P0 toolchain on macOS/Linux for those targets.

## Ongoing cost (be honest)
This is a **maintained Chromium fork**: rebase the (small) `holo` patch on each milestone uplift, and run a
build farm. The κ integration is small + reused; the *infrastructure* (build, fork rebases, signing) is the
real, recurring cost. Re-evaluate vs the CEF subset before committing.
