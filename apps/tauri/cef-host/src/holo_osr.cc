// holo_osr.cc — see holo_osr.h. Off-screen Alloy producer → κ tiles → lens, + forwarded input. Build-by-user.
#include "holo_osr.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"

#include "sha256.h"

// The shared κ web-cache (defined in handler.cc) and its Rust-backed put/get. Same cache the lightspeed
// open-web κ-cache and the Living Window use, so OSR tiles ride the EXISTING serving + dedup + shared transport.
struct KCache;
extern "C" {
void kr_cache_put(KCache* cache, const char* key, const uint8_t* bytes, size_t len, const char* mime, int immutable);
unsigned char kr_cache_get_kappa(KCache* cache, const char* hex, uint8_t** out, size_t* out_len, char** out_mime);   // returns u8 (0/1)
unsigned char kr_cache_get_b3(KCache* cache, const char* b3hex, uint8_t** out, size_t* out_len, char** out_mime);   // u8; fetch by σ-axis
void kr_sha256_hex(const uint8_t* data, size_t len, char* out_hex);   // Rust sha2 — uses SHA-NI hardware when present
void kr_blake3_hex(const uint8_t* data, size_t len, char* out_hex);   // Rust blake3 — the substrate's FAST σ-axis
void kr_free(uint8_t* ptr, size_t len);
void kr_cache_free_mime(char* m);
}
KCache* HoloWebCache();

