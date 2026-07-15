// holo_osr.cc — see holo_osr.h. Off-screen Alloy producer → κ tiles → lens, + forwarded input. Build-by-user.
#include "holo_osr.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_request_handler.h"   // LensClient self-heal: reload on render-process death
#include "include/cef_browser.h"
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"

#include "sha256.h"

// The shared κ web-cache (defined in handler.cc) and its Rust-backed put/get. Same cache the lightspeed
// open-web κ-cache and the Living Window use, so OSR tiles ride the EXISTING serving + dedup + shared transport.
struct KCache;
struct KShared;
extern "C" {
void kr_cache_put(KCache* cache, const char* key, const uint8_t* bytes, size_t len, const char* mime, int immutable);
unsigned char kr_cache_get_kappa(KCache* cache, const char* hex, uint8_t** out, size_t* out_len, char** out_mime);   // returns u8 (0/1)
unsigned char kr_cache_get_b3(KCache* cache, const char* b3hex, uint8_t** out, size_t* out_len, char** out_mime);   // u8; fetch by σ-axis
void kr_sha256_hex(const uint8_t* data, size_t len, char* out_hex);   // Rust sha2 — uses SHA-NI hardware when present
void kr_blake3_hex(const uint8_t* data, size_t len, char* out_hex);   // Rust blake3 — the substrate's FAST σ-axis
void kr_free(uint8_t* ptr, size_t len);
void kr_cache_free_mime(char* m);
// Planetary shared-κ transport (handler.cc SharedCache, dir-backed HOLO_SHARED_DIR). Cross-device projection
// publishes each novel tile here on the BLAKE3 σ-axis — the SAME canonical κ the producer already addresses tiles
// on (the substrate is blake3-canonical; no sha256 in the projection path). A lens on another node fetches the
// tile by its blake3 content address. Put recomputes/verifies the κ from the bytes — it cannot mislabel.
void kr_shared_put_b3(const KShared* c, const uint8_t* bytes, size_t len, const char* mime);
}
KCache* HoloWebCache();
KShared* HoloSharedCache();   // handler.cc — the shared-κ transport door (NULL ⇒ shared layer disabled)

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

// Scroll-acquisition tuning. The CDP evaluate self-throttles to one in-flight request, so kScrollPollMs is just
// a floor; kInputIdleMs decides when the page is no-longer-actively-wheel-scrolling (so the CDP truth, not the
// predictor, is authoritative — keyboard/JS/scrollbar scrolls land here); kSnapPx is the predictor-vs-truth
// drift past which we snap (page-end clamp, smooth-scroll overshoot) rather than tolerate a misaligned grid.
constexpr int kScrollEvalId = 0x5C011;   // our message_id for Runtime.evaluate("scrollY") results
constexpr double kScrollPollMs = 8.0;
constexpr double kInputIdleMs = 60.0;
constexpr double kSnapPx = 32.0;

// The shared κ dir — identical resolution to handler.cc SharedCache(): HOLO_SHARED_DIR, else %TEMP%\holo-shared-kappa.
std::string SharedDir() {
  if (const char* d = std::getenv("HOLO_SHARED_DIR")) return d;
  const char* t = std::getenv("TEMP"); if (!t) t = std::getenv("TMP");
  return std::string(t ? t : ".") + "\\holo-shared-kappa";
}

