// window.cc — branded chrome strip (tabs + omni) over a stack of content tabs. See window.h.
#include "window.h"

#include <string>

#include "include/cef_browser.h"
#include "include/views/cef_box_layout.h"
#include "include/views/cef_fill_layout.h"
#include "include/wrapper/cef_helpers.h"

namespace {
const int kChromeH = 86;  // tab row (~38) + omni row (~48)

enum MenuCmd { kNewTab = 1, kReload, kHome, kZoomIn, kZoomOut, kZoomReset, kCloseTab };

// Routes the native ⋮ menu's commands back to the window (held by the window; raw back-pointer is safe
// since the delegate's lifetime is the window's).
class MenuDelegate : public CefMenuModelDelegate {
 public:
  explicit MenuDelegate(HoloWindow* owner) : owner_(owner) {}
  void ExecuteCommand(CefRefPtr<CefMenuModel>, int command_id, cef_event_flags_t) override {
    switch (command_id) {
      case kNewTab: owner_->NewTab(std::string()); break;
      case kReload: owner_->Reload(); break;
      case kHome: owner_->GoHome(); break;
      case kZoomIn: owner_->Zoom(0.5); break;
      case kZoomOut: owner_->Zoom(-0.5); break;
      case kZoomReset: owner_->Zoom(0); break;
      case kCloseTab: owner_->CloseActive(); break;
    }
  }

 private:
  HoloWindow* owner_;
  IMPLEMENT_REFCOUNTING(MenuDelegate);
  DISALLOW_COPY_AND_ASSIGN(MenuDelegate);
};

std::string json_str(const std::string& s) {
  std::string o = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c == '\n' || c == '\r' || c == '\t') o += ' ';
    else o += c;
  }
  return o + "\"";
}
}  // namespace

void HoloWindow::OnWindowCreated(CefRefPtr<CefWindow> window) {
  CEF_REQUIRE_UI_THREAD();
  window_ = window;

  // Vertical BoxLayout: top inset reserves the chrome strip; the content panel (flex) fills below it.
  CefBoxLayoutSettings ls = {};
  ls.horizontal = false;
  ls.cross_axis_alignment = CEF_AXIS_ALIGNMENT_STRETCH;
  ls.inside_border_insets.top = kChromeH;
  CefRefPtr<CefBoxLayout> layout = window_->SetToBoxLayout(ls);

  // The content panel stacks the tab views (fill layout → each fills; only the active is visible).
  content_panel_ = CefPanel::CreatePanel(nullptr);
  content_panel_->SetToFillLayout();
  window_->AddChildView(content_panel_);
  layout->SetFlexForView(content_panel_, 1);

  // The branded chrome (tab strip + omni): a custom-docked overlay pinned to the reserved top strip.
  CefBrowserSettings settings;
  omni_ = CefBrowserView::CreateBrowserView(client_, omni_url_, settings, nullptr, nullptr,
                                            new AlloyBrowserViewDelegate());
  omni_ctrl_ = window_->AddOverlayView(omni_, CEF_DOCKING_MODE_CUSTOM, /*can_activate=*/true);
  omni_ctrl_->SetVisible(true);  // overlays are created HIDDEN — must be shown explicitly (was the empty bar)

  NewTab(std::string());  // open the first tab (home)
  Relayout();
  window_->Show();
}

void HoloWindow::OnWindowDestroyed() {
  window_ = nullptr;
  omni_ = nullptr;
  omni_ctrl_ = nullptr;
  content_panel_ = nullptr;
  tabs_.clear();
  titles_.clear();
}

void HoloWindow::Relayout() {
  if (!window_) {
    return;
  }
  const CefRect c = window_->GetClientAreaBoundsInScreen();  // w/h = client size
  if (omni_ctrl_) {
    omni_ctrl_->SetBounds(CefRect(0, 0, c.width, kChromeH));
  }
  window_->Layout();
}

CefRefPtr<CefBrowserView> HoloWindow::Active() const {
  auto it = tabs_.find(active_);
  return it != tabs_.end() ? it->second : nullptr;
}

int HoloWindow::IdForBrowser(CefRefPtr<CefBrowser> browser) const {
  for (const auto& kv : tabs_) {
    if (kv.second->GetBrowser() && kv.second->GetBrowser()->IsSame(browser)) {
      return kv.first;
    }
  }
  return 0;
}

void HoloWindow::ShowActive() {
  for (auto& kv : tabs_) {
    kv.second->SetVisible(kv.first == active_);
  }
  if (auto bv = Active()) {
    bv->RequestFocus();
    if (bv->GetBrowser()) {
      SetOmniText(bv->GetBrowser()->GetMainFrame()->GetURL().ToString());
    }
  }
}

void HoloWindow::NewTab(const std::string& url) {
  CEF_REQUIRE_UI_THREAD();
  if (!content_panel_) {
    return;
  }
  CefBrowserSettings settings;
  const CefString target = url.empty() ? home_url_ : CefString(url);
  CefRefPtr<CefBrowserView> bv = CefBrowserView::CreateBrowserView(
      client_, target, settings, nullptr, nullptr, new AlloyBrowserViewDelegate());
  const int id = next_id_++;
  tabs_[id] = bv;
  titles_[id] = "New tab";
  content_panel_->AddChildView(bv);
  active_ = id;
  ShowActive();
  PushTabs();
}