namespace holo {

namespace {

// The active off-screen browser (the one being projected). Single projected tab for now; a map keyed by the
// projector frame generalizes to many. Set on OpenOsr; its host receives forwarded input.
CefRefPtr<HoloOsrClient> g_active_osr;

bool TileDirty(const HoloOsrClient::RectList& dirty, int tx, int ty, int tw, int th) {
  if (dirty.empty()) return true;  // empty ⇒ full repaint
  for (const CefRect& r : dirty)
    if (r.x < tx + tw && r.x + r.width > tx && r.y < ty + th && r.y + r.height > ty) return true;
  return false;
}

int IntOf(CefRefPtr<CefDictionaryValue> d, const char* k) { return d->HasKey(k) ? d->GetInt(k) : 0; }

}  // namespace

void HoloOsrClient::OnPaint(CefRefPtr<CefBrowser> browser,
                            PaintElementType type,
                            const RectList& dirtyRects,
                            const void* buffer,
                            int width,
                            int height) {
  if (screencast_) return;   // screencast mode streams Chromium-encoded JPEG via CDP (OnDevToolsEvent), not tiles
  if (type != PET_VIEW || !buffer || !lens_frame_) return;
  const uint8_t* src = static_cast<const uint8_t*>(buffer);  // BGRA, width*height*4, upper-left origin
  const int cols = (width + tile_ - 1) / tile_, rows = (height + tile_ - 1) / tile_;

  std::string tiles_json;
  bool first = true;
  int changed_tiles = 0, recur = 0;
  for (int ry = 0; ry < rows; ++ry) {
    for (int cx = 0; cx < cols; ++cx) {
      const int tx = cx * tile_, ty = ry * tile_;
      const int tw = std::min(tile_, width - tx), th = std::min(tile_, height - ty);
      if (!TileDirty(dirtyRects, tx, ty, tw, th)) continue;

      // Extract the tile, BGRA → RGBA (so κ tiles are RGBA throughout the substrate; the lens blits straight).
      std::string px;
      px.resize(static_cast<size_t>(tw) * th * 4);
      for (int row = 0; row < th; ++row) {
        const uint8_t* s = src + (static_cast<size_t>(ty + row) * width + tx) * 4;
        char* d = &px[static_cast<size_t>(row) * tw * 4];
        for (int i = 0; i < tw; ++i) {
          d[i * 4 + 0] = static_cast<char>(s[i * 4 + 2]);  // R ← B
          d[i * 4 + 1] = static_cast<char>(s[i * 4 + 1]);  // G
          d[i * 4 + 2] = static_cast<char>(s[i * 4 + 0]);  // B ← R
          d[i * 4 + 3] = static_cast<char>(s[i * 4 + 3]);  // A
        }
      }

      // Content-address per-frame tiles on the substrate's FAST σ-axis (BLAKE3), not sha256: a SIMD tree hash
      // ~5× faster than even hardware sha256 (webcache.rs measured it), and the κ store already serves
      // .holo/blake3/. Tiles are ephemeral, addressed purely by content — the blake3 σ-axis IS their identity.
      char hexbuf[65] = {0};
      kr_blake3_hex(reinterpret_cast<const uint8_t*>(px.data()), px.size(), hexbuf);
      const std::string hex(hexbuf);
      const std::string id = "t" + std::to_string(cx) + "_" + std::to_string(ry);
      if (last_kappa_[id] == hex) continue;  // slot unchanged ⇒ skip (delta)
      last_kappa_[id] = hex;
      ++changed_tiles;

      // κ-LUT: probe the resident κ cache by content address. A HIT means this exact tile content RECURRED
      // (scroll-back, repeated UI chrome, a looped video frame) ⇒ O(1) reuse, no re-encode/re-put — the
      // compute-∝-novelty win. A MISS is genuinely novel ⇒ publish. (Also frees the hit buffer — the prior
      // code probed but never freed it, leaking one tile's bytes per recurrence.)
      // Probe on the SAME axis the tile is addressed on — BLAKE3 (σ-axis), via kr_cache_get_b3. (The prior code
      // probed kr_cache_get_kappa, the sha256 axis, with a blake3 hex → it ALWAYS missed, so dedup never fired
      // and every tile was re-put. Fixed: now a resident tile is actually detected → real dedup + recurrence.)
      uint8_t* probe = nullptr; size_t plen = 0; char* pmime = nullptr;
      const bool resident = HoloWebCache() && kr_cache_get_b3(HoloWebCache(), hex.c_str(), &probe, &plen, &pmime) == 1;
      if (resident) {
        ++recur;
        if (probe) kr_free(probe, plen);
        if (pmime) kr_cache_free_mime(pmime);
      } else {
        kr_cache_put(HoloWebCache(), ("holo:osr:" + hex).c_str(),
                     reinterpret_cast<const uint8_t*>(px.data()), px.size(), "application/octet-stream", 1);
      }

      tiles_json += (first ? "" : ",");
      tiles_json += "{\"id\":\"" + id + "\",\"k\":\"did:holo:blake3:" + hex + "\"}";
      first = false;
    }
  }

  // κ-LUT instrumentation: accumulate dirty-tile vs content-recurrence counts and report the O(1) reuse rate.
  // This is the prompt's falsifiable bar made measurable on this host (where the GPU zero-copy path can't run):
  // recurrence% = the share of changed tiles served by an O(1) κ lookup instead of a fresh publish.
  dirty_total_ += changed_tiles; recur_total_ += recur;
  if (++stat_frames_ >= 120 && dirty_total_ > 0) {
    std::fprintf(stderr, "HOLO-OSR-KAPPA-LUT: %ld dirty tiles · %ld O(1) recurrences (%.1f%% reuse) · %ld novel over %d frames\n",
                 dirty_total_, recur_total_, 100.0 * recur_total_ / dirty_total_, dirty_total_ - recur_total_, stat_frames_);
    std::fflush(stderr);
    dirty_total_ = 0; recur_total_ = 0; stat_frames_ = 0;
  }

  // Churn-driven auto-switch: if a large fraction of the frame keeps changing paint after paint, this is
  // video/animation, not UI — the raw-tile path would stream gigabytes/s at pixel-native res, so PROMOTE to CDP
  // screencast (Chromium-encoded JPEG). Hysteresis: only after kPromoteFrames CONSECUTIVE high-churn paints, so
  // a one-off scroll burst or a blinking cursor (tiny fraction) does NOT promote. A return here stops tiling for
  // this frame — screencast takes over. Demote (back to crisp tiles) is handled by the idle check.
  if (auto_ && !screencast_) {
    const double frac = (cols * rows) ? static_cast<double>(changed_tiles) / (cols * rows) : 0.0;
    constexpr double kChurnHigh = 0.35;   // ≥35% of the frame changed this paint
    constexpr int kPromoteFrames = 24;    // sustained for ~0.4 s at 60 fps ⇒ real motion, not a scroll flick
    if (frac >= kChurnHigh) {
      if (++hot_frames_ >= kPromoteFrames) { StartScreencast("churn PROMOTE (sustained motion)"); return; }
    } else {
      hot_frames_ = 0;
    }
  }

  if (tiles_json.empty()) return;  // static page ⇒ zero bandwidth

  const std::string js = "window.__holoOsrFrame&&window.__holoOsrFrame({\"w\":" + std::to_string(width) +
                         ",\"h\":" + std::to_string(height) + ",\"tile\":" + std::to_string(tile_) +
                         ",\"seq\":" + std::to_string(seq_++) + ",\"tiles\":[" + tiles_json + "]})";
  lens_frame_->ExecuteJavaScript(js, lens_frame_->GetURL(), 0);
}

// Zero-copy GPU probe: fires when HOLO_OSR_ACCEL=1 (shared_texture_enabled). Logs the shared D3D11 texture
// handle + format so we can confirm the host can do GPU-accelerated OSR (the prerequisite for 8K). The real
// build opens this texture in our own D3D11 device, tiles + BLAKE3-hashes it on the GPU, and feeds the κ-LUT.
void HoloOsrClient::OnAcceleratedPaint(CefRefPtr<CefBrowser> browser, PaintElementType type,
                                       const RectList& dirtyRects, const CefAcceleratedPaintInfo& info) {
  static int n = 0;
  if (n < 3 || (n % 120) == 0) {
    std::fprintf(stderr, "HOLO-ACCEL-PAINT: #%d type=%d dirty=%zu handle=%p format=%d view=%dx%d\n",
                 n, static_cast<int>(type), dirtyRects.size(),
                 reinterpret_cast<void*>(info.shared_texture_handle), static_cast<int>(info.format), w_, h_);
    std::fflush(stderr);
  }
  ++n;
}

// Attach the CDP DevTools observer so screencast can be started on demand (whether forced now or promoted later
// by the churn router). Page.enable is harmless in tile mode; we only startScreencast when actually in/entering
// screencast mode. Pure-tile-only producers (neither forced nor auto) skip CDP entirely.
void HoloOsrClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  browser_ = browser;
  if (!forced_sc_ && !auto_) return;
  dt_reg_ = browser->GetHost()->AddDevToolsMessageObserver(this);
  browser->GetHost()->ExecuteDevToolsMethod(0, "Page.enable", nullptr);
  if (screencast_) StartScreencast("forced (HOLO_PROJECT_SCREENCAST)");
}

