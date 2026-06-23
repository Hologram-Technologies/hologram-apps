# Hologram CEF host (P1 skeleton)

A real Chromium — via **CEF**, which tracks `chromium.git` — that boots Hologram OS over the κ-native
`holo://` scheme. Every byte is content-addressed and **dual-axis verified before it reaches the
renderer**; a tampered or unpinned byte is refused, fail-closed (holospaces Law L5 / SEC-1 / SEC-6).

## Why CEF (not Tauri)

Tauri renders through the system webview — WebView2 (a Microsoft-managed Edge runtime, not `chromium.git`)
on Windows, and WKWebView / WebKitGTK (not Chromium at all) on macOS/Linux. CEF embeds the full upstream
Chromium engine identically on every platform, with documented APIs for intercepting loads. We write no
engine code — only embedder glue.

## Architecture

```
holo://os/<path>
   │  CefSchemeHandlerFactory → KappaResourceHandler   (src/kappa_scheme.cc, browser process)
   ▼
   kr_resolve()  ── Rust crate kappa-route (../src-tauri/kappa-route, C ABI in include/kappa_route.h)
   │   re-derive sha256 ⊕ blake3 σ-axis · refuse mismatch/unpinned · bootstrap exempt
   ▼
   verified bytes → renderer        (refusal → HTTP 403/404, empty body)
```

The verifier is the **same audited `kappa-route` crate** the Tauri host uses — one verifier, both
engines. Its logic is unit-witnessed (`cargo test -p kappa-route`, no GUI needed).

## Files

- `src/main.cc` — Windows entry; single-exe browser+subprocess; opens CDP on localhost:9333.
- `src/app.cc` — registers the `holo` scheme (standard/secure/CORS/fetch) and the κ-route factory; opens the window.
- `src/handler.cc` — minimal CefClient (cefsimple pattern).
- `src/kappa_scheme.cc` — the κ-route resource handler (calls the Rust verifier).
- `include/kappa_route.h` — the verifier's C ABI (cbindgen-compatible).
- `CMakeLists.txt` — modeled on cefsimple; links libcef + the wrapper + the κ-route DLL.

## Build & run (Windows)

```powershell
./vendor-cef.ps1     # fetch the pinned CEF dist into third_party/cef (once)
./build.ps1          # builds the Rust verifier DLL, then the CEF host
# run, pointing at a sealed image built by ../make-dist.mjs:
$env:HOLO_OS_DIR = "../dist"; ./build/Release/holo_cef_host.exe
```

## Status / TODO

- **Skeleton**: single window, unsandboxed (the *minimal* CEF dist omits `cef_sandbox.lib`).
- **P3**: multi-WebContents tabs, frameless chrome + omnibox, deep links (mirror the Tauri host).
- **P4 (security/metal)**: switch to the *standard* CEF dist and enable the multiprocess sandbox;
  GPU/zero-copy compositing; a native by-κ cache so re-derivation is one-time per κ; latency measurements.
- **P5**: bake the closure into the signed binary (the verifier is native — no fetchable SW to swap);
  per-platform code signing.