// Cross-device manifest CHANNEL (the seam a WAN transport — κ-DHT/WebRTC — swaps into later). Drop the latest
// per-frame manifest (tiny: κ refs only) where a remote lens node reads it. Atomic-ish (write tmp → replace) so a
// poller never sees a half-written file. The tile BYTES travel separately, by content address, over the shared-κ.
void PublishManifest(const std::string& json) {
  const std::string dir = SharedDir();
  const std::string path = dir + "\\proj-manifest.json";
  const std::string tmp = dir + "\\proj-manifest.tmp";
  { std::ofstream f(tmp, std::ios::binary | std::ios::trunc); if (!f) return; f.write(json.data(), static_cast<std::streamsize>(json.size())); }
  std::remove(path.c_str());
  std::rename(tmp.c_str(), path.c_str());
}

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
  const int TILE = tile_;
  const int cols = (width + TILE - 1) / TILE, rows = (height + TILE - 1) / TILE;

  // Content-space tiling: address tiles by their row in the PAGE (document coordinates), not the screen. The
  // page is tiled at a vertical PHASE offset phaseY = scrollY mod TILE so a 256-px content row maps to a fixed
  // document boundary regardless of scroll → a fully-visible content tile keeps the SAME bytes (and the same κ)
  // as the page scrolls, so it recurs O(1) instead of re-hashing as "novel". Needs the page's scrollY at paint
  // time (OnPaint has none): the predictor advanced it on forwarded wheel; refresh the CDP truth here.
  MaybeRequestScroll();
  const long sy = content_mode_ ? CurrentScrollEstimate() : 0;
  const int phaseY = content_mode_ ? static_cast<int>(((sy % TILE) + TILE) % TILE) : 0;
  const bool scrolled = content_mode_ && (sy != last_tiled_scroll_);

  std::string tiles_json;
  bool first = true;
  int changed_tiles = 0, recur = 0, edges = 0;
  // Walk content rows: the first (partial) row's screen top is at -phaseY, then a full TILE every step. In
  // screen mode this degenerates to the old fixed grid (phaseY=0, prow=ry, id "t{cx}_{ry}").
  for (int ry = 0;; ++ry) {
    const int screenTop = content_mode_ ? (ry * TILE - phaseY) : (ry * TILE);
    if (screenTop >= height) break;
    const long prow = content_mode_ ? (sy + screenTop) / TILE : ry;   // exact integer document row
    // A tile is FULL when its whole TILE-tall extent is on screen; otherwise it is a top/bottom MARGIN tile
    // (the off-screen rows are padded deterministically, below). Horizontal clipping of the last column is fine
    // and stable (its width is constant), so completeness is a VERTICAL property only.
    const bool vFull = content_mode_ ? (screenTop >= 0 && screenTop + TILE <= height) : true;
    for (int cx = 0; cx < cols; ++cx) {
      const int tx = cx * TILE;
      const int tw = std::min(TILE, width - tx);
      const int th = content_mode_ ? TILE : std::min(TILE, height - ry * TILE);
      const int visTop = std::max(0, screenTop), visBot = std::min(height, screenTop + th);
      if (visBot <= visTop) continue;   // nothing of this tile is on screen
      // When the page scrolled, every visible tile's SCREEN position shifted, so the lens must re-place it —
      // emit them all (bytes are reused via the κ cache, only the publish/fetch is novelty-bound). When not
      // scrolling, fall back to the screen-space dirty test so a static page costs zero bandwidth. SHARE mode
      // bypasses the dirty test: it processes ALL visible tiles every paint so the channel manifest is a full
      // KEYFRAME (a remote lens that joins mid-stream composites completely; only NOVEL tile bytes cross the wire).
      if (!scrolled && !share_ && !TileDirty(dirtyRects, tx, visTop, tw, visBot - visTop)) continue;

      // Extract the tile, BGRA → RGBA (so κ tiles are RGBA throughout the substrate; the lens blits straight).
      // Off-screen margin rows are zero-padded DETERMINISTICALLY: a full tile is pure content (stable κ); a
      // partial tile hashes by its visible extent (inherently novel each scroll step, but only ~2 rows of them)
      // and converges to the canonical full κ the instant it becomes fully visible.
      std::string px;
      px.resize(static_cast<size_t>(tw) * th * 4);
      for (int row = 0; row < th; ++row) {
        const int sRow = screenTop + row;
        char* d = &px[static_cast<size_t>(row) * tw * 4];
        if (sRow >= 0 && sRow < height) {
          const uint8_t* s = src + (static_cast<size_t>(sRow) * width + tx) * 4;
          for (int i = 0; i < tw; ++i) {
            d[i * 4 + 0] = static_cast<char>(s[i * 4 + 2]);  // R ← B
            d[i * 4 + 1] = static_cast<char>(s[i * 4 + 1]);  // G
            d[i * 4 + 2] = static_cast<char>(s[i * 4 + 0]);  // B ← R
            d[i * 4 + 3] = static_cast<char>(s[i * 4 + 3]);  // A
          }
        } else {
          std::memset(d, 0, static_cast<size_t>(tw) * 4);    // deterministic pad for an off-screen margin row
        }
      }

      // Content-address per-frame tiles on the substrate's FAST σ-axis (BLAKE3), not sha256: a SIMD tree hash
      // ~5× faster than even hardware sha256 (webcache.rs measured it), and the κ store already serves
      // .holo/blake3/. Tiles are ephemeral, addressed purely by content — the blake3 σ-axis IS their identity.
      char hexbuf[65] = {0};
      kr_blake3_hex(reinterpret_cast<const uint8_t*>(px.data()), px.size(), hexbuf);
      const std::string hex(hexbuf);
      const std::string id = content_mode_
          ? ("c" + std::to_string(cx) + "_" + std::to_string(prow))
          : ("t" + std::to_string(cx) + "_" + std::to_string(ry));
      // Emit when the κ changed OR (content mode) the page scrolled and this tile's screen position moved. The
      // scroll clause is what makes the lens re-place an unchanged-content tile at its new screen row.
      const bool kChanged = (last_kappa_[id] != hex);
      const bool genuine = kChanged || scrolled;   // a genuine change/move vs a share-mode full-frame re-emit
      // A local-only producer streams DELTAS (changed/moved tiles). A SHARE producer emits ALL visible tiles
      // every paint — a full KEYFRAME — so a remote lens that joins mid-stream composites completely (refs are
      // tiny; only NOVEL tile BYTES cross the wire). The idle case (page stops painting) is covered by the
      // republish timer below, which re-drops the last full frame on the channel.
      if (!genuine && !share_) continue;
      last_kappa_[id] = hex;
      const bool edge = content_mode_ && !vFull;
      // κ-LUT metric: count only GENUINE changes (not a share keyframe re-emit of a static tile), and only FULL
      // content tiles (stable bytes) — that is the content win the falsifiable bar measures.
      if (genuine) { if (edge) ++edges; else ++changed_tiles; }

      // κ-LUT + publish: only for a GENUINE change (a static keyframe re-emit is already resident locally AND
      // already in the shared-κ from when it was first novel, so it needs neither probe nor re-put). Probe on the
      // SAME axis the tile is addressed on — BLAKE3 (σ-axis), via kr_cache_get_b3; a HIT ⇒ O(1) reuse, a MISS ⇒ publish.
      if (genuine) {
      uint8_t* probe = nullptr; size_t plen = 0; char* pmime = nullptr;
      const bool resident = HoloWebCache() && kr_cache_get_b3(HoloWebCache(), hex.c_str(), &probe, &plen, &pmime) == 1;
      if (resident) {
        if (!edge) ++recur;
        if (probe) kr_free(probe, plen);
        if (pmime) kr_cache_free_mime(pmime);
      } else {
        kr_cache_put(HoloWebCache(), ("holo:osr:" + hex).c_str(),
                     reinterpret_cast<const uint8_t*>(px.data()), px.size(), "application/octet-stream", 1);
        // Cross-device: publish this novel tile to the shared-κ transport on the BLAKE3 σ-axis — the same
        // canonical κ the manifest already carries (kr_shared_put_b3 recomputes + verifies the κ from the bytes).
        if (share_ && HoloSharedCache()) {
          kr_shared_put_b3(HoloSharedCache(), reinterpret_cast<const uint8_t*>(px.data()), px.size(), "application/octet-stream");
          last_share_sha_.assign(hex);
          ++shared_n_;
        }
      }
      }   // end if(genuine) — publish/probe only on a real change

      tiles_json += (first ? "" : ",");
      tiles_json += "{\"id\":\"" + id + "\",\"k\":\"did:holo:blake3:" + hex + "\"";   // blake3 is THE wire axis (local + remote)
      if (content_mode_) {
        tiles_json += ",\"prow\":" + std::to_string(prow) + ",\"cx\":" + std::to_string(cx);
        if (edge) tiles_json += ",\"edge\":1";
      }
      tiles_json += "}";
      first = false;
    }
  }
  last_tiled_scroll_ = sy;
  edge_total_ += edges;

  // κ-LUT instrumentation: accumulate dirty-tile vs content-recurrence counts and report the O(1) reuse rate.
  // This is the prompt's falsifiable bar made measurable on this host (where the GPU zero-copy path can't run):
  // recurrence% = the share of changed tiles served by an O(1) κ lookup instead of a fresh publish.
  dirty_total_ += changed_tiles; recur_total_ += recur;
  if (++stat_frames_ >= 120 && dirty_total_ > 0) {
    const double residAvg = resid_n_ ? resid_sum_ / resid_n_ : 0.0;
    std::fprintf(stderr,
                 "HOLO-OSR-KAPPA-LUT: %ld full-tile changes · %ld O(1) recurrences (%.1f%% reuse) · %ld novel · "
                 "%ld edge(margin) tiles over %d frames | scroll-acq resid avg %.1fpx max %.0fpx (%ld samples)%s\n",
                 dirty_total_, recur_total_, 100.0 * recur_total_ / dirty_total_, dirty_total_ - recur_total_,
                 edge_total_, stat_frames_, residAvg, resid_max_, resid_n_, content_mode_ ? "" : " [screen-space]");
    std::fflush(stderr);
    if (share_) {
      std::fprintf(stderr, "HOLO-OSR-SHARE: published %ld tiles to shared-κ (cross-device); sample blake3 %s\n",
                   shared_n_, last_share_sha_.c_str());
      std::fflush(stderr);
      shared_n_ = 0;
    }
    dirty_total_ = 0; recur_total_ = 0; stat_frames_ = 0; edge_total_ = 0;
    resid_sum_ = 0; resid_max_ = 0; resid_n_ = 0;
  }

  // Churn-driven auto-switch: if a large fraction of the frame keeps changing paint after paint, this is
  // video/animation, not UI — the raw-tile path would stream gigabytes/s at pixel-native res, so PROMOTE to CDP
  // screencast (Chromium-encoded JPEG). Hysteresis: only after kPromoteFrames CONSECUTIVE high-churn paints, so
  // a one-off scroll burst or a blinking cursor (tiny fraction) does NOT promote. A return here stops tiling for
  // this frame — screencast takes over. Demote (back to crisp tiles) is handled by the idle check.
  if (auto_ && !screencast_) {
    if (scrolled) {
      hot_frames_ = 0;   // scrolling re-emits everything but is NOT video motion — content tiling handles it cheaply; never promote on scroll
    } else {
      const double frac = (cols * rows) ? static_cast<double>(changed_tiles) / (cols * rows) : 0.0;
      constexpr double kChurnHigh = 0.35;   // ≥35% of the frame changed this paint (independent of scroll)
      constexpr int kPromoteFrames = 24;    // sustained for ~0.4 s at 60 fps ⇒ real motion (video), not a one-off repaint
      if (frac >= kChurnHigh) {
        if (++hot_frames_ >= kPromoteFrames) { StartScreencast("churn PROMOTE (sustained motion)"); return; }
      } else {
        hot_frames_ = 0;
      }
    }
  }

  if (tiles_json.empty()) return;  // static page ⇒ zero bandwidth

  std::string manifest = "{\"w\":" + std::to_string(width) + ",\"h\":" + std::to_string(height) +
                         ",\"tile\":" + std::to_string(tile_);
  if (content_mode_)   // carry the frame's scroll so the lens places content tiles at prow·TILE − scrollY
    manifest += ",\"scrollY\":" + std::to_string(sy) + ",\"phaseY\":" + std::to_string(phaseY);
  manifest += ",\"seq\":" + std::to_string(seq_++) + ",\"tiles\":[" + tiles_json + "]}";
  lens_frame_->ExecuteJavaScript("window.__holoOsrFrame&&window.__holoOsrFrame(" + manifest + ")", lens_frame_->GetURL(), 0);
  if (share_) PublishManifest(manifest);   // cross-device: drop the manifest on the channel for a remote lens node
}

