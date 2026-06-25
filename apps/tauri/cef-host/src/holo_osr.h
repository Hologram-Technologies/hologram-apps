// holo_osr.h — the off-screen browser PRODUCER for the projection substrate (P4). A real web page is
// rendered by Chromium OFF-SCREEN (Alloy windowless), so it is feature-complete and behaves exactly like
// Chrome — but it is never drawn to a window. Each painted frame is tiled, content-addressed (sha256, the κ
// namespace), and only NOVEL tiles are written to the shared κ web-cache (HoloWebCache → served at
// holo://os/cache/sha256/<hex>, L5-verified by the κ scheme). A compact per-frame manifest of the CHANGED
// tiles is pushed to the lens page (window.__holoOsrFrame), which composites them via the proven projection
// pipeline (holo-osr-lens.mjs → holo-projector → holo-webgpu-lens). So the page becomes a stream of
// κ-addressable objects projected on the metal — 100% projected, novelty-only, any device.
//
// INPUT (feature-complete to Chrome): the projector page captures DOM input on its canvas and forwards it via
// window.cefQuery('holo:osrinput:<json>'); the host routes it here (DispatchOsrInput) → the off-screen
// browser's host Send*Event. So a projected tab clicks, scrolls, and types exactly like a real Chrome tab.
//
// Constraint (verified, CEF 149 cef_types_win.h:121): windowless rendering forces the Alloy runtime, so this
// is a DEDICATED off-screen browser ALONGSIDE the Chrome-style shell (which keeps the real Chrome chrome).
//
// Authored against the host's existing interfaces (holo_sha256::Hex, HoloWebCache, kr_cache_put,
// kr_cache_get_kappa, the /os/cache/sha256 serving, CefParseJSON). Build-by-user.
#ifndef HOLO_CEF_OSR_H
#define HOLO_CEF_OSR_H

#include <chrono>
#include <map>
#include <string>

#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_registration.h"
#include "include/cef_render_handler.h"