// PROMOTE: begin Chromium's CDP JPEG screencast for this off-screen page. OnPaint then early-returns (tiling
// stops); OnDevToolsEvent forwards each JPEG frame to the lens. Arms the idle watchdog so motion that stops
// demotes back to crisp tiles (unless screencast is env-forced, which never demotes).
void HoloOsrClient::StartScreencast(const std::string& why) {
  if (!browser_) return;
  CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
  params->SetString("format", "jpeg");
  params->SetInt("quality", 85);            // near-lossless for UI; tune for the video/quality tradeoff
  params->SetInt("everyNthFrame", 1);
  browser_->GetHost()->ExecuteDevToolsMethod(0, "Page.startScreencast", params);
  screencast_ = true;
  hot_frames_ = 0;
  last_sc_ = std::chrono::steady_clock::now();
  std::fprintf(stderr, "HOLO-PROJECT: screencast ON — %s\n", why.c_str()); std::fflush(stderr);
  if (!forced_sc_) ScheduleDemoteCheck();
}

// DEMOTE: stop screencast and force a full repaint so the tile path re-establishes the now-static frame as
// crisp, lossless, pixel-native κ tiles. Clearing last_kappa_ forces every slot to re-publish (the frame
// changed while we were in screencast). No-op when screencast is env-forced.
void HoloOsrClient::StopScreencast(const std::string& why) {
  if (!browser_ || forced_sc_ || !screencast_) return;
  browser_->GetHost()->ExecuteDevToolsMethod(0, "Page.stopScreencast", nullptr);
  screencast_ = false;
  hot_frames_ = 0;
  last_kappa_.clear();
  // Best-effort request to re-tile the now-static frame as crisp, lossless κ tiles. NOTE: on an unchanged Alloy
  // OSR surface neither Invalidate() nor a WasHidden toggle actually forces a fresh OnPaint (measured: the
  // producer stays idle until real content change), so the lens keeps showing the last screencast still — which
  // IS the correct frozen frame — and re-tiles losslessly on the next genuine repaint (scroll/click/animation).
  // The important effect of demote is unconditional: the screencast STREAM stops, so a paused video costs ~0.
  browser_->GetHost()->Invalidate(PET_VIEW);
  std::fprintf(stderr, "HOLO-PROJECT: screencast OFF → tiles — %s\n", why.c_str()); std::fflush(stderr);
}