// Self-scroll bench step: send a wheel event to the producer's OWN host (exactly like a forwarded user wheel)
// and advance the predictor, then re-post. Ping-pongs down/up over ~11k px so the κ-LUT log captures many
// windows of ACTIVE scroll. Inert unless HOLO_OSR_SELFSCROLL is set.
void HoloOsrClient::DoSelfScroll() {
  if (!browser_ || !self_scroll_) return;
  const int step = -64 * self_scroll_dir_;   // dir=+1 ⇒ scroll DOWN (negative wheel Δ ⇒ scrollY increases)
  CefMouseEvent m; m.x = w_ / 2; m.y = h_ / 2; m.modifiers = 0;
  browser_->GetHost()->SendMouseWheelEvent(m, 0, step);
  NotifyScroll(step);                          // feed the predictor just like DispatchOsrInput would
  self_scroll_pos_ += self_scroll_dir_;
  if (self_scroll_pos_ > 180) self_scroll_dir_ = -1;
  else if (self_scroll_pos_ < 1) self_scroll_dir_ = 1;
  CefRefPtr<HoloOsrClient> self(this);
  CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<HoloOsrClient> s) { s->DoSelfScroll(); }, self), 16);
}

// Cross-device REVERSE channel: a remote lens node writes the viewer's input (seq + latest wheel) to
// proj-input.json; the producer applies it here so a remote viewer DRIVES the scene (then the scrolled tiles
// flow back over the manifest channel). Same payload shape as DispatchOsrInput; the seq cursor avoids replay.
// The net round-trip is hidden by the remote lens's present-side reproject, exactly like the local present-lag.
void HoloOsrClient::PollInput() {
  if (share_ && browser_) {
    std::ifstream f(SharedDir() + "\\proj-input.json", std::ios::binary);
    if (f) {
      std::stringstream ss; ss << f.rdbuf();
      CefRefPtr<CefValue> v = CefParseJSON(ss.str(), JSON_PARSER_RFC);
      if (v && v->GetType() == VTYPE_DICTIONARY) {
        CefRefPtr<CefDictionaryValue> d = v->GetDictionary();
        const long seq = d->HasKey("seq") ? static_cast<long>(d->GetInt("seq")) : 0;   // CefParseJSON gives INT for 1,2,… (GetDouble→0)
        if (seq > last_input_seq_) {
          last_input_seq_ = seq;
          const std::string t = d->HasKey("t") ? d->GetString("t").ToString() : "";
          CefMouseEvent m; m.x = IntOf(d, "x"); m.y = IntOf(d, "y"); m.modifiers = 0;
          if (m.x == 0 && m.y == 0) { m.x = w_ / 2; m.y = h_ / 2; }
          if (t == "wheel") { const int dy = IntOf(d, "dy"); NotifyScroll(dy); browser_->GetHost()->SendMouseWheelEvent(m, 0, dy); }
          else if (t == "down" || t == "up") { browser_->GetHost()->SendMouseClickEvent(m, MBT_LEFT, t == "up", 1); }
          else if (t == "move") { browser_->GetHost()->SendMouseMoveEvent(m, false); }
        }
      }
    }
  }
  CefRefPtr<HoloOsrClient> self(this);
  CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<HoloOsrClient> s) { s->PollInput(); }, self), 16);
}

