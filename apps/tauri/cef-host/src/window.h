// window.h — the ONE window seam for the host: two BrowserView delegates used at boot.
//   · HoloBrowserViewDelegate  — a Chrome-runtime BrowserView, toolbar-less for holo:// (CEF_CTT_NONE).
//   · HoloShellWindowDelegate  — a top-level CefWindow hosting that one view (shell-is-chrome).
// The native-hosted Chrome window (handler.cc) is the proven default; this Views path is the experimental
// single-chrome model (opt-in HOLO_WINDOW_MODE=views — Chrome-style top-level Views windows are racy in this
// CEF dist). Header-only so it needs no window.cc. (The old omni-overlay HoloWindow model was deleted — dead.)
#ifndef HOLO_CEF_WINDOW_H
#define HOLO_CEF_WINDOW_H

#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>

#include "include/cef_browser.h"  // CefBrowser / TryCloseBrowser — graceful close handshake (shell window)
#include "include/views/cef_browser_view.h"
#include "include/views/cef_fill_layout.h"  // CefFillLayout — complete type for SetToFillLayout() (shell window)
#include "include/views/cef_browser_view_delegate.h"
#include "include/views/cef_window.h"
#include "include/views/cef_window_delegate.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"


// Dbg — boot-trace helper used by the window delegates below. inline so every TU that includes window.h
// (app.cc AND handler.cc) shares one definition. [STUB added to unblock the build: window.h called Dbg(...)
// with no definition anywhere in the tree; replace with the project's real boot logger.]
inline void Dbg(const char* m) { std::fprintf(stderr, "[HOLO-WIN] %s\n", m); std::fflush(stderr); }

// P3 — single chrome (Path A): host each tab as a CHROME-runtime BrowserView (keeps Chrome's extensions /
// native DevTools / GPU) but HIDE the native toolbar for holo:// pages, so the shell's own HTML chrome
// (tab strip · address bar · bookmarks bar · action rail — see holo-bar.mjs) is the only chrome. Open-web
// tabs keep a real address bar (hybrid). GetChromeToolbarType defaults to CEF_CTT_NONE in CEF 149; we set
// it explicitly per tab from a flag fixed at tab creation (it is queried once, before the URL is known).
// Toolbar types (cef_types.h): CEF_CTT_NONE = no toolbar · CEF_CTT_NORMAL = full · CEF_CTT_LOCATION = bar only.
class HoloBrowserViewDelegate : public CefBrowserViewDelegate {
 public:
  explicit HoloBrowserViewDelegate(bool is_holo) : is_holo_(is_holo) {}
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
  ChromeToolbarType GetChromeToolbarType(CefRefPtr<CefBrowserView>) override {
    return is_holo_ ? CEF_CTT_NONE : CEF_CTT_NORMAL;  // holo:// → shell chrome only; web → address bar
  }

 private:
  bool is_holo_;
  IMPLEMENT_REFCOUNTING(HoloBrowserViewDelegate);
  DISALLOW_COPY_AND_ASSIGN(HoloBrowserViewDelegate);
};

// Shell-is-chrome single window (the chosen model). The WHOLE window is ONE Chrome-runtime BrowserView
// hosting the OS shell, with the native toolbar suppressed (HoloBrowserViewDelegate → CEF_CTT_NONE for
// holo://). The shell draws all chrome (tab strip · omnibox · nav · bars) and opens apps as IN-PAGE
// holospace tabs, so there is exactly ONE window and ONE chrome. This replaces the old native-hosted
// CefBrowserHost::CreateBrowser window, whose window.open / CreateBrowser spawned a SEPARATE top-level OS
// window per surface (there is no native-hosted API to add a tab to an existing window) — the stray-window
// bug. Header-only so it needs no window.cc (which stays out of CMake HOLO_SRCS).
class HoloShellWindowDelegate : public CefWindowDelegate {
 public:
  explicit HoloShellWindowDelegate(CefRefPtr<CefBrowserView> view) : view_(view) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    Dbg("OnWindowCreated: begin");
    window_ = window;
    window->SetToFillLayout();      // the single shell view fills the whole content area
    Dbg("OnWindowCreated: fill layout");
    // Adding a Chrome-style BrowserView creates the underlying CefBrowser SYNCHRONOUSLY; doing it inside the
    // CreateTopLevelWindow callback deadlocks (the nested browser-creation tasks can't run while we block the
    // UI thread). Defer the attach to a posted task so CreateTopLevelWindow returns and the loop pumps first.
    CefPostTask(TID_UI, base::BindOnce(&HoloShellWindowDelegate::Attach,
                                       CefRefPtr<HoloShellWindowDelegate>(this)));
    Dbg("OnWindowCreated: attach deferred");
  }

  void Attach() {
    if (!window_ || !view_) return;
    Dbg("Attach: begin");
    window_->Show();                 // FINDING (2026-06-24): in this CEF dist, AddChildView of a Chrome-style
    Dbg("Attach: shown");            // BrowserView DEADLOCKS the UI thread (synchronous CefBrowser creation never
    window_->AddChildView(view_);    // returns) regardless of Show order or deferral — confirmed by two probes.
                                     // Chrome-runtime Views (the only toolbar-less path that keeps the Chrome
                                     // runtime) needs a CEF-dist fix; native-hosted is the working default.
    Dbg("Attach: child added");
    view_->RequestFocus();
    Dbg("Attach: end");
  }
  void OnWindowDestroyed(CefRefPtr<CefWindow>) override { view_ = nullptr; }

  // Graceful close handshake (the canonical CEF Views pattern): route a window-close request through the
  // browser's TryCloseBrowser so the renderer unloads cleanly, instead of an abrupt teardown that the old
  // native-hosted path never exercised. Returns true once the browser is ready to close.
  bool CanClose(CefRefPtr<CefWindow>) override {
    CefRefPtr<CefBrowser> b = view_ ? view_->GetBrowser() : nullptr;
    return b ? b->GetHost()->TryCloseBrowser() : true;
  }

  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
  bool CanResize(CefRefPtr<CefWindow>) override { return true; }
  bool CanMaximize(CefRefPtr<CefWindow>) override { return true; }
  bool CanMinimize(CefRefPtr<CefWindow>) override { return true; }
  CefRect GetInitialBounds(CefRefPtr<CefWindow>) override { return CefRect(0, 0, 1280, 800); }
  CefSize GetPreferredSize(CefRefPtr<CefView>) override { return CefSize(1280, 800); }

 private:
  // Diagnostic: append a step to the lifecycle strand file on disk (stderr capture is unreliable for this
  // multi-process exe). Lets us see exactly which step inside OnWindowCreated wedges for Chrome-style Views.
  static void Dbg(const char* step) {
    std::fprintf(stderr, "HOLO-LIFE: views %s\n", step); std::fflush(stderr);
    const char* p = std::getenv("HOLO_LIFECYCLE_STRAND");
    std::FILE* f = std::fopen(p && p[0] ? p : "holo-lifecycle-strand.jsonl", "ab");
    if (f) { std::fprintf(f, "{\"event\":\"views %s\"}\n", step); std::fclose(f); }
  }
  CefRefPtr<CefBrowserView> view_;
  CefRefPtr<CefWindow> window_;
  IMPLEMENT_REFCOUNTING(HoloShellWindowDelegate);
  DISALLOW_COPY_AND_ASSIGN(HoloShellWindowDelegate);
};

#endif  // HOLO_CEF_WINDOW_H
