# Hologram κ overlay for ungoogled-chromium

The Google-free, κ-substrate-native production browser = **ungoogled-chromium** + this thin overlay. Nothing
here is browser/UX code — the entire browser (omnibox, tabstrip, app menu, the full extension system + Web
Store) is upstream ungoogled-chromium. We add only: the `holo://` scheme, one κ URLLoaderFactory that reuses
the *witnessed* `kappa-route` verifier verbatim, the Google-free belt flags, and the Hologram branding.

## Layout
```
build-kappa-ungoogled.sh        one-command build: ungoogled's own steps, then this overlay, then ninja
holo_kappa_overlay.py           stages the verifier, bakes the trust root, applies the +6-line engine seams
holo-flags.gn                   Google-free belt + κ build args (appended to ungoogled's flags.gn)
src/chrome/browser/holo/        the ONE first-party C++ unit:
  holo_url_loader_factory.{h,cc}   resolves every holo:// request via kr_resolve (dual-axis L5, COOP/COEP)
  BUILD.gn                         links the prebuilt kappa_route lib + the factory into //chrome
branding/apply_branding.py      Chromium → "Hologram OS" + H mark (string/asset substitution; no code)
../holo/{lib,include}           the prebuilt kappa-route verifier (kappa_route.lib + kappa_route.h)
```

## Why so little first-party code
Chromium has no third-party-scheme extensibility, so a first-class scheme needs the scheme lists edited
(`chrome_content_client.cc`) and a loader registered for navigations + subresources
(`chrome_content_browser_client.{h,cc}`). Those few edits are what `holo_kappa_overlay.py` inserts —
anchor-based, definition-aware (never a call site), idempotent, fails loud on rebase drift. The anchors
and snippets are VERIFIED against the real Chromium 149.0.7827.155 source: in 149 the navigation hook is
the singular `CreateNonNetworkNavigationURLLoaderFactory(scheme,…)` (the old map hook was removed), so the
overlay adds that override; subresources use the unchanged `RegisterNonNetworkSubresourceURLLoaderFactories`
map. Everything that *verifies* is the existing `kappa-route` crate — the same audited code the CEF host and
the web service-worker run. See ../KAPPA-INTEGRATION.md §3 and ../GOOGLE-FREE.md.

## What is verified vs out-of-band
- Verified here (no Chromium tree needed): the seam-insertion + idempotency logic (unit-tested against
  synthetic fixtures), that the factory references only real `kappa_route.h` symbols, and that the staged
  `kappa_route.lib` exports `kr_store_open`/`kr_resolve`/`kr_free` (dumpbin).
- Out-of-band (needs the build farm): the actual compile/link of `chrome` against the pinned milestone,
  and a live `holo://os/` render in the resulting Google-free browser. The anchors are authored against the
  pinned `UC_TAG`; if a milestone moves a seam the overlay fails loud (it never silently mis-patches).