// Predictor leg: a forwarded wheel event tells us, synchronously and with zero CDP lag, how far the page is
// about to scroll. dy is the wheel delta we forwarded (= −deltaY), so the document scrollY changes by −dy.
// Clamp at the top (scrollY ≥ 0); the page-bottom clamp and any momentum/smooth-scroll overshoot are corrected
// by the authoritative CDP value. Runs on the UI thread (same as OnPaint), so no locking.
// Attach a SYNCHRONOUS scroll reporter to the producer page. The page's own 'scroll' event fires as the scroll
// position updates (before the compositor paints that scroll), so pushing scrollY from there — through the
// __holoScroll binding added in OnAfterCreated — reaches the host with far less lag than the poll→evaluate
// round-trip (which reads scrollY ~1-2 frames stale). Lower lag ⇒ scroll_y_ matches the buffer at paint ⇒ a
// tighter, more consistent content phase ⇒ higher O(1) reuse. Idempotent (guards window.__holoScrollHook).
void HoloOsrClient::OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int) {
  if (!content_mode_ || !frame || !frame->IsMain()) return;
  frame->ExecuteJavaScript(
      "(function(){if(window.__holoScrollHook)return;window.__holoScrollHook=1;"
      "var r=function(){try{window.__holoScroll&&window.__holoScroll(''+((window.scrollY|0)||"
      "(document.scrollingElement&&document.scrollingElement.scrollTop|0)||0))}catch(e){}};"
      "addEventListener('scroll',r,{passive:true,capture:true});r();})()",
      frame->GetURL(), 0);
}

void HoloOsrClient::NotifyScroll(int dy) {
  if (!content_mode_) return;
  scroll_y_ = std::max(0L, scroll_y_ - dy);   // zero-lag hint between binding reports; each binding re-snaps it
  last_input_ = std::chrono::steady_clock::now();
}

// The scroll estimate for THIS paint. Empirically, content-tile RECURRENCE wants a SMOOTH, frame-to-frame
// CONSISTENT phase, NOT a minimal-mean-error one: a steady ~1-frame lag keeps a content tile on the same
// document grid line across frames (so it recurs), whereas velocity extrapolation — though it lowers the mean
// residual — injects CDP-timing jitter that knocks tiles off the grid and DROPS reuse. So we return the bare
// binding anchor (re-snapped each report, nudged by NotifyScroll between): smooth beats twitchy. (scroll_vel_
// is still measured for the residual log / future use.)
long HoloOsrClient::CurrentScrollEstimate() {
  return scroll_y_ < 0 ? 0 : scroll_y_;
}

// Throttled authoritative scroll: ask the off-screen page for window.scrollY over CDP. Self-throttles to one
// in-flight request (the result arrives in OnDevToolsMethodResult ~1 frame later). Requires the DevTools
// observer, which OnAfterCreated attaches whenever auto-switch or forced-screencast is on (the default).
void HoloOsrClient::MaybeRequestScroll() {
  if (!content_mode_ || !browser_ || !dt_reg_) return;
  const auto now = std::chrono::steady_clock::now();
  if (std::chrono::duration<double, std::milli>(now - last_scroll_eval_).count() < kScrollPollMs) return;
  last_scroll_eval_ = now;
  // Fire-and-forget evaluate that READS scrollY and pushes it back through the binding — the binding's reply
  // arrives as Runtime.bindingCalled (the proven event channel), sidestepping the unreliable method-RESULT path
  // and any listener-attachment timing. Runs in whatever the page's current document is, so no load-order race.
  CefRefPtr<CefDictionaryValue> p = CefDictionaryValue::Create();
  p->SetString("expression",
               "window.__holoScroll&&window.__holoScroll(''+((window.scrollY|0)||"
               "(document.scrollingElement&&document.scrollingElement.scrollTop|0)||0))");
  browser_->GetHost()->ExecuteDevToolsMethod(kScrollEvalId, "Runtime.evaluate", p);
}

// Authoritative scroll arrived. Reconcile with the predictor: log the residual (the prompt's acquisition-lag
// risk, made measurable), and correct scroll_y_ when the page is NOT being actively wheel-scrolled (keyboard /
// JS / scrollbar scrolls, where the predictor has no signal) or when the predictor has drifted past kSnapPx
// (page-end clamp, smooth-scroll overshoot). During an active wheel scroll a small residual is left alone so
// the grid advances smoothly with the user's input rather than sawtoothing on every CDP reply.
void HoloOsrClient::OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int message_id, bool success,
                                           const void* result, size_t result_size) {
  if (message_id != kScrollEvalId) return;
  scroll_eval_inflight_ = false;
  if (!success || !result || !result_size) return;
  CefRefPtr<CefValue> v = CefParseJSON(std::string(static_cast<const char*>(result), result_size), JSON_PARSER_RFC);
  if (!v || v->GetType() != VTYPE_DICTIONARY) return;
  CefRefPtr<CefDictionaryValue> d = v->GetDictionary();
  if (!d->HasKey("result")) return;
  CefRefPtr<CefDictionaryValue> r = d->GetDictionary("result");
  if (!r || !r->HasKey("value")) return;
  CefRefPtr<CefValue> val = r->GetValue("value");
  const double auth = (val && val->GetType() == VTYPE_INT) ? static_cast<double>(val->GetInt())
                                                           : (val ? val->GetDouble() : 0.0);
  const double resid = static_cast<double>(scroll_y_) - auth;
  resid_sum_ += std::fabs(resid);
  if (std::fabs(resid) > resid_max_) resid_max_ = std::fabs(resid);
  ++resid_n_;
  const double idle = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - last_input_).count();
  if (idle > kInputIdleMs || std::fabs(resid) > kSnapPx) scroll_y_ = static_cast<long>(auth + 0.5);
}

