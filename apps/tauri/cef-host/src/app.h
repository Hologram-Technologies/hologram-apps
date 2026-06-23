// app.h — the CEF application (Chrome runtime: real Chromium UI) + the Hologram bridge.
//
// Browser process: registers the κ scheme, opens the κ-store, opens the real Chrome window, enables
// extensions via --load-extension. Render process: hosts the message-router renderer side (window.cefQuery)
// and injects window.HoloBridge ONLY into holo:// frames — the per-tab seam to the browser-process Hologram
// service. Web frames get no bridge (origin-tiered; SEC-2/SEC-5). Only κ glue + boilerplate; no UI code.
#ifndef HOLO_CEF_APP_H
#define HOLO_CEF_APP_H

#include "include/cef_app.h"
#include "include/cef_render_process_handler.h"
#include "include/wrapper/cef_message_router.h"

class SimpleApp : public CefApp,
                  public CefBrowserProcessHandler,
                  public CefRenderProcessHandler {
 public:
  SimpleApp() = default;

  // CefApp
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }
  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override;
  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override;

  // CefBrowserProcessHandler
  void OnContextInitialized() override;

  // CefRenderProcessHandler
  void OnWebKitInitialized() override;
  void OnContextCreated(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override;
  void OnContextReleased(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefV8Context> context) override;
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override;

 private:
  CefRefPtr<CefMessageRouterRendererSide> render_router_;

  IMPLEMENT_REFCOUNTING(SimpleApp);
  DISALLOW_COPY_AND_ASSIGN(SimpleApp);
};

#endif  // HOLO_CEF_APP_H