void HoloOsrClient::ScheduleDemoteCheck() {
  if (demote_scheduled_ || forced_sc_) return;
  demote_scheduled_ = true;
  CefRefPtr<HoloOsrClient> self(this);
  CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<HoloOsrClient> s) { s->CheckDemoteIdle(); }, self), 300);
}

void HoloOsrClient::CheckDemoteIdle() {
  demote_scheduled_ = false;
  if (!screencast_ || forced_sc_) return;
  constexpr double kDemoteIdleMs = 450.0;   // no screencast frame this long ⇒ motion stopped ⇒ back to tiles
  const double idle =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - last_sc_).count();
  if (idle > kDemoteIdleMs) { StopScreencast("motion stopped (idle " + std::to_string(static_cast<int>(idle)) + "ms)"); return; }
  ScheduleDemoteCheck();   // still streaming → keep watching
}

// A Page.screencastFrame arrived (base64 JPEG): forward it to the lens (__holoScreencastFrame decodes + tiles +
// projects — witnessed) and ack so Chromium sends the next frame. Frames arrive ON CHANGE (static page ⇒ idle).
void HoloOsrClient::OnDevToolsEvent(CefRefPtr<CefBrowser> browser, const CefString& method, const void* params, size_t params_size) {
  if (method.ToString() != "Page.screencastFrame" || !lens_frame_) return;
  CefRefPtr<CefValue> v = CefParseJSON(std::string(static_cast<const char*>(params), params_size), JSON_PARSER_RFC);
  if (!v || v->GetType() != VTYPE_DICTIONARY) return;
  CefRefPtr<CefDictionaryValue> d = v->GetDictionary();
  const std::string data = d->HasKey("data") ? d->GetString("data").ToString() : "";
  const int session = d->HasKey("sessionId") ? d->GetInt("sessionId") : 0;
  if (data.empty()) return;
  last_sc_ = std::chrono::steady_clock::now();   // liveness for the idle watchdog (no frame ⇒ motion stopped ⇒ demote)
  const std::string js = "window.__holoScreencastFrame&&window.__holoScreencastFrame('data:image/jpeg;base64," +
                         data + "'," + std::to_string(sc_seq_++) + ")";
  lens_frame_->ExecuteJavaScript(js, lens_frame_->GetURL(), 0);
  CefRefPtr<CefDictionaryValue> ack = CefDictionaryValue::Create();
  ack->SetInt("sessionId", session);
  browser->GetHost()->ExecuteDevToolsMethod(0, "Page.screencastFrameAck", ack);
}

// Route a forwarded input event to the off-screen browser's host — so a projected tab is interactive like
// Chrome. payload = {"t":"move|down|up|wheel|keydown|char","x":..,"y":..,"b":0,"k":keycode,"c":charcode,"dy":..}
void DispatchOsrInput(const std::string& json) {
  if (!g_active_osr || !g_active_osr->browser()) return;
  CefRefPtr<CefValue> v = CefParseJSON(json, JSON_PARSER_RFC);
  if (!v || v->GetType() != VTYPE_DICTIONARY) return;
  CefRefPtr<CefDictionaryValue> d = v->GetDictionary();
  CefRefPtr<CefBrowserHost> host = g_active_osr->browser()->GetHost();
  const std::string t = d->HasKey("t") ? d->GetString("t").ToString() : "";

  CefMouseEvent m; m.x = IntOf(d, "x"); m.y = IntOf(d, "y"); m.modifiers = 0;
  if (t == "move") {
    host->SendMouseMoveEvent(m, false);
  } else if (t == "down" || t == "up") {
    host->SendMouseClickEvent(m, MBT_LEFT, /*mouseUp=*/t == "up", /*clickCount=*/1);
  } else if (t == "wheel") {
    host->SendMouseWheelEvent(m, 0, IntOf(d, "dy"));
  } else if (t == "keydown" || t == "char") {
    CefKeyEvent k; k.type = (t == "char") ? KEYEVENT_CHAR : KEYEVENT_RAWKEYDOWN;
    k.windows_key_code = IntOf(d, "k"); k.character = static_cast<char16_t>(IntOf(d, "c"));
    k.native_key_code = 0; k.modifiers = 0;
    host->SendKeyEvent(k);
  }
}

