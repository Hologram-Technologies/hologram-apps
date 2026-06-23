# κ-native integration into chromium.git — the patch points

The whole browser + extension system is upstream Chromium; the **only** first-party additions are below.
They reuse the existing verifier (`holo-apps/apps/tauri/src-tauri/kappa-route`, C ABI in
`cef-host/include/kappa_route.h`) — no verification logic is rewritten. Code shown is an integration
**template** against the confirmed Chromium API surface; it compiles in the Chromium tree (verify there),
not in this repo. Keep the patch minimal so each milestone rebase is small.

Honest note: Chromium has no third-party scheme extensibility, so a first-class scheme requires editing a
few hardcoded scheme lists (§1). That minimal engine-source edit is unavoidable for any custom scheme
(it's the reason CEF/Electron exist); everything else here is embedder glue.

## §1 — register `holo://`  (patch `chrome/common/chrome_content_client.cc`)
In `ChromeContentClient::AddAdditionalSchemes(Schemes* schemes)`:
```cpp
schemes->standard_schemes.push_back("holo");          // tuple origins → per-κ isolation
schemes->secure_schemes.push_back("holo");            // secure context (SAB/workers)
schemes->cors_enabled_schemes.push_back("holo");
schemes->csp_bypassing_schemes;                        // (leave as-is)
// fetch/service-worker eligibility comes via the standard+secure registration above.
```
This mirrors how CEF registers `holo` (standard|secure|CORS|fetch) — now in real Chromium.

## §2 — the κ URLLoaderFactory  (new: `chrome/browser/holo/holo_url_loader_factory.{h,cc}`)
A self-deleting factory that resolves every `holo://` request through `kr_resolve` and streams the
verified bytes. Sketch:
```cpp
#include "services/network/public/cpp/self_deleting_url_loader_factory.h"
#include "kappa_route.h"   // the existing C ABI

class HoloURLLoaderFactory : public network::SelfDeletingURLLoaderFactory {
 public:
  static mojo::PendingRemote<network::mojom::URLLoaderFactory> Create(KStore* store);
  void CreateLoaderAndStart(mojo::PendingReceiver<network::mojom::URLLoader> loader,
                            int32_t request_id, uint32_t options,
                            const network::ResourceRequest& request,
                            mojo::PendingRemote<network::mojom::URLLoaderClient> client,
                            const net::MutableNetworkTrafficAnnotationTag&) override {
    // req path = "/" + url-after-"holo://"  (host = κ or "os"); same contract as the CEF handler.
    uint8_t* data = nullptr; size_t len = 0; const char* mime = nullptr;
    uint16_t status = kr_resolve(store_, RequestPath(request.url).c_str(), &data, &len, &mime);
    // status 200 → head(mime, len) + body(data,len) + COOP/COEP/CORP; else → net::ERR_* (L5 refuse).
    // free with kr_free(data,len) after the data pipe drains.
  }
 private:
  KStore* store_;  // from kr_store_open(dist, HOLO_CLOSURE_ANCHOR) at startup
};
```
Notes: this is the same byte contract the CEF `kappa_scheme.cc` already proved (dual-axis L5, the
content-address `/.holo/sha256|blake3/<hex>` route, COOP/COEP for crossOriginIsolated). The factory runs in
the browser process, **before** bytes reach the renderer — the κ gate.

## §3 — register the factory  (patch `chrome/browser/chrome_content_browser_client.{h,cc}`)
VERIFIED against the real Chromium 149.0.7827.155 source (the API changed — confirmed by reading
`content/public/browser/content_browser_client.h` + `chrome/browser/chrome_content_browser_client.{h,cc}`
at the pinned tag):
- **Navigation** is now a SINGULAR per-scheme creator, not a map hook. The old
  `RegisterNonNetworkNavigationURLLoaderFactories(map)` is GONE; the current virtual is
  `CreateNonNetworkNavigationURLLoaderFactory(scheme, FrameTreeNodeId)` returning ONE factory (null →
  content falls back). chrome does not override it, so the overlay ADDS the override (decl in `.h`, def in
  `.cc`). This is *cleaner* for us — its return type IS exactly `HoloURLLoaderFactory::Create`'s.
- **Subresource** is unchanged: the map-populating `RegisterNonNetworkSubresourceURLLoaderFactories` →
  `factories->emplace("holo", …)`. (Worker-main / SW-update hooks exist too; subresource is the one needed.)

```cpp
// .h — add the override declaration (alongside the existing Register…Subresource… decl):
mojo::PendingRemote<network::mojom::URLLoaderFactory>
CreateNonNetworkNavigationURLLoaderFactory(const std::string& scheme,
                                           content::FrameTreeNodeId frame_tree_node_id) override;

// .cc — navigation (singular): serve holo:// from the κ factory; everything else falls back.
mojo::PendingRemote<network::mojom::URLLoaderFactory>
ChromeContentBrowserClient::CreateNonNetworkNavigationURLLoaderFactory(
    const std::string& scheme, content::FrameTreeNodeId frame_tree_node_id) {
  if (scheme == "holo")
    return holo::HoloURLLoaderFactory::Create(holo::GetOrOpenStore());
  return {};
}

// .cc — subresources (map, unchanged hook): emplace inside the existing definition's body.
//   factories->emplace("holo", holo::HoloURLLoaderFactory::Create(holo::GetOrOpenStore()));
```
The overlay (`holo_kappa_overlay.py`) applies all of this by anchor — and is DEFINITION-aware (it inserts
into the function *definition*, never a preceding call site) and idempotent; its insertion logic is
unit-tested against fixtures shaped like the real 149 source (split `void ChromeContentBrowserClient::` /
name lines). If a future milestone moves these seams again, it fails loud rather than mis-patching.

## §4 — link the verifier  (new GN: `chrome/browser/holo/BUILD.gn` + dep)
Wrap the prebuilt Rust static lib so `chrome` links it:
```gn
config("kappa_route_config") { include_dirs = [ "//holo/include" ] }            # kappa_route.h
static_library("kappa_route") {
  public_configs = [ ":kappa_route_config" ]
  libs = [ "kappa_route.lib" ]                                                   # MSVC static lib
  lib_dirs = [ "//holo/lib" ]                                                    # cargo --target x86_64-pc-windows-msvc
}
# add //chrome/browser/holo:kappa_route + holo_url_loader_factory.cc to chrome_browser deps/sources.
```
Build the lib first (see BUILD-RUNBOOK §P2) and drop `kappa_route.lib` + `kappa_route.h` under `//holo/`.
(Alternatively use Chromium's in-tree Rust toolchain with a `rust_static_library` GN target pointing at
the crate — avoids a prebuilt blob, fully from-source.)

## §5 — trust root + per-κ origins (no new code)
- `g_holo_store = kr_store_open(dist_dir, HOLO_CLOSURE_ANCHOR)` at browser startup → poisoned store refuses
  everything if the manifest doesn't match the baked anchor (G1/SEC-1), exactly as in the CEF host.
- Per-κ isolation is free: `holo://<κ>` are distinct standard-scheme tuple origins → Chromium isolates
  process/storage/SW per holospace. `holo://os` = the OS/home holospace.

## §6 — extensions & branding (upstream features, config only)
- Extensions: the full `//chrome` extension system + Web Store ships as-is. (Stretch κ-native goal: a second
  factory that resolves/verifies extension payloads by κ — additive, not required for compatibility.)
- Branding: Hologram desktop as the NTP via the `NewTabPageLocation` policy or an NTP component patch.

## Patch surface summary (what the fork actually touches — verified vs Chromium 149.0.7827.155)
1. `chrome/common/chrome_content_client.cc` — +3 lines in `AddAdditionalSchemes` (standard/secure/cors).
2. `chrome/browser/holo/holo_url_loader_factory.{h,cc}` + `BUILD.gn` — new (the κ factory, calls `kr_resolve`).
3. `chrome/browser/chrome_content_browser_client.h` — +1 `CreateNonNetworkNavigationURLLoaderFactory` decl.
4. `chrome/browser/chrome_content_browser_client.cc` — +1 nav-factory def + 1 subresource `emplace("holo")`
   + the factory `#include`.
5. `chrome/browser/BUILD.gn` — +1 dep (`//chrome/browser/holo:holo`).
6. branding (data only) + the OS image shipped beside the exe; trust root baked into `holo_closure_anchor.h`.
Everything else — the entire browser, omnibox, tabstrip, app menu, extension system — is upstream, unchanged.