// Zero-copy GPU path (HOLO_OSR_ACCEL=1, shared_texture_enabled): fires INSTEAD of OnPaint with a shared D3D11
// texture handle. We open that texture on our OWN device, copy it into a CPU-readable staging texture, map it,
// and run the SAME κ tiling the software OnPaint proves — so a GPU-composited frame becomes a stream of
// did:holo:blake3 κ tiles (the σ-axis), exactly like the software path, closing the last unwired projection leg.
// Additive: this does not touch OnPaint. Build-gated to Windows/D3D11 (the only platform CEF shares a texture on).
#ifdef _WIN32
bool HoloOsrClient::EnsureD3D() {
  if (d3d_dev_ && d3d_ctx_) return true;
  const D3D_FEATURE_LEVEL want[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
  D3D_FEATURE_LEVEL got;
  const HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT, want, 2, D3D11_SDK_VERSION, &d3d_dev_, &got, &d3d_ctx_);
  if (FAILED(hr)) { std::fprintf(stderr, "HOLO-ACCEL: D3D11CreateDevice failed 0x%08lx\n", static_cast<unsigned long>(hr)); std::fflush(stderr); return false; }
  return true;
}

void HoloOsrClient::OnAcceleratedPaint(CefRefPtr<CefBrowser> browser, PaintElementType type,
                                       const RectList& dirtyRects, const CefAcceleratedPaintInfo& info) {
  if (screencast_) return;                       // motion is on the CDP JPEG path; tiling stops (mirrors OnPaint)
  if (type != PET_VIEW || !lens_frame_ || !info.shared_texture_handle) return;
  if (!EnsureD3D()) return;

  HANDLE h = reinterpret_cast<HANDLE>(info.shared_texture_handle);
  ID3D11Texture2D* shared = nullptr;
  // Modern CEF shares an NT handle (OpenSharedResource1 on ID3D11Device1); older builds a legacy KMT handle.
  ID3D11Device1* dev1 = nullptr;
  if (SUCCEEDED(d3d_dev_->QueryInterface(__uuidof(ID3D11Device1), reinterpret_cast<void**>(&dev1))) && dev1) {
    dev1->OpenSharedResource1(h, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&shared));
    dev1->Release();
  }
  if (!shared) d3d_dev_->OpenSharedResource(h, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&shared));
  if (!shared) { static bool once = false; if (!once) { once = true; std::fprintf(stderr, "HOLO-ACCEL: OpenSharedResource failed (handle=%p format=%d)\n", reinterpret_cast<void*>(h), static_cast<int>(info.format)); std::fflush(stderr); } return; }

  D3D11_TEXTURE2D_DESC desc; shared->GetDesc(&desc);
  if (!stage_tex_ || stage_w_ != static_cast<int>(desc.Width) || stage_h_ != static_cast<int>(desc.Height)) {
    if (stage_tex_) { stage_tex_->Release(); stage_tex_ = nullptr; }
    D3D11_TEXTURE2D_DESC s = {};
    s.Width = desc.Width; s.Height = desc.Height; s.MipLevels = 1; s.ArraySize = 1;
    s.Format = desc.Format; s.SampleDesc.Count = 1; s.Usage = D3D11_USAGE_STAGING; s.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(d3d_dev_->CreateTexture2D(&s, nullptr, &stage_tex_))) { shared->Release(); return; }
    stage_w_ = static_cast<int>(desc.Width); stage_h_ = static_cast<int>(desc.Height);
    std::fprintf(stderr, "HOLO-ACCEL: readback ready %ux%u fmt=%d — GPU frame -> CPU staging -> blake3 kappa tiles\n", desc.Width, desc.Height, static_cast<int>(desc.Format)); std::fflush(stderr);
  }
  d3d_ctx_->CopyResource(stage_tex_, shared);
  shared->Release();

  D3D11_MAPPED_SUBRESOURCE map;
  if (FAILED(d3d_ctx_->Map(stage_tex_, 0, D3D11_MAP_READ, 0, &map))) return;
  EmitAccelTiles(static_cast<const uint8_t*>(map.pData), static_cast<int>(map.RowPitch),
                 static_cast<int>(desc.Width), static_cast<int>(desc.Height));
  d3d_ctx_->Unmap(stage_tex_, 0);
}