void OpenOsr(const std::string& url, CefRefPtr<CefFrame> lens_frame, int w, int h) {
  CEF_REQUIRE_UI_THREAD();
  CefWindowInfo window_info;
  window_info.SetAsWindowless(0);                 // off-screen ⇒ forces Alloy runtime (no Chrome window)
  const char* accel = std::getenv("HOLO_OSR_ACCEL");   // zero-copy GPU path probe: OnAcceleratedPaint instead of OnPaint
  if (accel && accel[0] == '1') window_info.shared_texture_enabled = 1;
  CefBrowserSettings settings;
  settings.windowless_frame_rate = 60;            // produce rate; present runs faster via holo-present-mailbox
  const char* sc = std::getenv("HOLO_PROJECT_SCREENCAST");   // force CDP JPEG screencast always (vs raw tiles)
  const char* noauto = std::getenv("HOLO_PROJECT_NOAUTO");   // disable the churn-driven tile↔screencast switch
  const bool forced = sc && sc[0] == '1';
  const bool autosw = !(noauto && noauto[0] == '1');         // auto-switch is ON by default ("just works")
  g_active_osr = new HoloOsrClient(lens_frame, w, h, 256, forced, autosw);
  CefBrowserHost::CreateBrowser(window_info, g_active_osr, url, settings, nullptr, nullptr);
}

