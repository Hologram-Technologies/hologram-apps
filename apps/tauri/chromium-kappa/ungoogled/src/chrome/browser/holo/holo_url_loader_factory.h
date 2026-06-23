// holo_url_loader_factory.h — the κ-route URLLoaderFactory for `holo://`, built into ungoogled-chromium.
//
// This is the SINGLE first-party C++ unit the fork adds (besides the +6 lines of scheme registration and
// factory wiring applied by holo_kappa_overlay.py). It holds NO verification logic of its own: every
// request is resolved through the existing, witnessed `kappa-route` verifier over its C ABI (kappa_route.h),
// the exact same byte-contract the CEF host (kappa_scheme.cc) already proved — dual-axis re-derivation
// (Law L5 / SEC-1 / SEC-6), the `/.holo/sha256|blake3/<hex>` content route, and COOP/COEP/CORP so every
// holo:// origin is crossOriginIsolated. It runs in the browser process, BEFORE bytes reach the renderer.
//
// Per-κ isolation is free: `holo://<κ>` are distinct standard-scheme tuple origins (registered in
// chrome_content_client.cc), so Chromium isolates process/storage/service-worker per holospace.

#ifndef CHROME_BROWSER_HOLO_HOLO_URL_LOADER_FACTORY_H_
#define CHROME_BROWSER_HOLO_HOLO_URL_LOADER_FACTORY_H_

#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/cpp/self_deleting_url_loader_factory.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"

// Opaque κ-route store handle. The full C ABI (kappa_route.h) is included only in the .cc, NOT here, so
// this public header doesn't put //holo/include on the path of its many includers (chrome_content_browser_
// client.cc etc.). The verifier is still reused verbatim — just included where it's compiled.
extern "C" {
struct KStore;
}

namespace holo {

// Opens the closure-anchored store once and hands it to every factory instance. Called at browser
// startup (see chrome_content_browser_client.cc wiring). A poisoned store (manifest != baked anchor)
// refuses everything — the trust root (G1 / SEC-1), identical to the CEF host.
KStore* GetOrOpenStore();

class HoloURLLoaderFactory : public network::SelfDeletingURLLoaderFactory {
 public:
  // Returns a remote bound to a new self-deleting instance for the `holo` scheme.
  static mojo::PendingRemote<network::mojom::URLLoaderFactory> Create(KStore* store);

  HoloURLLoaderFactory(const HoloURLLoaderFactory&) = delete;
  HoloURLLoaderFactory& operator=(const HoloURLLoaderFactory&) = delete;

 private:
  explicit HoloURLLoaderFactory(
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      KStore* store);
  ~HoloURLLoaderFactory() override;

  // network::SelfDeletingURLLoaderFactory:
  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& traffic_annotation) override;

  KStore* store_;  // not owned; process-lifetime, from GetOrOpenStore()
};

}  // namespace holo

#endif  // CHROME_BROWSER_HOLO_HOLO_URL_LOADER_FACTORY_H_
