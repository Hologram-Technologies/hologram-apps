// handler.h — CefClient for the Chrome-runtime browser: tracks browsers (quits on last close) and hosts
// the browser side of the Hologram bridge message router. The router's query handler enforces the
// origin tier (holo:// frames may reach the Hologram service; everything else is refused) — the
// security boundary of the one seam.
#ifndef HOLO_CEF_HANDLER_H
#define HOLO_CEF_HANDLER_H

#include <chrono>
#include <cstdint>
#include <list>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "include/cef_client.h"
#include "include/cef_keyboard_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_resource_handler.h"
#include "include/cef_resource_request_handler.h"
#include "include/wrapper/cef_message_router.h"

class HoloBridgeHandler;  // browser-side router Handler (defined in handler.cc)

class SimpleHandler : public CefClient,
                      public CefLifeSpanHandler,
                      public CefLoadHandler,
                      public CefKeyboardHandler,
                      public CefRequestHandler,
                      public CefResourceRequestHandler {
 public:
  SimpleHandler();
  ~SimpleHandler() override;

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
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
  void RelayCapture(const std::string& payload);  // forward a captured message to the holo://os inbox frame(s)
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
  void OpenPopupWindow(const std::string& url);  // top-level window (extension action popups)
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override;

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;

  // CefLoadHandler — first-boot companion tabs. When the OS shell main frame finishes loading (i.e. the
  // greeter has signed in and handed off login.html → shell.html), open "Start here" + "Play" as TABS in
  // this same window via window.open. Fired once per process so reloads/navigation don't reopen them.
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override;

  // Content-failure guard: if the CANONICAL LOGIN itself fails to load (e.g. a stale seal → the κ verifier
  // refuses login.html → ERR_INVALID_RESPONSE), do NOT leave the user on a dead Chrome error page. Navigate
  // the frame in-place to the fail-loud diagnostic (clear reason + "Try again") so boot ALWAYS lands on the
  // login OR an honest, recoverable surface — never a raw browser error.
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode,
                   const CefString& errorText,
                   const CefString& failedUrl) override;

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

  // ── Boot-health supervisor (process L5). The host must NEVER silently vanish: a window that is created
  // then immediately closes (the Views+Chrome lifecycle collapse) used to quit the message loop with exit 0
  // and no trace. StartBoot opens the shell window and arms a liveness latch; if the window collapses before
  // the boot is proven healthy, OnBeforeClose self-heals into the proven native-hosted strategy instead of
  // quitting. Every transition is logged on the HOLO-LIFE trail (stderr) for self-diagnosis. See handler.cc.
  void StartBoot(const std::string& boot_url);   // open the shell window + arm the supervisor (call once)
  void OpenBootWindow(bool prefer_views);        // (re)create the shell window in the chosen strategy
  void OnLiveLatch();                            // T_live elapsed with the window alive → boot is healthy

  // Lifecycle trail (process L5). LogLife records a transition to THREE places: stderr (HOLO-LIFE:), an
  // in-memory ring (for the fail-loud diagnostic surface), and a hash-linked append-only strand on disk
  // (tamper-evident post-mortem — the holo-strand model, sha256-linked; signature is the follow-up).
  void LogLife(const std::string& event);
  void PushLifecycleToShell();   // mirror {healthy, strategy, events} into window.__holoLifecycle (boot-proof)

 private:
  void AppendStrand(const std::string& event);           // one hash-linked line → the lifecycle strand file
  std::string DiagnosticDataUrl(const std::string& reason);  // the data: page (reason + trail + retry)
  void OpenDiagnosticWindow(const std::string& reason);  // fail-loud: a native window showing WHY + retry
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

  // First-boot guard: the companion tabs (Start here, Play) are opened exactly once — when the main
  // window first reaches the shell after sign-in. Subsequent shell reloads/navigations are no-ops.
  bool opened_boot_tabs_ = false;

  // Boot-health supervisor state. boot_url_ is the shell URL to (re)open; prefer_views_ records the strategy
  // of the current attempt; survived_live_ flips true once the window outlives the liveness latch (healthy
  // boot); heal_count_ bounds the self-heal retries so a genuinely broken host still exits loud.
  std::string boot_url_;
  bool prefer_views_ = true;
  bool survived_live_ = false;
  int heal_count_ = 0;

  // Instant-boot budget: boot_start_ is stamped when StartBoot runs; paint_ms_ is the elapsed ms to the
  // canonical login's first main-frame load-end (the "boot → login on screen" metric, surfaced as
  // __holoLifecycle.paintMs and asserted by the boot-proof so "fast" is a witnessed invariant, not a hope).
  std::chrono::steady_clock::time_point boot_start_;
  long paint_ms_ = -1;

  // Lifecycle trail / strand state. life_trail_ is a capped ring of recent transitions (embedded in the
  // diagnostic surface); strand_* is the hash-linked append-only log on disk; last_reason_ is the most
  // recent collapse cause shown to the user.
  std::vector<std::string> life_trail_;
  std::string strand_path_;
  std::string strand_head_;
  uint64_t strand_seq_ = 0;
  std::string last_reason_;

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