// The accel-path tiler: same content-addressing the software OnPaint proves, over the GPU-readback buffer.
// Screen-space tiles (id "t{cx}_{ry}", matching the lens's screen-space placement); each tile is BGRA->RGBA,
// BLAKE3-hashed on the sigma-axis, delta-emitted only on kappa-change, novel bytes put to the kappa cache, and
// the first emitted tile is re-derivation self-tested (put -> fetch by blake3 address -> memcmp) — the native I2 proof.
void HoloOsrClient::EmitAccelTiles(const uint8_t* src, int rowPitch, int width, int height) {
  const int TILE = tile_;
  const int cols = (width + TILE - 1) / TILE, rows = (height + TILE - 1) / TILE;
  std::string tiles_json; bool first = true; int changed = 0;
  for (int ry = 0; ry < rows; ++ry) for (int cx = 0; cx < cols; ++cx) {
    const int tx = cx * TILE, ty = ry * TILE, tw = std::min(TILE, width - tx), th = std::min(TILE, height - ty);
    std::string px; px.resize(static_cast<size_t>(tw) * th * 4);
    for (int row = 0; row < th; ++row) {
      const uint8_t* s = src + static_cast<size_t>(ty + row) * rowPitch + static_cast<size_t>(tx) * 4;  // RowPitch != width*4
      char* d = &px[static_cast<size_t>(row) * tw * 4];
      for (int i = 0; i < tw; ++i) { d[i * 4] = static_cast<char>(s[i * 4 + 2]); d[i * 4 + 1] = static_cast<char>(s[i * 4 + 1]); d[i * 4 + 2] = static_cast<char>(s[i * 4]); d[i * 4 + 3] = static_cast<char>(s[i * 4 + 3]); }
    }
    char hexbuf[65] = {0};
    kr_blake3_hex(reinterpret_cast<const uint8_t*>(px.data()), px.size(), hexbuf);
    const std::string hex(hexbuf);
    const std::string id = "t" + std::to_string(cx) + "_" + std::to_string(ry);
    if (last_kappa_[id] == hex) continue;                 // delta on the blake3 sigma-axis (unchanged => no emit)
    last_kappa_[id] = hex; ++changed;

    uint8_t* probe = nullptr; size_t plen = 0; char* pmime = nullptr;
    const bool resident = HoloWebCache() && kr_cache_get_b3(HoloWebCache(), hex.c_str(), &probe, &plen, &pmime) == 1;
    if (resident) { if (probe) kr_free(probe, plen); if (pmime) kr_cache_free_mime(pmime); }
    else kr_cache_put(HoloWebCache(), ("holo:osr:" + hex).c_str(), reinterpret_cast<const uint8_t*>(px.data()), px.size(), "application/octet-stream", 1);

    // One-shot native I2 proof on the accel path: fetch the tile back BY ITS BLAKE3 ADDRESS and byte-compare.
    if (!accel_selftest_ && HoloWebCache()) {
      accel_selftest_ = true;
      uint8_t* out = nullptr; size_t outlen = 0; char* mime = nullptr;
      const unsigned char hit = kr_cache_get_b3(HoloWebCache(), hex.c_str(), &out, &outlen, &mime);
      const bool ok = hit == 1 && outlen == px.size() && out && std::memcmp(out, px.data(), px.size()) == 0;
      std::fprintf(stderr, "HOLO-ACCEL-REDERIVE: tile %s did:holo:blake3:%s — cache-roundtrip %s (%zu bytes) — accel-path tile re-derives to its kappa\n", id.c_str(), hex.c_str(), ok ? "OK" : "FAIL", px.size()); std::fflush(stderr);
      if (out) kr_free(out, outlen); if (mime) kr_cache_free_mime(mime);
    }

    tiles_json += (first ? "" : ",");
    tiles_json += "{\"id\":\"" + id + "\",\"k\":\"did:holo:blake3:" + hex + "\"}";
    first = false;
  }
  accel_emitted_ += changed;
  if (++accel_frames_ >= 120) {
    std::fprintf(stderr, "HOLO-ACCEL-TILES: %ld blake3 kappa tiles emitted on the GPU zero-copy path over %d frames (did:holo:blake3 sigma-axis)\n", accel_emitted_, accel_frames_); std::fflush(stderr);
    accel_emitted_ = 0; accel_frames_ = 0;
  }
  if (tiles_json.empty()) return;                          // static frame => zero bandwidth (mirrors OnPaint)
  const std::string manifest = "{\"w\":" + std::to_string(width) + ",\"h\":" + std::to_string(height) +
      ",\"tile\":" + std::to_string(tile_) + ",\"seq\":" + std::to_string(seq_++) + ",\"accel\":1,\"tiles\":[" + tiles_json + "]}";
  lens_frame_->ExecuteJavaScript("window.__holoOsrFrame&&window.__holoOsrFrame(" + manifest + ")", lens_frame_->GetURL(), 0);
}
#else
void HoloOsrClient::OnAcceleratedPaint(CefRefPtr<CefBrowser> browser, PaintElementType type,
                                       const RectList& dirtyRects, const CefAcceleratedPaintInfo& info) {
  (void)browser; (void)type; (void)dirtyRects; (void)info;   // non-Windows: no D3D11 shared texture to read back
}
#endif

// Attach the CDP DevTools observer so screencast can be started on demand (whether forced now or promoted later
// by the churn router). Page.enable is harmless in tile mode; we only startScreencast when actually in/entering
// screencast mode. Pure-tile-only producers (neither forced nor auto) skip CDP entirely.
void HoloOsrClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  browser_ = browser;
  // Self-scroll bench: after the page settles, drive a sustained wheel scroll on the producer itself so the
  // content-space reuse% is measurable on the real engine with no lens/CDP/network in the loop.
  if (std::getenv("HOLO_OSR_SHARE")) {   // cross-device: also publish novel tiles to the shared-κ transport
    share_ = true;
    std::fprintf(stderr, "HOLO-OSR-SHARE: armed (publishing tiles to the shared-κ for cross-device projection)\n");
    std::fflush(stderr);
    CefRefPtr<HoloOsrClient> self(this);   // also drive the producer from the remote lens's REVERSE input channel
    CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<HoloOsrClient> s) { s->PollInput(); }, self), 3000);
  }
  if (std::getenv("HOLO_OSR_SELFSCROLL")) {   // arm in EITHER mode so the content-vs-screen A/B uses one bench
    self_scroll_ = true;
    CefRefPtr<HoloOsrClient> self(this);
    CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<HoloOsrClient> s) { s->DoSelfScroll(); }, self), 3000);
    std::fprintf(stderr, "HOLO-OSR-SELFSCROLL: armed (producer self-scroll bench)\n"); std::fflush(stderr);
  }
  if (!forced_sc_ && !auto_) return;
  dt_reg_ = browser->GetHost()->AddDevToolsMessageObserver(this);
  browser->GetHost()->ExecuteDevToolsMethod(0, "Page.enable", nullptr);
  // PUSHED scroll reporter (content-space tiling's authoritative acquisition). The async Runtime.evaluate result
  // path proved unreliable on the off-screen producer (0 results delivered), so instead expose a CDP binding the
  // page calls on every real scroll: Runtime.addBinding creates window.__holoScroll(x), and an injected listener
  // reports the page's ACTUAL scrollY as it scrolls. The reply arrives as Runtime.bindingCalled in OnDevToolsEvent
  // — the SAME proven channel screencast frames use. This tracks the buffer's true scroll (not the predictor's
  // lead), giving a consistent phase → content tiles align → O(1) recurrence.
  if (content_mode_) {
    browser->GetHost()->ExecuteDevToolsMethod(0, "Runtime.enable", nullptr);
    CefRefPtr<CefDictionaryValue> bind = CefDictionaryValue::Create();
    bind->SetString("name", "__holoScroll");
    browser->GetHost()->ExecuteDevToolsMethod(0, "Runtime.addBinding", bind);
    CefRefPtr<CefDictionaryValue> src = CefDictionaryValue::Create();
    src->SetString("source",
                   "(function(){function r(){try{window.__holoScroll(''+Math.round(window.scrollY||"
                   "(document.scrollingElement&&document.scrollingElement.scrollTop)||0))}catch(e){}}"
                   "addEventListener('scroll',r,{passive:true,capture:true});"
                   "document.addEventListener('DOMContentLoaded',r);setTimeout(r,0);})()");
    browser->GetHost()->ExecuteDevToolsMethod(0, "Page.addScriptToEvaluateOnNewDocument", src);
  }
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
  const std::string mname = method.ToString();
  // Pushed scroll report: the page called window.__holoScroll(scrollY). This is the AUTHORITATIVE scroll for
  // content-space tiling — the page's real scrollTop as it scrolls, on the reliable event channel. Snap the
  // estimate to it (the predictor only fills the sub-event gaps) and log the residual it corrected.
  if (mname == "Runtime.bindingCalled") {
    CefRefPtr<CefValue> v = CefParseJSON(std::string(static_cast<const char*>(params), params_size), JSON_PARSER_RFC);
    if (!v || v->GetType() != VTYPE_DICTIONARY) return;
    CefRefPtr<CefDictionaryValue> d = v->GetDictionary();
    if (!d->HasKey("name") || d->GetString("name").ToString() != "__holoScroll") return;
    if (!d->HasKey("payload")) return;
    const long auth = std::atol(d->GetString("payload").ToString().c_str());
    // Residual = how far the estimate we ACTUALLY tiled with (scroll_y_) was from the freshly-reported truth —
    // the real acquisition error that bounds reuse. Then re-snap to truth.
    const double resid = static_cast<double>(scroll_y_) - static_cast<double>(auth);
    resid_sum_ += std::fabs(resid); if (std::fabs(resid) > resid_max_) resid_max_ = std::fabs(resid); ++resid_n_;
    const auto now = std::chrono::steady_clock::now();
    const double dt = std::chrono::duration<double, std::milli>(now - scroll_t_).count();
    if (dt > 2.0 && dt < 200.0) scroll_vel_ = 0.6 * scroll_vel_ + 0.4 * (auth - scroll_y_) / dt;  // measured, for the log
    scroll_y_ = auth;
    scroll_t_ = now;
    return;
  }
  if (mname != "Page.screencastFrame" || !lens_frame_) return;
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
    const int dy = IntOf(d, "dy");
    g_active_osr->NotifyScroll(dy);   // predictor: advance the scroll estimate now (before the resulting repaint)
    host->SendMouseWheelEvent(m, 0, dy);
  } else if (t == "keydown" || t == "char") {
    CefKeyEvent k; k.type = (t == "char") ? KEYEVENT_CHAR : KEYEVENT_RAWKEYDOWN;
    k.windows_key_code = IntOf(d, "k"); k.character = static_cast<char16_t>(IntOf(d, "c"));
    k.native_key_code = 0; k.modifiers = 0;
    host->SendKeyEvent(k);
  }
}

