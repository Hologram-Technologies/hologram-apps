// holo_osr.cc — see holo_osr.h. Off-screen Alloy producer → κ tiles → lens, + forwarded input. Build-by-user.
#include "holo_osr.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_parser.h"
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
  if (type != PET_VIEW || !buffer || !lens_frame_) return;
  const uint8_t* src = static_cast<const uint8_t*>(buffer);  // BGRA, width*height*4, upper-left origin
  const int cols = (width + tile_ - 1) / tile_, rows = (height + tile_ - 1) / tile_;

  std::string tiles_json;
  bool first = true;
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

      // Publish NOVEL tile bytes to the shared κ cache (dedup by κ; already-held tiles are not re-put).
      uint8_t* probe = nullptr; size_t plen = 0; char* pmime = nullptr;
      if (!(HoloWebCache() && kr_cache_get_kappa(HoloWebCache(), hex.c_str(), &probe, &plen, &pmime) == 1)) {
        kr_cache_put(HoloWebCache(), ("holo:osr:" + hex).c_str(),
                     reinterpret_cast<const uint8_t*>(px.data()), px.size(), "application/octet-stream", 1);
      }

      tiles_json += (first ? "" : ",");
      tiles_json += "{\"id\":\"" + id + "\",\"k\":\"did:holo:blake3:" + hex + "\"}";
      first = false;
    }
  }

  if (tiles_json.empty()) return;  // static page ⇒ zero bandwidth

  const std::string js = "window.__holoOsrFrame&&window.__holoOsrFrame({\"w\":" + std::to_string(width) +
                         ",\"h\":" + std::to_string(height) + ",\"tile\":" + std::to_string(tile_) +
                         ",\"seq\":" + std::to_string(seq_++) + ",\"tiles\":[" + tiles_json + "]})";
  lens_frame_->ExecuteJavaScript(js, lens_frame_->GetURL(), 0);
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
  CefBrowserSettings settings;
  settings.windowless_frame_rate = 60;            // produce rate; present runs faster via holo-present-mailbox
  g_active_osr = new HoloOsrClient(lens_frame, w, h);
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
                                "holo://os/lw/holo-osr-projector.html", settings, nullptr, nullptr);
}

}  // namespace holo
