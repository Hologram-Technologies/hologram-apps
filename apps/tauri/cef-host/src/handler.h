// handler.h — CefClient for the Chrome-runtime browser: tracks browsers (quits on last close) and hosts
// the browser side of the Hologram bridge message router. The router's query handler enforces the
// origin tier (holo:// frames may reach the Hologram service; everything else is refused) — the
// security boundary of the one seam.
#ifndef HOLO_CEF_HANDLER_H
#define HOLO_CEF_HANDLER_H

#include <list>
#include <map>
#include <memory>
#include <set>
#include <string>

#include "include/cef_client.h"
#include "include/cef_keyboard_handler.h"
#include "include/cef_resource_handler.h"
#include "include/cef_resource_request_handler.h"
#include "include/wrapper/cef_message_router.h"

class HoloBridgeHandler;  // browser-side router Handler (defined in handler.cc)

class SimpleHandler : public CefClient,
                      public CefLifeSpanHandler,
                      public CefKeyboardHandler,
                      public CefRequestHandler,
                      public CefResourceRequestHandler {
 public:
  SimpleHandler();
  ~SimpleHandler() override;

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }

  // ── DevTools at F12 (Chrome-identical). The native browser embeds the COMPLETE Chromium inspector;
  // we do not write panels — we open it. F12 / Ctrl+Shift+I toggle, Ctrl+Shift+J → Console,
  // Ctrl+Shift+C → inspect-element. The inspector reflects the live renderer (the entire tab, every
  // element, every byte) by construction. κ-native asset origin is handled in app.cc/kappa_scheme.cc:
  // the front-end resources resolve through the holo:// κ scheme (sealed, verified), not devtools://.
  bool OnKeyEvent(CefRefPtr<CefBrowser> browser,
                  const CefKeyEvent& event,
                  CefEventHandle os_event) override;

  // ── Bridge relay (P2). The browser-process side of the seam holds no Hologram logic of its own; it
  // relays a permitted holo:svc: query to the privileged service context (the OS home frame, which runs
  // the real holo-resolve / Q / governance modules) and resolves the original callback when the service
  // replies. Async by construction: ServiceFrame()->ExecuteJavaScript(__holoSvc) → service computes →
  // window.cefQuery('holo:svcreply:<id>:<json>') → ResolvePending(id, json) → callback->Success.
  CefRefPtr<CefFrame> ServiceFrame();  // the OS home frame iff it is still holo://os, else null
  int StashPending(CefRefPtr<CefMessageRouterBrowserSide::Callback> callback);
  void ResolvePending(int id, const std::string& json);

  // ── Governance at the door (P4). A top-level WEB navigation is held at OnBeforeBrowse, relayed to the
  // service for a verdict from the user's REAL sealed constitution (holo-conscience.evaluate over the
  // destination — a URL carrying PII trips red-line P5), and enforced: allowed (one-shot re-nav) or sent
  // to a block page. The browser process runs no policy; it only carries the URL and applies the verdict.
  void ResolveGov(int gov_id, bool allow);

  // Host-driven open (P5): the service (holo://os only) asks the host to stream a composed κ-surface in
  // as a new tab. Only holo:// URLs are opened — never web — so it cannot be abused to launch arbitrary
  // pages. Makes "intent → the workspace materializes as κ-tabs" a real product action, not a test action.
  void OpenTab(const std::string& holo_url);
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override;

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;

  // CefRequestHandler (router plumbing)
  bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                      CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request,
                      bool user_gesture,
                      bool is_redirect) override;

  // Anti-anti-adblock: instead of CANCELLING an ad request (a detectable failed request), serve an inert
  // SURROGATE (HTTP 200) — so the page sees the request succeed and finds the ad globals it probes for
  // (window.googletag/ga), with nothing actually loaded. Blocking becomes undetectable. (substitute≠deny)
  CefRefPtr<CefResourceHandler> GetResourceHandler(CefRefPtr<CefBrowser> browser,
                                                   CefRefPtr<CefFrame> frame,
                                                   CefRefPtr<CefRequest> request) override;

  // Ad/tracker removal: route every resource load through our screen, then cancel ad-network requests
  // before they leave the machine (the same load chokepoint the host already owns — not a parallel path).
  CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame,
      CefRefPtr<CefRequest> request,
      bool is_navigation,
      bool is_download,
      const CefString& request_initiator,
      bool& disable_default_handling) override;

  // CefResourceRequestHandler
  cef_return_value_t OnBeforeResourceLoad(CefRefPtr<CefBrowser> browser,
                                          CefRefPtr<CefFrame> frame,
                                          CefRefPtr<CefRequest> request,
                                          CefRefPtr<CefCallback> callback) override;

  // Content-κ ad removal (the keystone): for a fully-bufferable script response, attach a filter that
  // hashes the body and drops it if its content address is on the ad-object denylist — so a denylisted
  // ad payload is refused WHEREVER it is served (immune to domain/URL rotation), which a location-based
  // blocker cannot do. Gated on Content-Length so it only ever passes a body whole or drops it whole.
  CefRefPtr<CefResponseFilter> GetResourceResponseFilter(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame,
      CefRefPtr<CefRequest> request,
      CefRefPtr<CefResponse> response) override;
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                 TerminationStatus status,
                                 int error_code,
                                 const CefString& error_string) override;

  void CloseAllBrowsers(bool force_close);

 private:
  // Open the real Chromium DevTools against `browser`'s live renderer (toggle handled by caller).
  // `inspect_at` (non-empty) selects inspect-element at that point. Reuses this client so the
  // DevTools front-end's own asset loads still route through the holo:// κ scheme.
  void ShowHoloDevTools(CefRefPtr<CefBrowser> browser, const CefPoint& inspect_at);

  std::list<CefRefPtr<CefBrowser>> browser_list_;
  CefRefPtr<CefMessageRouterBrowserSide> router_;
  std::unique_ptr<HoloBridgeHandler> bridge_;

  // Relay state. main_browser_ is the first browser created (the OS shell window); its main frame hosts
  // the Hologram service. pending_ correlates an in-flight holo:svc: callback with the service's reply.
  CefRefPtr<CefBrowser> main_browser_;
  std::map<int, CefRefPtr<CefMessageRouterBrowserSide::Callback>> pending_;
  int next_query_id_ = 1;

  // Governance state. approved_ holds URLs the policy cleared, consumed once by our own re-navigation so
  // it isn't re-judged into a loop. gov_pending_ correlates a held navigation with its (browser, url).
  struct GovReq { CefRefPtr<CefBrowser> browser; std::string url; };
  std::set<std::string> approved_;
  std::map<int, GovReq> gov_pending_;
  int next_gov_id_ = 1;

  IMPLEMENT_REFCOUNTING(SimpleHandler);
  DISALLOW_COPY_AND_ASSIGN(SimpleHandler);
};

#endif  // HOLO_CEF_HANDLER_H