void OpenOsr(const std::string& url, CefRefPtr<CefFrame> lens_frame, int w, int h) {
  CEF_REQUIRE_UI_THREAD();
  // Re-attach support: close any previous off-screen producer so a RELOADED lens (e.g. after a renderer
  // self-heal, or a re-fired holo:osrready) gets a fresh producer streaming to its NEW frame — never an
  // orphaned producer streaming into a dead frame. Cheap; the producer is a single off-screen browser.
  if (g_active_osr && g_active_osr->browser())
    g_active_osr->browser()->GetHost()->CloseBrowser(true);
  CefWindowInfo window_info;
  window_info.SetAsWindowless(0);                 // off-screen producer
  // CEF 149 runtime mode: the process default is CHROME (settings.chrome_runtime unset → Chrome). OSR /
  // OnPaint / OnAcceleratedPaint are ALLOY-only — a windowless browser left at the default Chrome style does
  // NOT render (MEASURED 2026-06-28: producer opened at the right res but emitted 0 frames on OnPaint,
  // OnAcceleratedPaint AND CDP screencast; host logged CefWebContentsViewOSR::GetTopLevelNativeWindow() Not
  // implemented). SetAsWindowless alone forced Alloy in OLDER CEF; 149 requires the per-window style to be set
  // explicitly (every other window in this host already sets CEF_RUNTIME_STYLE_CHROME). So pin the producer to
  // Alloy — Chrome top-level windows + an Alloy windowless producer coexist per-browser in one process.
  window_info.runtime_style = CEF_RUNTIME_STYLE_ALLOY;
  const char* accel = std::getenv("HOLO_OSR_ACCEL");   // zero-copy GPU path probe: OnAcceleratedPaint instead of OnPaint
  if (accel && accel[0] == '1') window_info.shared_texture_enabled = 1;
  CefBrowserSettings settings;
  settings.windowless_frame_rate = 120;           // produce cap raised 60→120 (8c): lifts the artificial ceiling so low/medium-churn pages emit up to 120 fresh dirty-tile frames/s; heavy-churn/full-frame 8K stays bandwidth-bound regardless (the 8K path is reconstruct-via-super-res, not moving 127MB frames). present is already decoupled + faster via holo-present-mailbox.
  const char* sc = std::getenv("HOLO_PROJECT_SCREENCAST");   // force CDP JPEG screencast always (vs raw tiles)
  const char* noauto = std::getenv("HOLO_PROJECT_NOAUTO");   // disable the churn-driven tile↔screencast switch
  const char* noctn = std::getenv("HOLO_OSR_NOCONTENT");     // A/B: disable content-space tiling (legacy screen-space grid)
  const bool forced = sc && sc[0] == '1';
  const bool autosw = !(noauto && noauto[0] == '1');         // auto-switch is ON by default ("just works")
  const bool content = !(noctn && noctn[0] == '1');          // content-space tiling ON by default (scroll-stable κ)
  g_active_osr = new HoloOsrClient(lens_frame, w, h, 256, forced, autosw, content);
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
class LensClient : public CefClient, public CefLifeSpanHandler, public CefLoadHandler, public CefRequestHandler {
 public:
  explicit LensClient(std::string target) : target_(std::move(target)) {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  // Fires on the FIRST load AND on every reload (e.g. a renderer-death self-heal). (Re)attach the producer to
  // THIS — possibly new — lens frame; OpenOsr closes the previous producer first, so recovery re-projects from
  // resident κ on a fresh frame instead of streaming into a dead one.
  void OnLoadEnd(CefRefPtr<CefBrowser> /*browser*/, CefRefPtr<CefFrame> frame, int) override {
    if (!frame->IsMain()) return;
    retry_start_ = std::chrono::steady_clock::time_point{};   // a good load → reset the cold-boot grace window
    holo::OpenOsr(target_, frame, 1280, 800);
    std::fprintf(stderr, "HOLO-PROJECT: lens loaded; off-screen producer (re)opened on %s → streaming κ-tiles\n", target_.c_str());
    std::fflush(stderr);
  }
  // SUPERVISE the lens's OWN load: on a cold boot the κ store may still be OPENING when the lens's first holo://
  // load lands → a transient ERR_INVALID_RESPONSE (the dominant cause of "lens never surfaced"). LensClient is
  // its own client, so SimpleHandler's canonical-entry grace doesn't cover it — retry here within a 12s
  // wall-clock grace (matches the shell's), then give up rather than spin. This is what makes a projected tab
  // reliably appear at boot instead of intermittently; the supervised-NODE path gets this for free from the
  // shell, this gives the popup/bench path the same robustness.
  void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, ErrorCode errorCode,
                   const CefString& errorText, const CefString& /*failedUrl*/) override {
    if (!frame || !frame->IsMain() || errorCode == ERR_ABORTED) return;   // ERR_ABORTED = navigation replaced, not a failure
    const auto now = std::chrono::steady_clock::now();
    if (retry_start_ == std::chrono::steady_clock::time_point{}) retry_start_ = now;
    const double elapsed = std::chrono::duration<double, std::milli>(now - retry_start_).count();
    if (elapsed > 12000.0) {
      std::fprintf(stderr, "HOLO-PROJECT: lens load failed past grace (%s) — giving up\n", errorText.ToString().c_str());
      std::fflush(stderr);
      return;
    }
    std::fprintf(stderr, "HOLO-PROJECT: lens transient load error (%d) — retry in 250ms (%.0f/12000ms)\n", errorCode, elapsed);
    std::fflush(stderr);
    CefRefPtr<CefBrowser> b = browser;
    CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<CefBrowser> br) { if (br) br->Reload(); }, b), 250);
  }
  // CefRequestHandler — self-heal: a lens renderer death (commonly a network-service-crash cascade) reloads the
  // lens; OnLoadEnd then re-attaches the producer. The lens content is local sealed κ, so the reload is fast.
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser, TerminationStatus /*status*/,
                                 int /*error_code*/, const CefString& /*error_string*/) override {
    std::fprintf(stderr, "HOLO-PROJECT: lens renderer died — self-heal reload\n"); std::fflush(stderr);
    if (browser) browser->Reload();
  }
 private:
  std::string target_;
  std::chrono::steady_clock::time_point retry_start_;   // cold-boot load-retry grace window start
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
  // WAN: HOLO_PROJECT_WAN=offer opens this (producer) lens in WebRTC-offer mode so it forwards each manifest to a
  // remote node over a real datachannel (tiles still ride the shared-κ). The signaling SDP is read off the page
  // via CDP (harness / holo-dial). Absent ⇒ the normal local lens.
  std::string lensUrl = "holo://os/usr/lib/holo/holo-osr-projector.html";
  const char* wan = std::getenv("HOLO_PROJECT_WAN");
  if (wan && std::string(wan) == "offer") lensUrl += "?wan=offer";
  CefBrowserHost::CreateBrowser(window_info, new LensClient(url), lensUrl, settings, nullptr, nullptr);
}