namespace {

// A self-contained latency bench client: renders `url` off-screen and measures, on the REAL engine, the
// producer half of click-to-photon — first-paint latency and input→paint (a synthetic click that repaints).
class BenchClient : public CefClient, public CefRenderHandler, public CefLifeSpanHandler {
 public:
  BenchClient() {}
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  void OnAfterCreated(CefRefPtr<CefBrowser> b) override { browser_ = b; }
  void GetViewRect(CefRefPtr<CefBrowser>, CefRect& r) override { r = CefRect(0, 0, 1280, 800); }

  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList&, const void* buffer, int width, int height) override {
    if (type != PET_VIEW) return;
    const auto now = std::chrono::steady_clock::now();
    const auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
    ++paints_;
    if (paints_ == 1) { std::fprintf(stderr, "HOLO-OSR-BENCH: first-paint-ms %.2f\n", ms(open_, now)); std::fflush(stderr); }
    if (phase_ == 0 && paints_ >= 3) { phase_ = 1; awaiting_ = true; click_ = now; Click(); return; }
    if (phase_ == 1 && awaiting_) {
      const double d = ms(click_, now); sum_ += d; ++samples_; awaiting_ = false;
      std::fprintf(stderr, "HOLO-OSR-BENCH: input-to-paint-ms %.2f\n", d); std::fflush(stderr);
      if (samples_ >= 8) { std::fprintf(stderr, "HOLO-OSR-BENCH: avg-input-to-paint-ms %.2f over %d (producer half of click-to-photon)\n", sum_ / samples_, samples_); std::fflush(stderr); phase_ = 2; awaiting_ = true; Click(); }
      else { awaiting_ = true; click_ = now; Click(); }
      return;
    }
    // Phase 2 — the κ-PROCESSING cost: time the full per-frame tile + content-address work (BGRA→RGBA + sha256
    // per 256-tile) on the real painted buffer. This is the producer's κ overhead ON TOP of the frame; if it
    // doesn't fit ~a few ms, software sha256 is a bottleneck (→ hardware sha / dirty-rect-only / fewer tiles).
    if (phase_ == 2 && awaiting_ && buffer && width > 0) {
      awaiting_ = false;
      int tiles = 0;
      const uint8_t* buf = static_cast<const uint8_t*>(buffer);
      const double mb = static_cast<double>(width) * height * 4 / (1024.0 * 1024.0);
      const double sw = TileHashAll(buf, width, height, tiles, 0);   // portable software sha256
      const double hw = TileHashAll(buf, width, height, tiles, 1);   // Rust sha2 (SHA-NI hardware)
      const double b3 = TileHashAll(buf, width, height, tiles, 2);   // Rust blake3 (the substrate σ-axis)
      std::fprintf(stderr, "HOLO-OSR-BENCH: kappa-tiling %d tiles (%dx%d) — sw-sha256 %.2fms (%.0f MB/s) | hw-sha256 %.2fms (%.0f MB/s) | BLAKE3 %.2fms (%.0f MB/s) | b3 is %.1fx hw-sha, %.1fx sw-sha\n",
                   tiles, width, height, sw, mb / (sw / 1000.0), hw, mb / (hw / 1000.0), b3, mb / (b3 / 1000.0), hw / b3, sw / b3); std::fflush(stderr);

      // Once: prove the BLAKE3 cache serving path end-to-end at RUNTIME — content-address a tile, kr_cache_put
      // it, then fetch it back BY ITS BLAKE3 ADDRESS (kr_cache_get_b3, the new /os/cache/blake3/ route) and
      // confirm the bytes are identical. This is the producer→cache→serve-by-σ-axis leg the lens fetches over.
      if (ktimes_ == 0 && HoloWebCache()) {
        const int TILE = 256, tw = std::min(TILE, width), th = std::min(TILE, height);
        std::string px(static_cast<size_t>(tw) * th * 4, 0);
        for (int row = 0; row < th; ++row) { const uint8_t* s = buf + static_cast<size_t>(row) * width * 4; char* d = &px[static_cast<size_t>(row) * tw * 4];
          for (int i = 0; i < tw; ++i) { d[i * 4] = (char)s[i * 4 + 2]; d[i * 4 + 1] = (char)s[i * 4 + 1]; d[i * 4 + 2] = (char)s[i * 4]; d[i * 4 + 3] = (char)s[i * 4 + 3]; } }
        char b3hex[65] = {0}; kr_blake3_hex(reinterpret_cast<const uint8_t*>(px.data()), px.size(), b3hex);
        kr_cache_put(HoloWebCache(), ("holo:osrbench:" + std::string(b3hex)).c_str(), reinterpret_cast<const uint8_t*>(px.data()), px.size(), "application/octet-stream", 1);
        uint8_t* out = nullptr; size_t outlen = 0; char* mime = nullptr;
        const unsigned char hit = kr_cache_get_b3(HoloWebCache(), b3hex, &out, &outlen, &mime);
        const bool ok = hit == 1 && outlen == px.size() && out && std::memcmp(out, px.data(), px.size()) == 0;
        std::fprintf(stderr, "HOLO-OSR-BENCH: cache-roundtrip-blake3 %s (hit=%d, %zu/%zu bytes match) — producer→kr_cache_put→serve /os/cache/blake3/ verified\n", ok ? "OK" : "FAIL", (int)hit, ok ? outlen : 0, px.size()); std::fflush(stderr);
        if (out) kr_free(out, outlen);
        if (mime) kr_cache_free_mime(mime);
      }
      ++ktimes_;
      if (ktimes_ >= 4) { std::fprintf(stderr, "HOLO-OSR-BENCH: done\n"); std::fflush(stderr); CefQuitMessageLoop(); }
      else { awaiting_ = true; click_ = now; Click(); }
    }
    if (paints_ > 600) { std::fprintf(stderr, "HOLO-OSR-BENCH: timeout after %d paints\n", paints_); std::fflush(stderr); CefQuitMessageLoop(); }
  }

  std::chrono::steady_clock::time_point open_ = std::chrono::steady_clock::now();

