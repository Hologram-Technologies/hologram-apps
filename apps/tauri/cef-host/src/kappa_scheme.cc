// kappa_scheme.cc — serve content-addressed, dual-axis-verified bytes for holo://os/*.
//
// The resource handler runs in the browser process (the network service), BEFORE bytes reach the
// renderer: it asks the Rust verifier (kr_resolve) for the bytes of the requested κ-path, and the
// verifier re-derives both content-address axes and refuses tamper/unpinned (Law L5 / SEC-1 / SEC-6).
// A refusal becomes the HTTP status (403/404) with an empty body — fail-closed.
#include "kappa_scheme.h"

#include <algorithm>
#include <cstring>
#include <string>

#include "include/cef_request.h"
#include "include/cef_response.h"

namespace {

class KappaResourceHandler : public CefResourceHandler {
 public:
  explicit KappaResourceHandler(HotStore* store) : store_(store) {}
  ~KappaResourceHandler() override {
    if (data_) {
      kr_free(data_, size_);
    }
  }

  bool Open(CefRefPtr<CefRequest> request,
            bool& handle_request,
            CefRefPtr<CefCallback> /*callback*/) override {
    handle_request = true;  // resolved synchronously below

    // holo://os/apps/browser/index.html → "/os/apps/browser/index.html" (kr flat_key strips "os/").
    std::string url = request->GetURL().ToString();
    static const std::string kScheme = "holo://";
    std::string rest =
        (url.size() >= kScheme.size() && url.compare(0, kScheme.size(), kScheme) == 0)
            ? url.substr(kScheme.size())
            : url;
    rest = rest.substr(0, rest.find_first_of("?#"));  // drop query/fragment
    std::string req = "/" + rest;
    path_ = req;                                       // remembered for the scoped-CORS decision below

    const char* mime = nullptr;
    status_ = store_->resolve(req.c_str(), &data_, &size_, &mime);  // hot-reloadable store (live reseal)
    mime_ = mime ? mime : "application/octet-stream";
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t& response_length,
                          CefString& /*redirectUrl*/) override {
    response->SetStatus(status_);
    // CefResponse::SetMimeType wants the BARE type ("text/html"), not "text/html; charset=utf-8" —
    // the charset suffix makes Chromium treat the document as non-HTML and render it as plain text.
    // The charset is declared in each document's <meta charset> anyway.
    std::string full = mime_.ToString();
    const size_t semi = full.find(';');
    response->SetMimeType(semi == std::string::npos ? full : full.substr(0, semi));
    // Cross-origin isolation so the OS's WASM engines (SharedArrayBuffer) run — same headers the
    // Tauri host set. credentialless lets each κ-origin embed shared engines without CORP friction.
    response->SetHeaderByName("Cross-Origin-Opener-Policy", "same-origin", true);
    response->SetHeaderByName("Cross-Origin-Embedder-Policy", "credentialless", true);
    response->SetHeaderByName("Cross-Origin-Resource-Policy", "cross-origin", true);
    // The Playground runtime is PUBLIC editor code the host injects into every real web page; a real page is
    // a DIFFERENT origin than holo://, so its module-script fetch is CORS-mode and needs ACAO to load. Scope
    // this to ONLY the playground graph (its files + holo-live-edit + holo-uor) — never the rest of the
    // substrate, so no cross-origin page can read user data or other modules. Same-origin holo:// is unchanged.
    if (path_.find("/_shared/holo-playground-") != std::string::npos ||
        path_.find("/_shared/holo-live-edit.mjs") != std::string::npos ||
        path_.find("/_shared/holo-uor.mjs") != std::string::npos ||
        // The Holo DevTools dock is ALSO host-injected into every tab (holo-devtools-dock-boot.js), so its
        // module graph is fetched CORS-mode by app origins and needs ACAO. Scope: the whole devtools graph
        // plus its non-devtools deps (object/scene/blake3). uor is already covered above.
        path_.find("/_shared/devtools/") != std::string::npos ||
        path_.find("/_shared/holo-object.mjs") != std::string::npos ||
        path_.find("/_shared/holo-scene.mjs") != std::string::npos ||
        path_.find("/_shared/holo-blake3.mjs") != std::string::npos) {
      response->SetHeaderByName("Access-Control-Allow-Origin", "*", true);
    }
    // κ caching. ONLY the CONTENT route (/.holo/<axis>/<hex> — where the hex literally IS the content
    // hash) is truly IMMUTABLE: cache it forever, re-serve from memory with no re-fetch/re-verify →
    // content-addressed streaming. A per-κ ORIGIN (host = an app's @id κ) is NOT content-immutable: the
    // app's bytes change as the operator develops while the @id stays fixed, so caching it immutable would
    // serve STALE after a reseal — it must revalidate. Everything except the content route → no-cache
    // (revalidate, so a reseal is picked up immediately). Per-byte L5 verification is unaffected.
    if (status_ == 200) {
      const bool immutable = path_.find("/.holo/sha256/") != std::string::npos ||
                             path_.find("/.holo/blake3/") != std::string::npos;
      response->SetHeaderByName(
          "Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache", true);
    }
    response_length = (status_ == 200) ? static_cast<int64_t>(size_) : 0;
  }

  bool Read(void* data_out,
            int bytes_to_read,
            int& bytes_read,
            CefRefPtr<CefResourceReadCallback> /*callback*/) override {
    bytes_read = 0;
    if (status_ != 200 || !data_ || offset_ >= size_) {
      return false;  // completion (or refusal → empty body)
    }
    const size_t remaining = size_ - offset_;
    const int n = static_cast<int>(std::min(static_cast<size_t>(bytes_to_read), remaining));
    std::memcpy(data_out, data_ + offset_, static_cast<size_t>(n));
    offset_ += static_cast<size_t>(n);
    bytes_read = n;
    return true;
  }

  void Cancel() override {}

 private:
  HotStore* store_ = nullptr;
  uint8_t* data_ = nullptr;
  size_t size_ = 0;
  size_t offset_ = 0;
  uint16_t status_ = 500;
  CefString mime_;
  std::string path_;   // the resolved request path (for the scoped-CORS decision in GetResponseHeaders)

  IMPLEMENT_REFCOUNTING(KappaResourceHandler);
  DISALLOW_COPY_AND_ASSIGN(KappaResourceHandler);
};

}  // namespace

CefRefPtr<CefResourceHandler> KappaSchemeHandlerFactory::Create(
    CefRefPtr<CefBrowser> /*browser*/,
    CefRefPtr<CefFrame> /*frame*/,
    const CefString& /*scheme_name*/,
    CefRefPtr<CefRequest> /*request*/) {
  return new KappaResourceHandler(store_);
}
