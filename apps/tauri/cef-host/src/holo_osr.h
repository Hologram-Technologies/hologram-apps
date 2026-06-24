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

#include <map>
#include <string>

#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_life_span_handler.h"
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

// LIVE end-to-end: open the real lens page (holo://os/lw/holo-osr-projector.html, served by the HOLO_LW_DIR
// seam) AND, once it loads, an off-screen producer on `url` whose BLAKE3 κ-tiles flow through the cache to
// the lens, which fetches holo://os/cache/blake3/<hex> and composites. The whole chain in one open. Triggered
// by env HOLO_PROJECT_URL=<url>. Verify via CDP (:9333): the lens canvas shows the producer's pixels.
void ProjectBench(const std::string& url);

// The off-screen client: turns CefRenderHandler paints into a κ-tile stream, and accepts forwarded input.
class HoloOsrClient : public CefClient, public CefRenderHandler, public CefLifeSpanHandler {
 public:
  HoloOsrClient(CefRefPtr<CefFrame> lens_frame, int w, int h, int tile = 256)
      : lens_frame_(lens_frame), w_(w), h_(h), tile_(tile) {}

  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override { browser_ = browser; }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override { browser_ = nullptr; }

  // CefRenderHandler
  void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override { rect = CefRect(0, 0, w_, h_); }
  void OnPaint(CefRefPtr<CefBrowser> browser,
               PaintElementType type,
               const RectList& dirtyRects,
               const void* buffer,
               int width,
               int height) override;
  // Zero-copy path (D3D11 shared texture). Wire after OnPaint is correct; falls back to OnPaint until then.
  void OnAcceleratedPaint(CefRefPtr<CefBrowser> browser,
                          PaintElementType type,
                          const RectList& dirtyRects,
                          const CefAcceleratedPaintInfo& info) override {}

  CefRefPtr<CefBrowser> browser() const { return browser_; }

 private:
  CefRefPtr<CefFrame> lens_frame_;
  CefRefPtr<CefBrowser> browser_;
  std::map<std::string, std::string> last_kappa_;  // tile id ("t{cx}_{ry}") → last sha256 hex (delta state)
  int w_, h_, tile_;
  int seq_ = 0;

  IMPLEMENT_REFCOUNTING(HoloOsrClient);
  DISALLOW_COPY_AND_ASSIGN(HoloOsrClient);
};

}  // namespace holo

#endif  // HOLO_CEF_OSR_H