void HoloWindow::SelectTab(int id) {
  CEF_REQUIRE_UI_THREAD();
  if (tabs_.count(id)) {
    active_ = id;
    ShowActive();
    PushTabs();
  }
}

void HoloWindow::CloseTab(int id) {
  CEF_REQUIRE_UI_THREAD();
  auto it = tabs_.find(id);
  if (it == tabs_.end()) {
    return;
  }
  CefRefPtr<CefBrowserView> bv = it->second;
  if (content_panel_) {
    content_panel_->RemoveChildView(bv);
  }
  if (bv->GetBrowser()) {
    bv->GetBrowser()->GetHost()->CloseBrowser(false);
  }
  tabs_.erase(it);
  titles_.erase(id);
  if (tabs_.empty()) {
    NewTab(std::string());  // always keep at least one tab
    return;
  }
  if (active_ == id) {
    active_ = tabs_.rbegin()->first;  // activate the last remaining tab
  }
  ShowActive();
  PushTabs();
}

void HoloWindow::NavigateActive(const std::string& url) {
  CEF_REQUIRE_UI_THREAD();
  if (auto bv = Active()) {
    if (bv->GetBrowser()) {
      bv->GetBrowser()->GetMainFrame()->LoadURL(url);
    }
  }
}

void HoloWindow::Back() {
  if (auto bv = Active()) { if (auto b = bv->GetBrowser()) b->GoBack(); }
}
void HoloWindow::Forward() {
  if (auto bv = Active()) { if (auto b = bv->GetBrowser()) b->GoForward(); }
}
void HoloWindow::Reload() {
  if (auto bv = Active()) { if (auto b = bv->GetBrowser()) b->Reload(); }
}
void HoloWindow::GoHome() {
  NavigateActive(home_url_.ToString());
}

void HoloWindow::Zoom(double delta) {
  if (auto bv = Active()) {
    if (auto b = bv->GetBrowser()) {
      const double z = (delta == 0) ? 0.0 : b->GetHost()->GetZoomLevel() + delta;
      b->GetHost()->SetZoomLevel(z);
    }
  }
}

void HoloWindow::CloseActive() {
  CloseTab(active_);
}

void HoloWindow::ShowAppMenu() {
  CEF_REQUIRE_UI_THREAD();
  if (!window_) {
    return;
  }
  if (!menu_delegate_) {
    menu_delegate_ = new MenuDelegate(this);
  }
  CefRefPtr<CefMenuModel> m = CefMenuModel::CreateMenuModel(menu_delegate_);
  m->AddItem(kNewTab, "New tab");
  m->AddItem(kReload, "Reload");
  m->AddItem(kHome, "Home");
  m->AddSeparator();
  m->AddItem(kZoomIn, "Zoom in");
  m->AddItem(kZoomOut, "Zoom out");
  m->AddItem(kZoomReset, "Reset zoom");
  m->AddSeparator();
  m->AddItem(kCloseTab, "Close tab");
  const CefRect c = window_->GetClientAreaBoundsInScreen();
  const CefPoint at(c.x + c.width - 16, c.y + kChromeH - 6);  // just below the ⋮, top-right
  window_->ShowMenu(m, at, CEF_MENU_ANCHOR_TOPRIGHT);
}

void HoloWindow::OnContentAddress(CefRefPtr<CefBrowser> browser, const std::string& url) {
  if (IdForBrowser(browser) == active_) {
    SetOmniText(url);
  }
}

void HoloWindow::OnContentTitle(CefRefPtr<CefBrowser> browser, const std::string& title) {
  const int id = IdForBrowser(browser);
  if (id) {
    titles_[id] = title.empty() ? "New tab" : title;
    PushTabs();
  }
}

bool HoloWindow::IsChrome(CefRefPtr<CefBrowser> browser) const {
  return omni_ && omni_->GetBrowser() && omni_->GetBrowser()->IsSame(browser);
}

void HoloWindow::PushTabs() {
  if (!omni_ || !omni_->GetBrowser()) {
    return;
  }
  std::string arr = "[";
  bool first = true;
  for (const auto& kv : tabs_) {
    if (!first) arr += ",";
    first = false;
    auto t = titles_.find(kv.first);
    const std::string title = t != titles_.end() ? t->second : "New tab";
    arr += "{\"id\":" + std::to_string(kv.first) + ",\"title\":" + json_str(title) +
           ",\"active\":" + (kv.first == active_ ? "true" : "false") + "}";
  }
  arr += "]";
  omni_->GetBrowser()->GetMainFrame()->ExecuteJavaScript(
      "window.__setTabs && window.__setTabs(" + arr + ")", CefString(), 0);
}

void HoloWindow::SetOmniText(const std::string& url) {
  if (omni_ && omni_->GetBrowser()) {
    omni_->GetBrowser()->GetMainFrame()->ExecuteJavaScript(
        "window.__setOmni && window.__setOmni(" + json_str(url) + ")", CefString(), 0);
  }
}
