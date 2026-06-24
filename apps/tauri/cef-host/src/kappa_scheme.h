// kappa_scheme.h — the κ-route scheme handler factory. Every holo://os/* load is created here and
// served by a CefResourceHandler that delegates to the Rust verifier (kappa_route.h). Documented CEF
// embedder API only — no engine code.
#ifndef HOLO_CEF_KAPPA_SCHEME_H
#define HOLO_CEF_KAPPA_SCHEME_H

#include "include/cef_resource_handler.h"
#include "include/cef_scheme.h"

#include <string>

#include "hot_store.h"  // HotStore — a hot-reloadable κ-store (re-opens on reseal, no relaunch/poison)

// If `url` is holo://os/sc/<sub>?<query> (the native media-streaming companion for the dock apps), build the
// streaming resource handler for it; otherwise return nullptr. Called from handler.cc's GetResourceHandler so
// /sc/* rides the same resource-request path as the κ media resolver (which correctly supports 206/range),
// NOT the custom-scheme factory (whose 206 handling breaks a <video>'s follow-up range requests).
CefRefPtr<CefResourceHandler> HoloCreateScHandler(const std::string& url);

class KappaSchemeHandlerFactory : public CefSchemeHandlerFactory {
 public:
  explicit KappaSchemeHandlerFactory(HotStore* store) : store_(store) {}

  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser,
                                       CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override;

 private:
  HotStore* store_;
  IMPLEMENT_REFCOUNTING(KappaSchemeHandlerFactory);
  DISALLOW_COPY_AND_ASSIGN(KappaSchemeHandlerFactory);
};

#endif  // HOLO_CEF_KAPPA_SCHEME_H