namespace {

// The CROSS-DEVICE remote lens (node B): opens the projector page with NO local producer and feeds it the
// manifest another node drops on the channel (proj-manifest.json in the shared dir). The projector's "s"-tile
// path fetches each tile by content address over the shared-κ transport (sha256 axis), so the scene rendered on
// node A composites here. No CefMessageRouter ⇒ the page's holo:osrready never opens a producer here (intended).
class RemoteLensClient : public CefClient, public CefLifeSpanHandler, public CefLoadHandler {
 public:
  RemoteLensClient() {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int) override {
    if (!frame->IsMain()) return;
    lens_frame_ = frame;
    std::fprintf(stderr, "HOLO-REMOTE-LENS: lens loaded; polling the manifest channel (%s)\n", SharedDir().c_str());
    std::fflush(stderr);
    if (!polling_) { polling_ = true; Poll(); }
  }
  void Poll() {
    // WAN mode: the lens receives manifests over the WebRTC datachannel, not the file — stop polling (don't
    // reschedule) so the only manifest source is the real network transport (proves it end-to-end).
    if (std::getenv("HOLO_PROJECT_WAN")) return;
    if (lens_frame_) {
      std::ifstream f(SharedDir() + "\\proj-manifest.json", std::ios::binary);
      if (f) {
        std::stringstream ss; ss << f.rdbuf();
        const std::string j = ss.str();
        // Only drive on a complete, changed manifest (atomic publish makes half-writes rare; sanity-check anyway).
        if (j.size() > 2 && j != last_ && j.front() == '{' && j.back() == '}') {
          last_ = j;
          lens_frame_->ExecuteJavaScript("window.__holoOsrFrame&&window.__holoOsrFrame(" + j + ")", lens_frame_->GetURL(), 0);
          if ((++frames_ % 120) == 1) { std::fprintf(stderr, "HOLO-REMOTE-LENS: composited %ld manifests from the channel\n", frames_); std::fflush(stderr); }
        }
      }
    }
    CefRefPtr<RemoteLensClient> self(this);
    CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<RemoteLensClient> s) { s->Poll(); }, self), 16);
  }
 private:
  CefRefPtr<CefFrame> lens_frame_;
  bool polling_ = false;
  long frames_ = 0;
  std::string last_;
  IMPLEMENT_REFCOUNTING(RemoteLensClient);
  DISALLOW_COPY_AND_ASSIGN(RemoteLensClient);
};

}  // namespace

void ProjectRemote() {
  CEF_REQUIRE_UI_THREAD();
  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Hologram — remote lens");
  window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
  CefBrowserSettings settings;
  // WAN: HOLO_PROJECT_WAN=answer opens the remote lens in WebRTC-answer mode — it receives manifests over the
  // datachannel (the file poller is disabled below), tiles still by κ over the shared/mesh transport.
  std::string lensUrl = "holo://os/usr/lib/holo/holo-osr-projector.html?remote=1";
  const char* wan = std::getenv("HOLO_PROJECT_WAN");
  if (wan && std::string(wan) == "answer") lensUrl += "&wan=answer";
  CefBrowserHost::CreateBrowser(window_info, new RemoteLensClient(), lensUrl, settings, nullptr, nullptr);
}

}  // namespace holo
