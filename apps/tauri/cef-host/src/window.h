// window.h — the Hologram window: a branded chrome strip (tab row + the one omni bar, a web overlay)
// on top, and a stack of content tabs below (each a real Chromium WebContents; only the active is
// visible). Alloy style — we own the chrome. The omni is the one unified search/address bar.
#ifndef HOLO_CEF_WINDOW_H
#define HOLO_CEF_WINDOW_H

#include <map>
#include <string>

#include "include/cef_client.h"
#include "include/cef_menu_model.h"
#include "include/cef_menu_model_delegate.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_browser_view_delegate.h"
#include "include/views/cef_overlay_controller.h"
#include "include/views/cef_panel.h"
#include "include/views/cef_window.h"
#include "include/views/cef_window_delegate.h"

// Force Alloy style on every BrowserView (the chrome is ours; Chrome style would draw its own UI).
class AlloyBrowserViewDelegate : public CefBrowserViewDelegate {
 public:
  AlloyBrowserViewDelegate() = default;
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  IMPLEMENT_REFCOUNTING(AlloyBrowserViewDelegate);
  DISALLOW_COPY_AND_ASSIGN(AlloyBrowserViewDelegate);
};

class HoloWindow : public CefBaseRefCounted {
 public:
  HoloWindow(CefRefPtr<CefClient> client, const CefString& omni_url, const CefString& home_url)
      : client_(client), omni_url_(omni_url), home_url_(home_url) {}

  // window lifecycle (UI thread)
  void OnWindowCreated(CefRefPtr<CefWindow> window);
  void OnWindowDestroyed();
  void Relayout();

  // tab ops (UI thread) — driven by the chrome (window.cefQuery) / the omni
  void NewTab(const std::string& url);   // url "" → home; creates + activates
  void SelectTab(int id);
  void CloseTab(int id);
  void NavigateActive(const std::string& url);  // omni submit → load in the active tab
  void Back();      // toolbar back  → active tab GoBack
  void Forward();   // toolbar fwd   → active tab GoForward
  void Reload();    // toolbar ⟳     → active tab Reload
  void GoHome();    // toolbar ⌂     → active tab to home
  void Zoom(double delta);  // delta 0 = reset
  void CloseActive();       // close the active tab
  void ShowAppMenu();       // the ⋮ menu → a native CefMenuModel

  // content callbacks (from the client)
  bool IsChrome(CefRefPtr<CefBrowser> browser) const;  // the omni toolbar's browser?
  void OnContentAddress(CefRefPtr<CefBrowser> browser, const std::string& url);
  void OnContentTitle(CefRefPtr<CefBrowser> browser, const std::string& title);

 private:
  void ShowActive();
  void PushTabs();                          // → chrome window.__setTabs([...])
  void SetOmniText(const std::string& url); // → chrome window.__setOmni(url)
  CefRefPtr<CefBrowserView> Active() const;
  int IdForBrowser(CefRefPtr<CefBrowser> browser) const;

  CefRefPtr<CefClient> client_;
  CefString omni_url_;
  CefString home_url_;
  CefRefPtr<CefWindow> window_;
  CefRefPtr<CefBrowserView> omni_;              // the branded chrome (tabs + omni), top overlay strip
  CefRefPtr<CefOverlayController> omni_ctrl_;
  CefRefPtr<CefPanel> content_panel_;           // holds the tab views (fill layout; only active visible)
  std::map<int, CefRefPtr<CefBrowserView>> tabs_;
  std::map<int, std::string> titles_;
  int active_ = 0;
  int next_id_ = 1;
  CefRefPtr<CefMenuModelDelegate> menu_delegate_;

  IMPLEMENT_REFCOUNTING(HoloWindow);
  DISALLOW_COPY_AND_ASSIGN(HoloWindow);
};

// Framed top-level window (movable/closable via the OS frame); hands lifecycle to HoloWindow.
class HoloWindowDelegate : public CefWindowDelegate {
 public:
  explicit HoloWindowDelegate(CefRefPtr<HoloWindow> h) : h_(h) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override { h_->OnWindowCreated(window); }
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override { h_->OnWindowDestroyed(); }
  void OnWindowBoundsChanged(CefRefPtr<CefWindow> window, const CefRect&) override { h_->Relayout(); }

  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }
  bool CanResize(CefRefPtr<CefWindow>) override { return true; }
  bool CanMaximize(CefRefPtr<CefWindow>) override { return true; }
  bool CanMinimize(CefRefPtr<CefWindow>) override { return true; }
  bool CanClose(CefRefPtr<CefWindow>) override { return true; }
  CefRect GetInitialBounds(CefRefPtr<CefWindow>) override { return CefRect(0, 0, 1280, 800); }
  CefSize GetPreferredSize(CefRefPtr<CefView>) override { return CefSize(1280, 800); }

 private:
  CefRefPtr<HoloWindow> h_;
  IMPLEMENT_REFCOUNTING(HoloWindowDelegate);
  DISALLOW_COPY_AND_ASSIGN(HoloWindowDelegate);
};

#endif  // HOLO_CEF_WINDOW_H