 private:
  void Click() {
    if (!browser_) return;
    CefMouseEvent m; m.x = 640; m.y = 400; m.modifiers = 0;
    browser_->GetHost()->SendMouseClickEvent(m, MBT_LEFT, false, 1);
    browser_->GetHost()->SendMouseClickEvent(m, MBT_LEFT, true, 1);
  }
  // the exact per-frame κ work the production OnPaint does, over ALL tiles (worst case = full-frame churn):
  // BGRA→RGBA + sha256 per 256-tile. `useKr` picks the Rust SHA-NI hash vs the portable software one. Returns
  // elapsed ms; sets `tiles`.
  // alg: 0 = software sha256 (sha256.h), 1 = hardware sha256 (kr_sha256_hex/SHA-NI), 2 = blake3 (kr_blake3_hex).
  static double TileHashAll(const uint8_t* src, int width, int height, int& tiles, int alg) {
    const int TILE = 256, cols = (width + TILE - 1) / TILE, rows = (height + TILE - 1) / TILE;
    const auto t0 = std::chrono::steady_clock::now();
    tiles = 0;
    volatile char sink = 0;
    std::string px; char hex[65] = {0};
    for (int ry = 0; ry < rows; ++ry) for (int cx = 0; cx < cols; ++cx) {
      const int tx = cx * TILE, ty = ry * TILE, tw = std::min(TILE, width - tx), th = std::min(TILE, height - ty);
      px.resize(static_cast<size_t>(tw) * th * 4);
      for (int row = 0; row < th; ++row) {
        const uint8_t* s = src + (static_cast<size_t>(ty + row) * width + tx) * 4;
        char* d = &px[static_cast<size_t>(row) * tw * 4];
        for (int i = 0; i < tw; ++i) { d[i * 4] = (char)s[i * 4 + 2]; d[i * 4 + 1] = (char)s[i * 4 + 1]; d[i * 4 + 2] = (char)s[i * 4]; d[i * 4 + 3] = (char)s[i * 4 + 3]; }
      }
      const uint8_t* p = reinterpret_cast<const uint8_t*>(px.data());
      if (alg == 2) { kr_blake3_hex(p, px.size(), hex); sink ^= hex[0]; }
      else if (alg == 1) { kr_sha256_hex(p, px.size(), hex); sink ^= hex[0]; }
      else { const std::string h = holo_sha256::Hex(px); sink ^= h.empty() ? 0 : h[0]; }
      ++tiles;
    }
    (void)sink;
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  }
  CefRefPtr<CefBrowser> browser_;
  std::chrono::steady_clock::time_point click_;
  int paints_ = 0, phase_ = 0, samples_ = 0, ktimes_ = 0; bool awaiting_ = false; double sum_ = 0;
  IMPLEMENT_REFCOUNTING(BenchClient);
  DISALLOW_COPY_AND_ASSIGN(BenchClient);
};

}  // namespace

void BenchOsr(const std::string& url) {
  CEF_REQUIRE_UI_THREAD();
  CefWindowInfo window_info;
  window_info.SetAsWindowless(0);
  CefBrowserSettings settings;
  settings.windowless_frame_rate = 60;
  CefRefPtr<BenchClient> client(new BenchClient());
  client->open_ = std::chrono::steady_clock::now();
  CefBrowserHost::CreateBrowser(window_info, client, url, settings, nullptr, nullptr);
}

namespace {

// The LENS browser client: a normal visible tab showing the projector page. When it finishes loading, it
// opens the off-screen producer pointing AT this lens frame — so the producer's BLAKE3 κ-tiles stream here.
class LensClient : public CefClient, public CefLifeSpanHandler, public CefLoadHandler {
 public:
  explicit LensClient(std::string target) : target_(std::move(target)) {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int) override {
    if (!frame->IsMain() || opened_) return;
    opened_ = true;
    holo::OpenOsr(target_, frame, 1280, 800);   // producer → this lens frame (manifests via __holoOsrFrame)
    std::fprintf(stderr, "HOLO-PROJECT: lens loaded; off-screen producer opened on %s → streaming κ-tiles\n", target_.c_str());
    std::fflush(stderr);
  }
 private:
  std::string target_; bool opened_ = false;
  IMPLEMENT_REFCOUNTING(LensClient);
  DISALLOW_COPY_AND_ASSIGN(LensClient);
};

}  // namespace

void ProjectBench(const std::string& url) {
  CEF_REQUIRE_UI_THREAD();
  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Hologram — projected");
  window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;        // the lens is a normal visible tab
  CefBrowserSettings settings;
  CefBrowserHost::CreateBrowser(window_info, new LensClient(url),
                                "holo://os/usr/lib/holo/holo-osr-projector.html", settings, nullptr, nullptr);
}

}  // namespace holo