namespace holo {

// Open `url` in a dedicated off-screen (Alloy windowless) browser whose frames stream as κ tiles to
// `lens_frame` (the holo:// projector page that defines window.__holoOsrFrame). w/h = the view size.
void OpenOsr(const std::string& url, CefRefPtr<CefFrame> lens_frame, int w, int h);

// Route a captured input event (the JSON payload of a 'holo:osrinput:<json>' bridge query) to the active
// off-screen browser. Called from the host's message-router query handler. No-op if no OSR browser is live.
void DispatchOsrInput(const std::string& json);

// Self-contained latency benchmark (no lens / no OS tree needed): open `url` off-screen, measure first-paint
// latency, steady paint FPS, and input→paint (the producer half of click-to-photon) on the real engine, log
// to stderr ("HOLO-OSR-BENCH:"), then quit the message loop. Triggered by env HOLO_OSR_BENCH=<url> in main.cc.
void BenchOsr(const std::string& url);

// LIVE end-to-end: open the real lens page (holo://os/usr/lib/holo/holo-osr-projector.html, the SEALED lens
// seam) AND, once it loads, an off-screen producer on `url` whose BLAKE3 κ-tiles flow through the cache to
// the lens, which fetches holo://os/cache/blake3/<hex> and composites. The whole chain in one open. Triggered
// by env HOLO_PROJECT_URL=<url>. Verify via CDP (:9333): the lens canvas shows the producer's pixels.
void ProjectBench(const std::string& url);

// The off-screen client: turns CefRenderHandler paints into a κ-tile stream, accepts forwarded input, and
// AUTO-SWITCHES per content. The default is the lossless pixel-native tile path (crisp UI/text, O(1) novelty).
// When it detects sustained high churn (video/animation) it PROMOTES to CDP screencast — Chromium-encoded JPEG
// frames, ~360x smaller than raw tiles, no ffmpeg, decoded by the lens's __holoScreencastFrame — so video stays
// smooth; when the motion stops it DEMOTES back to crisp tiles. So one projected tab is crisp where it should be
// and smooth where it must be, automatically. (HOLO_PROJECT_SCREENCAST=1 forces screencast always; the churn
// auto-switch is otherwise on by default and can be disabled with HOLO_PROJECT_NOAUTO=1.)
class HoloOsrClient : public CefClient,
                      public CefRenderHandler,
                      public CefLifeSpanHandler,
                      public CefDevToolsMessageObserver {
 public:
  HoloOsrClient(CefRefPtr<CefFrame> lens_frame, int w, int h, int tile = 256,
                bool forced_screencast = false, bool autoswitch = false)
      : lens_frame_(lens_frame), w_(w), h_(h), tile_(tile),
        screencast_(forced_screencast), forced_sc_(forced_screencast),
        auto_(autoswitch && !forced_screencast) {}

  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;   // attaches the CDP observer; starts screencast if forced
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override { browser_ = nullptr; dt_reg_ = nullptr; }

  // CefDevToolsMessageObserver — receive Page.screencastFrame (JPEG) and forward to the lens.
  void OnDevToolsEvent(CefRefPtr<CefBrowser> browser, const CefString& method, const void* params, size_t params_size) override;

  // CefRenderHandler
  void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override { rect = CefRect(0, 0, w_, h_); }
  void OnPaint(CefRefPtr<CefBrowser> browser,
               PaintElementType type,
               const RectList& dirtyRects,
               const void* buffer,
               int width,
               int height) override;
  // Zero-copy path (D3D11 shared texture). Enabled by HOLO_OSR_ACCEL=1 (CefWindowInfo::shared_texture_enabled);
  // when on, this fires INSTEAD of OnPaint with a shared D3D11 texture handle — the 8K-capable path. Currently
  // a feasibility probe (logs the handle); real tiling/hashing over the GPU texture is the next build.
  void OnAcceleratedPaint(CefRefPtr<CefBrowser> browser,
                          PaintElementType type,
                          const RectList& dirtyRects,
                          const CefAcceleratedPaintInfo& info) override;

  CefRefPtr<CefBrowser> browser() const { return browser_; }

 private:
  // Churn-driven mode transitions (CDP screencast on/off). Promote is called from OnPaint when motion is
  // sustained; demote from a self-rescheduling idle check when screencast frames stop arriving.
  void StartScreencast(const std::string& why);  // begin Page.startScreencast, watch for idle
  void StopScreencast(const std::string& why);   // stop screencast, force a repaint so tiling re-establishes
  void ScheduleDemoteCheck();             // post the next idle check (no-op if one is pending)
  void CheckDemoteIdle();                 // demote if no screencast frame for kDemoteIdleMs

  CefRefPtr<CefFrame> lens_frame_;
  CefRefPtr<CefBrowser> browser_;
  CefRefPtr<CefRegistration> dt_reg_;              // keeps the DevTools observer alive (screencast mode)
  std::map<std::string, std::string> last_kappa_;  // tile id ("t{cx}_{ry}") → last blake3 hex (delta state)
  bool screencast_ = false;                        // CURRENT mode: CDP JPEG screencast (true) vs raw tiles (false)
  bool forced_sc_ = false;                         // env-forced always-screencast (never auto-demotes)
  bool auto_ = false;                              // churn-driven tile↔screencast auto-switch enabled
  int hot_frames_ = 0;                             // consecutive high-churn paints (the promote counter)
  long dirty_total_ = 0, recur_total_ = 0;         // κ-LUT instrumentation: dirty tiles vs content-recurrences
  int stat_frames_ = 0;                            // frames since last κ-LUT stat log
  bool demote_scheduled_ = false;                  // an idle check is already queued
  std::chrono::steady_clock::time_point last_sc_;  // last screencast frame arrival (idle → demote to tiles)
  int sc_seq_ = 0;
  int w_, h_, tile_;
  int seq_ = 0;

  IMPLEMENT_REFCOUNTING(HoloOsrClient);
  DISALLOW_COPY_AND_ASSIGN(HoloOsrClient);
};

}  // namespace holo

#endif  // HOLO_CEF_OSR_H
