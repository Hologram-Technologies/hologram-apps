// handler.cc — browser tracking + the origin-tiered Hologram bridge (the seam's security boundary).
#include "handler.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <set>
#include <string>
#include <unordered_set>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_frame.h"
#include "include/cef_request.h"
#include "include/cef_response.h"
#include "include/cef_response_filter.h"
#include "include/cef_parser.h"       // CefBase64Encode — CRX bytes → base64 for the install front door
#include "include/cef_urlrequest.h"   // host-side CRX fetch (browser process = no CORS) for the installer
#include "include/cef_request_context.h"  // dock-side preference for DevTools (currentDockState=right)
#include "include/cef_values.h"           // CefValue / CefDictionaryValue for the devtools preference
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"

#include "kappa_route.h"  // kr_sha256_hex — the verifier's own content-address hash

namespace {
// ── Ad/tracker removal: the request-blocking ruleset. (P0: embedded; the κ-native next step ships this
// as an L5-verified, content-addressed ruleset object so "what filters am I running?" resolves to one κ.)
// Matched by HOST SUFFIX so every CDN/subdomain variant (pagead2.googlesyndication.com, securepubads…)
// is covered by a single entry. High-confidence ad/tracker networks only, to avoid first-party breakage.
const char* const kAdHosts[] = {
    "doubleclick.net", "googlesyndication.com", "googleadservices.com",
    "google-analytics.com", "googletagservices.com", "adservice.google.com",
    "amazon-adsystem.com", "adnxs.com", "adsrvr.org", "pubmatic.com",
    "rubiconproject.com", "openx.net", "criteo.com", "criteo.net",
    "taboola.com", "outbrain.com", "scorecardresearch.com", "quantserve.com",
    "quantcast.com", "2mdn.net", "moatads.com", "adform.net", "casalemedia.com",
    "bidswitch.net", "smartadserver.com", "teads.tv", "sharethrough.com",
    "yieldmo.com", "indexww.com", "3lift.com", "adsafeprotected.com",
    "doubleverify.com", "adcolony.com", "applovin.com", "inmobi.com",
    "smaato.com", "zedo.com", "yieldlab.net", "contextweb.com", "gumgum.com",
    "media.net", "advertising.com", "serving-sys.com", "demdex.net",
    "everesttech.net", "bluekai.com", "agkn.com", "rlcdn.com", "crwdcntrl.net",
    "tapad.com", "adroll.com", "krxd.net", "id5-sync.com", "adgrx.com",
    "adsymptotic.com", "amplitude.com", "branch.io", "mathtag.com",
    "nr-data.net", "omtrdc.net", "chartbeat.com", "sentry.io", "hotjar.com",
};

std::string HostOf(const std::string& url) {
  const size_t s = url.find("://");
  if (s == std::string::npos) return "";
  const size_t b = s + 3;
  const size_t e = url.find_first_of("/:?#", b);
  return url.substr(b, (e == std::string::npos ? url.size() : e) - b);
}

// The comprehensive ruleset: ~98k ad/tracker domains (merged Peter Lowe + hagezi-light + AdAway),
// loaded ONCE from $HOLO_ADBLOCK_LIST into a hash set so matching is O(domain-labels) per request —
// microseconds, no rule engine. This is the κ-addressed ad ruleset (the file is content-addressed;
// swap the file to swap what's blocked). The small embedded kAdHosts above is the always-on baseline
// that works even if the file is absent. Empty file/unset env ⇒ just the baseline.
std::unordered_set<std::string> g_ad_hosts;
bool g_ad_hosts_loaded = false;

void LoadAdHostsOnce() {
  if (g_ad_hosts_loaded) return;
  g_ad_hosts_loaded = true;
  const char* path = std::getenv("HOLO_ADBLOCK_LIST");
  if (!path || !path[0]) return;
  std::ifstream f(path);
  std::string line;
  g_ad_hosts.reserve(100000);
  while (std::getline(f, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#' || line[0] == '!') continue;
    g_ad_hosts.insert(line);
  }
}

// True iff the request host is, or is a subdomain of, a denylisted ad/tracker domain. Checks the
// always-on embedded baseline (suffix), then the big ruleset by walking parent domains (full host →
// registrable domain) so a listed domain blocks all its subdomains.
bool IsAdRequest(const std::string& url) {
  const std::string host = HostOf(url);
  if (host.empty()) return false;
  for (const char* d : kAdHosts) {
    const size_t dl = std::strlen(d);
    if (host.size() >= dl && host.compare(host.size() - dl, dl, d) == 0 &&
        (host.size() == dl || host[host.size() - dl - 1] == '.')) {
      return true;
    }
  }
  LoadAdHostsOnce();
  if (!g_ad_hosts.empty()) {
    std::string h = host;
    while (true) {
      if (g_ad_hosts.find(h) != g_ad_hosts.end()) return true;
      const size_t dot = h.find('.');
      if (dot == std::string::npos) break;
      const std::string rest = h.substr(dot + 1);
      if (rest.find('.') == std::string::npos) break;  // stop at the registrable domain, not the TLD
      h = rest;
    }
  }
  return false;
}

// ── Content-κ denylist (the keystone). A set of sha256 hex content addresses of known ad/tracker
// PAYLOADS. Blocking by this address — not by URL — means a denylisted ad object is refused wherever it
// is served (rotated domains, first-party-proxied, CDN-shuffled): all defeated, because the bytes still
// re-derive to a denylisted κ. Loaded once from the file at $HOLO_AD_KAPPA (one lowercase sha256 per
// line; '#' comments). Empty ⇒ content-κ filtering is OFF (zero overhead) — this is a κ-addressed, L5-
// spirit ruleset: swap the file (a new content set) to change what is refused.
std::set<std::string> g_ad_kappa;
bool g_ad_kappa_loaded = false;

void LoadAdKappaOnce() {
  if (g_ad_kappa_loaded) return;
  g_ad_kappa_loaded = true;
  const char* path = std::getenv("HOLO_AD_KAPPA");
  if (!path || !path[0]) return;
  std::ifstream f(path);
  std::string line;
  while (std::getline(f, line)) {
    // trim whitespace/CR
    size_t a = line.find_first_not_of(" \t\r\n");
    size_t b = line.find_last_not_of(" \t\r\n");
    if (a == std::string::npos) continue;
    std::string h = line.substr(a, b - a + 1);
    if (h.empty() || h[0] == '#') continue;
    std::transform(h.begin(), h.end(), h.begin(), [](unsigned char c) { return std::tolower(c); });
    if (h.size() == 64) g_ad_kappa.insert(h);
  }
}

bool IsAdKappa(const char* hex64) { return g_ad_kappa.find(hex64) != g_ad_kappa.end(); }

// Buffers a response body (no Content-Length needed — works on chunked/compressed responses), hashes it
// with the VERIFIER'S OWN sha256 (kr_sha256_hex), and drops the body iff its content κ is denylisted.
// Safe by construction: it only ever (a) emits the body WHOLE, or (b) emits an EMPTY body — never a
// partial/garbled stream. A pathologically large body (> kCap) is passed through untouched (we give up
// on content-κ for it rather than buffer unbounded), still without corruption.
class HoloAdKappaFilter : public CefResponseFilter {
 public:
  bool InitFilter() override { return true; }

  FilterStatus Filter(void* data_in, size_t data_in_size, size_t& data_in_read,
                      void* data_out, size_t data_out_size, size_t& data_out_written) override {
    data_in_read = 0;
    data_out_written = 0;

    // Passthrough mode (oversized): drain whatever we buffered, then copy input straight through.
    if (passthrough_) return DrainBufferThenCopy(data_in, data_in_size, data_in_read,
                                                 data_out, data_out_size, data_out_written);

    if (!decided_) {
      if (data_in_size > 0) {  // still receiving — buffer it, emit nothing yet
        buf_.append(static_cast<const char*>(data_in), data_in_size);
        data_in_read = data_in_size;
        if (buf_.size() > kCap) passthrough_ = true;  // too big to hold → give up, stream it intact
        return RESPONSE_FILTER_NEED_MORE_DATA;
      }
      decided_ = true;  // data_in_size == 0 ⇒ end of body → decide by content address
      char hex[65] = {0};
      kr_sha256_hex(reinterpret_cast<const uint8_t*>(buf_.data()), buf_.size(), hex);
      drop_ = IsAdKappa(hex);
    }
    if (drop_) return RESPONSE_FILTER_DONE;  // refuse the ad object: empty body
    return DrainBuffer(data_out, data_out_size, data_out_written);
  }

 private:
  static constexpr size_t kCap = 16 * 1024 * 1024;  // hold up to 16MB; beyond that, passthrough

  FilterStatus DrainBuffer(void* data_out, size_t data_out_size, size_t& data_out_written) {
    const size_t remaining = buf_.size() - off_;
    const size_t n = remaining < data_out_size ? remaining : data_out_size;
    if (n) {
      std::memcpy(data_out, buf_.data() + off_, n);
      off_ += n;
      data_out_written = n;
    }
    return (off_ < buf_.size()) ? RESPONSE_FILTER_NEED_MORE_DATA : RESPONSE_FILTER_DONE;
  }

  FilterStatus DrainBufferThenCopy(void* data_in, size_t data_in_size, size_t& data_in_read,
                                   void* data_out, size_t data_out_size, size_t& data_out_written) {
    if (off_ < buf_.size()) {  // first flush the bytes we buffered before giving up
      DrainBuffer(data_out, data_out_size, data_out_written);
      return RESPONSE_FILTER_NEED_MORE_DATA;
    }
    if (data_in_size > 0) {  // buffer drained → copy live input straight through, unchanged
      const size_t n = data_in_size < data_out_size ? data_in_size : data_out_size;
      std::memcpy(data_out, data_in, n);
      data_in_read = n;
      data_out_written = n;
      return RESPONSE_FILTER_NEED_MORE_DATA;
    }
    return RESPONSE_FILTER_DONE;  // EOF, all flushed
  }

  std::string buf_;
  size_t off_ = 0;
  bool decided_ = false;
  bool drop_ = false;
  bool passthrough_ = false;
  IMPLEMENT_REFCOUNTING(HoloAdKappaFilter);
};

// ── Open-web κ-cache. Projects the κ-substrate in FRONT of the network for every website (not just
// holo://): every cacheable http(s) subresource is content-addressed; a repeat on ANY site, in ANY tab,
// is served from the local substrate at memory speed (no DNS/TLS/network). Safe because κ = the content
// address — a hit only returns bytes that re-derive to the requested κ (Law L5). Cold-novel bytes still
// hit the network (physics); everything else is substrate-speed. The single shared cache (thread-safe in
// Rust) is created once via a C++11 magic-static — no app.cc plumbing.
KCache* WebCache() {
  static KCache* c = kr_cache_new(4096);  // bounded resident working set (distinct κ)
  return c;
}

// Which loads are cacheable: GET, http(s), and a static subresource type. Documents/XHR/fetch/media are
// EXCLUDED — dynamic responses must never be served stale, and we don't buffer video. Start narrow.
bool IsCacheableWeb(CefRefPtr<CefRequest> request) {
  if (request->GetMethod().ToString() != "GET") return false;
  const std::string url = request->GetURL().ToString();
  if (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0) return false;
  switch (request->GetResourceType()) {
    case RT_SCRIPT:
    case RT_STYLESHEET:
    case RT_IMAGE:
    case RT_FONT_RESOURCE:
      return true;
    default:
      return false;
  }
}

// Serve-forever heuristic: immutable / long max-age / fingerprinted name. The cache is correct either way;
// `immutable` just lets a later layer skip revalidation. (Conservative: false unless clearly immutable.)
bool ImmutableByHeaders(CefRefPtr<CefResponse> response, const std::string& /*url*/) {
  if (!response) return false;
  std::string cc = response->GetHeaderByName("Cache-Control").ToString();
  std::transform(cc.begin(), cc.end(), cc.begin(), [](unsigned char ch) { return std::tolower(ch); });
  if (cc.find("immutable") != std::string::npos) return true;
  const size_t p = cc.find("max-age=");
  if (p != std::string::npos && std::atol(cc.c_str() + p + 8) >= 86400) return true;
  return false;
}

// Serve a κ-HIT: a Rust-heap buffer (freed via kr_free) + mime (kr_cache_free_mime). Mirrors HoloSurrogateHandler.
class HoloKappaCacheHandler : public CefResourceHandler {
 public:
  HoloKappaCacheHandler(uint8_t* data, size_t len, char* mime) : data_(data), len_(len), mime_(mime) {}
  ~HoloKappaCacheHandler() override {
    if (data_) kr_free(data_, len_);
    if (mime_) kr_cache_free_mime(mime_);
  }
  bool Open(CefRefPtr<CefRequest>, bool& handle_request, CefRefPtr<CefCallback>) override {
    handle_request = true;
    return true;
  }
  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString&) override {
    response->SetStatus(200);
    response->SetStatusText("OK");
    response->SetMimeType(mime_ ? std::string(mime_) : std::string("application/octet-stream"));
    CefResponse::HeaderMap h;
    response->GetHeaderMap(h);
    h.insert(std::make_pair("X-Holo-Source", "kappa-cache"));      // observable proof in DevTools/Network
    h.insert(std::make_pair("Access-Control-Allow-Origin", "*"));  // a κ-hit must not break CORS-mode loads
    response->SetHeaderMap(h);
    response_length = static_cast<int64_t>(len_);
  }
  bool Read(void* out, int n, int& read, CefRefPtr<CefResourceReadCallback>) override {
    if (off_ >= len_) { read = 0; return false; }
    const size_t avail = len_ - off_;
    const size_t cnt = (static_cast<size_t>(n) < avail) ? static_cast<size_t>(n) : avail;
    std::memcpy(out, data_ + off_, cnt);
    off_ += cnt;
    read = static_cast<int>(cnt);
    return true;
  }
  void Cancel() override {}

 private:
  uint8_t* data_;
  size_t len_;
  char* mime_;
  size_t off_ = 0;
  IMPLEMENT_REFCOUNTING(HoloKappaCacheHandler);
};

// Tee a cacheable response body into the κ-cache (cold miss only), passing it through UNCHANGED. Mirrors
// HoloAdKappaFilter's buffer→drain protocol; on EOF it content-addresses + kr_cache_puts the whole body
// (deduped by κ). A κ-HIT is served upstream by HoloKappaCacheHandler with NO filter in the path, so the
// populate cost lands only on the cold (network-bound) miss. Oversized bodies pass through uncached.
class HoloKappaTeeFilter : public CefResponseFilter {
 public:
  HoloKappaTeeFilter(std::string url, std::string mime, bool immutable)
      : url_(std::move(url)), mime_(std::move(mime)), immutable_(immutable) {}
  bool InitFilter() override { return true; }

  FilterStatus Filter(void* data_in, size_t data_in_size, size_t& data_in_read,
                      void* data_out, size_t data_out_size, size_t& data_out_written) override {
    data_in_read = 0;
    data_out_written = 0;
    if (passthrough_) return DrainBufferThenCopy(data_in, data_in_size, data_in_read,
                                                 data_out, data_out_size, data_out_written);
    if (!stored_) {
      if (data_in_size > 0) {  // accumulate the body; emit nothing yet
        buf_.append(static_cast<const char*>(data_in), data_in_size);
        data_in_read = data_in_size;
        if (buf_.size() > kCap) passthrough_ = true;  // too big to cache → stream intact, skip the put
        return RESPONSE_FILTER_NEED_MORE_DATA;
      }
      stored_ = true;  // EOF → content-address + store the whole body (dedup by κ)
      kr_cache_put(WebCache(), url_.c_str(), reinterpret_cast<const uint8_t*>(buf_.data()), buf_.size(),
                   mime_.c_str(), immutable_ ? 1 : 0);
    }
    return DrainBuffer(data_out, data_out_size, data_out_written);
  }

 private:
  static constexpr size_t kCap = 16 * 1024 * 1024;  // hold up to 16MB; beyond that, passthrough uncached

  FilterStatus DrainBuffer(void* data_out, size_t data_out_size, size_t& data_out_written) {
    const size_t remaining = buf_.size() - off_;
    const size_t n = remaining < data_out_size ? remaining : data_out_size;
    if (n) { std::memcpy(data_out, buf_.data() + off_, n); off_ += n; data_out_written = n; }
    return (off_ < buf_.size()) ? RESPONSE_FILTER_NEED_MORE_DATA : RESPONSE_FILTER_DONE;
  }
  FilterStatus DrainBufferThenCopy(void* data_in, size_t data_in_size, size_t& data_in_read,
                                   void* data_out, size_t data_out_size, size_t& data_out_written) {
    if (off_ < buf_.size()) { DrainBuffer(data_out, data_out_size, data_out_written); return RESPONSE_FILTER_NEED_MORE_DATA; }
    if (data_in_size > 0) {
      const size_t n = data_in_size < data_out_size ? data_in_size : data_out_size;
      std::memcpy(data_out, data_in, n); data_in_read = n; data_out_written = n;
      return RESPONSE_FILTER_NEED_MORE_DATA;
    }
    return RESPONSE_FILTER_DONE;
  }

  std::string url_, mime_, buf_;
  size_t off_ = 0;
  bool stored_ = false;
  bool passthrough_ = false;
  bool immutable_ = false;   // set from the ctor: marks serve-forever assets for kr_cache_put
  IMPLEMENT_REFCOUNTING(HoloKappaTeeFilter);
};

// ── Playground injection. Splices the in-page Playground bootstrap into every top-level HTML document the
// host renders (real web, IPFS, κ-app), so EVERY element on EVERY page becomes right-click-editable on screen
// — the native twin of the shell injecting holo-playground-app.js into same-origin app frames. The bootstrap
// is dormant by default (one chrome ✦ toggle arms the tab) and marked data-holo-ephemeral, so the Playground
// agent's own serialise strips it and the snapshot κ never contains the injector (Law L5).
//
// Like HoloAdKappaFilter it buffers the whole body (works on chunked responses), then emits it ONCE with the
// tag spliced before </head> (fallback: before </body>; fallback: prepended). Oversized bodies pass through
// un-injected (rare; honest — we never corrupt a stream). ASSUMES the filter receives DECODED html (CEF's
// resource loader removes Content-Encoding before filtering); if a deployment delivers still-compressed
// bodies here, prefer CefRenderProcessHandler::OnContextCreated injection (no byte splicing) instead.
class HoloPlaygroundInjectFilter : public CefResponseFilter {
 public:
  bool InitFilter() override { return true; }

  FilterStatus Filter(void* data_in, size_t data_in_size, size_t& data_in_read,
                      void* data_out, size_t data_out_size, size_t& data_out_written) override {
    data_in_read = 0;
    data_out_written = 0;
    if (passthrough_) return DrainBufferThenCopy(data_in, data_in_size, data_in_read,
                                                 data_out, data_out_size, data_out_written);
    if (!decided_) {
      if (data_in_size > 0) {  // still receiving — buffer it, emit nothing yet
        buf_.append(static_cast<const char*>(data_in), data_in_size);
        data_in_read = data_in_size;
        if (buf_.size() > kCap) passthrough_ = true;  // too big to hold → stream it intact, un-injected
        return RESPONSE_FILTER_NEED_MORE_DATA;
      }
      decided_ = true;  // end of body → splice the bootstrap in once
      Splice();
    }
    return DrainBuffer(data_out, data_out_size, data_out_written);
  }

 private:
  static constexpr size_t kCap = 16 * 1024 * 1024;
  static const char kTag[];

  // case-insensitive find of a closing tag; returns std::string::npos if absent.
  static size_t FindCI(const std::string& hay, const char* needle) {
    std::string low = hay;
    for (char& c : low) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return low.find(needle);
  }
  void Splice() {
    size_t at = FindCI(buf_, "</head>");
    if (at == std::string::npos) at = FindCI(buf_, "</body>");
    if (at == std::string::npos) at = 0;  // no head/body (fragment) → prepend
    buf_.insert(at, kTag);
  }

  FilterStatus DrainBuffer(void* data_out, size_t data_out_size, size_t& data_out_written) {
    const size_t remaining = buf_.size() - off_;
    const size_t n = remaining < data_out_size ? remaining : data_out_size;
    if (n) { std::memcpy(data_out, buf_.data() + off_, n); off_ += n; data_out_written = n; }
    return (off_ < buf_.size()) ? RESPONSE_FILTER_NEED_MORE_DATA : RESPONSE_FILTER_DONE;
  }
  FilterStatus DrainBufferThenCopy(void* data_in, size_t data_in_size, size_t& data_in_read,
                                   void* data_out, size_t data_out_size, size_t& data_out_written) {
    if (off_ < buf_.size()) { DrainBuffer(data_out, data_out_size, data_out_written); return RESPONSE_FILTER_NEED_MORE_DATA; }
    if (data_in_size > 0) {
      const size_t n = data_in_size < data_out_size ? data_in_size : data_out_size;
      std::memcpy(data_out, data_in, n); data_in_read = n; data_out_written = n;
      return RESPONSE_FILTER_NEED_MORE_DATA;
    }
    return RESPONSE_FILTER_DONE;
  }

  std::string buf_;
  size_t off_ = 0;
  bool decided_ = false;
  bool passthrough_ = false;
  IMPLEMENT_REFCOUNTING(HoloPlaygroundInjectFilter);
};
const char HoloPlaygroundInjectFilter::kTag[] =
    // NOTHING is byte-spliced anymore. A spliced holo:// <script> is refused by real-site CSP (proven on
    // HN/Google: "Failed to fetch dynamically imported module"). BOTH Playground AND Holo Messenger capture
    // now inject via the CSP-PROOF host path — app.cc OnContextCreated ExecuteJavaScript()s self-contained
    // bundles into the page's main world (kHoloPlaygroundBundle, kHoloMessengerCaptureBundle). This filter is
    // retained only as a no-op seam; kTag is empty so Splice() inserts nothing.
    "";

// ── Surrogates (anti-anti-adblock). Inert stand-ins served HTTP 200 in place of ad/detector requests so
// the page sees a SUCCESS (not a cancel) and finds the globals it probes for — blocking becomes undetectable.
const char kGptSurrogate[] = R"JS((function(){'use strict';
var noopfn=function(){},noopthis=function(){return this;},noopnull=function(){return null;},nilarr=function(){return [];},nilstr=function(){return '';};
var slot={addService:noopthis,clearCategoryExclusions:noopthis,clearTargeting:noopthis,defineSizeMapping:noopthis,get:noopnull,getAdUnitPath:nilstr,getAttributeKeys:nilarr,getCategoryExclusions:nilarr,getDomId:nilstr,getResponseInformation:noopnull,getSlotElementId:nilstr,getSlotId:noopthis,getTargeting:nilarr,getTargetingKeys:nilarr,set:noopthis,setCategoryExclusion:noopthis,setClickUrl:noopthis,setCollapseEmptyDiv:noopthis,setSafeFrameConfig:noopthis,setTargeting:noopthis,updateTargetingFromMap:noopthis};
var pubads={addEventListener:noopthis,removeEventListener:noopthis,clear:noopfn,clearCategoryExclusions:noopthis,clearTagForChildDirectedTreatment:noopthis,clearTargeting:noopthis,collapseEmptyDivs:noopfn,defineOutOfPagePassback:function(){return slot;},definePassback:function(){return slot;},disableInitialLoad:noopfn,display:noopfn,enableAsyncRendering:noopfn,enableLazyLoad:noopfn,enableSingleRequest:noopfn,enableSyncRendering:noopfn,enableVideoAds:noopfn,get:noopnull,getAttributeKeys:nilarr,getTargeting:nilarr,getTargetingKeys:nilarr,getSlots:nilarr,isInitialLoadDisabled:function(){return true;},refresh:noopfn,set:noopthis,setCategoryExclusion:noopthis,setCentering:noopfn,setCookieOptions:noopthis,setForceSafeFrame:noopthis,setLocation:noopthis,setPublisherProvidedId:noopthis,setPrivacySettings:noopthis,setRequestNonPersonalizedAds:noopthis,setSafeFrameConfig:noopthis,setTagForChildDirectedTreatment:noopthis,setTargeting:noopthis,setVideoContent:noopthis,updateCorrelator:noopfn};
var gt=window.googletag=window.googletag||{};var q=gt.cmd||[];
gt.apiReady=true;gt.pubadsReady=true;
gt.companionAds=function(){return{addEventListener:noopthis,removeEventListener:noopthis,enableSyncLoading:noopfn,setRefreshUnfilledSlots:noopfn};};
gt.content=function(){return{addEventListener:noopthis,removeEventListener:noopthis,setContent:noopfn};};
gt.defineOutOfPageSlot=function(){return slot;};gt.defineSlot=function(){return slot;};
gt.destroySlots=noopfn;gt.disablePublisherConsole=noopfn;gt.display=noopfn;gt.enableServices=noopfn;
gt.getVersion=nilstr;gt.pubads=function(){return pubads;};gt.setAdIframeTitle=noopfn;
gt.sizeMapping=function(){return{addSize:noopthis,build:nilarr};};
gt.cmd=[];gt.cmd.push=function(fn){try{fn();}catch(e){}return 1;};
for(var i=0;i<q.length;i++){try{(typeof q[i]==='function')&&q[i]();}catch(e){}}
})();)JS";

const char kGaSurrogate[] = R"JS((function(){
var p=window.GoogleAnalyticsObject||'ga';
var ga=window[p]||function(){(ga.q=ga.q||[]).push(arguments);};
ga.l=+new Date();ga.q=ga.q||[];window[p]=ga;window.ga=ga;
window.gtag=window.gtag||function(){};window.dataLayer=window.dataLayer||[];
window.google_tag_manager=window.google_tag_manager||{};
})();)JS";

const char kNoopJs[] = "/* holo surrogate: inert */\n";

// 1x1 transparent GIF89a — served for ad/bait images so the request succeeds (onload fires, not onerror).
const unsigned char kGif1x1[] = {
    0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0x00,0x00,0x00,
    0xff,0xff,0xff,0x21,0xf9,0x04,0x01,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,
    0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b};

bool UrlHas(const std::string& u, const char* n) { return u.find(n) != std::string::npos; }
bool IsGptScript(const std::string& u) {
  return UrlHas(u, "gpt.js") || UrlHas(u, "googletagservices.com/tag") ||
         UrlHas(u, "doubleclick.net/tag/js/gpt");
}
bool IsGaScript(const std::string& u) {
  return UrlHas(u, "google-analytics.com/analytics.js") || UrlHas(u, "google-analytics.com/ga.js") ||
         UrlHas(u, "googletagmanager.com/gtag") || UrlHas(u, "google-analytics.com/gtag");
}
// Anti-adblock detector beacons/scripts (Admiral & co.) recognised by STABLE PATH signature — they ride
// random first-party-proxied domains (e.g. merequartz.com/aadetect/), so domain lists miss them; the path
// is the constant. Served an inert 200 so the detector's probe "succeeds" with nothing.
bool IsAaDetect(const std::string& u) {
  return UrlHas(u, "/aadetect") || UrlHas(u, "/adblock") || UrlHas(u, "/abd/") || UrlHas(u, "/admiral");
}

// CefResourceHandler that returns a fixed in-memory body with HTTP 200 — the surrogate response.
class HoloSurrogateHandler : public CefResourceHandler {
 public:
  HoloSurrogateHandler(const char* data, size_t len, const char* mime)
      : data_(data, len), mime_(mime) {}
  bool Open(CefRefPtr<CefRequest>, bool& handle_request, CefRefPtr<CefCallback>) override {
    handle_request = true;
    return true;
  }
  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString&) override {
    response->SetMimeType(mime_);
    response->SetStatus(200);
    response->SetStatusText("OK");
    CefResponse::HeaderMap h;
    response->GetHeaderMap(h);
    h.insert(std::make_pair("Access-Control-Allow-Origin", "*"));
    h.insert(std::make_pair("Cache-Control", "no-store"));
    response->SetHeaderMap(h);
    response_length = static_cast<int64_t>(data_.size());
  }
  bool Skip(int64_t n, int64_t& skipped, CefRefPtr<CefResourceSkipCallback>) override {
    skipped = n;
    off_ += static_cast<size_t>(n);
    return true;
  }
  bool Read(void* out, int n, int& read, CefRefPtr<CefResourceReadCallback>) override {
    if (off_ >= data_.size()) { read = 0; return false; }
    const size_t avail = data_.size() - off_;
    const size_t cnt = (static_cast<size_t>(n) < avail) ? static_cast<size_t>(n) : avail;
    std::memcpy(out, data_.data() + off_, cnt);
    off_ += cnt;
    read = static_cast<int>(cnt);
    return true;
  }
  void Cancel() override {}

 private:
  std::string data_, mime_;
  size_t off_ = 0;
  IMPLEMENT_REFCOUNTING(HoloSurrogateHandler);
};

std::string json_escape(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c == '\n' || c == '\r' || c == '\t') o += ' ';
    else o += c;
  }
  return o;
}

// ── Extension install front door (κ-addressable extensions). A holo:// page (the Extensions manager)
// asks the host to fetch a Chrome Web Store CRX by id. The Web Store strips its own install hooks under
// ungoogled/CEF, and a holo:// page's own fetch() of clients2.google.com is CORS-blocked — so the BROWSER
// PROCESS fetches it (CefURLRequest, no CORS, follows redirects), base64-encodes it, and hands it back to
// the page, which mints the κ + verifies the publisher signature (Law L5, in holo-ext-install.mjs) before
// anything runs. The host only carries bytes; identity/verification stay in the κ-substrate code.
// SSRF-safe: the host builds the canonical clients2 URL itself from a validated [a-p]{32} id — it never
// fetches an attacker-supplied URL.
bool IsExtId(const std::string& id) {
  if (id.size() != 32) return false;
  for (char c : id) if (c < 'a' || c > 'p') return false;
  return true;
}
std::string CrxUrl(const std::string& id) {
  return "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3"
         "&prodversion=131.0.0.0&x=id%3D" + id + "%26installsource%3Dondemand%26uc";
}
class HoloCrxFetchClient : public CefURLRequestClient {
 public:
  explicit HoloCrxFetchClient(CefRefPtr<CefMessageRouterBrowserSide::Callback> cb) : cb_(cb) {}
  void Start(const std::string& url) {
    CefRefPtr<CefRequest> r = CefRequest::Create();
    r->SetURL(url);
    r->SetMethod("GET");
    req_ = CefURLRequest::Create(r, this, nullptr);  // browser-process load → no CORS; follows redirects
  }
  void OnRequestComplete(CefRefPtr<CefURLRequest> request) override {
    const bool ok = request->GetRequestStatus() == UR_SUCCESS && !data_.empty();
    if (ok) cb_->Success(CefBase64Encode(data_.data(), data_.size()));
    else cb_->Failure(502, "crxfetch: download failed");
    cb_ = nullptr; req_ = nullptr;  // break the client↔request ref cycle → self-destruct
  }
  void OnDownloadData(CefRefPtr<CefURLRequest>, const void* data, size_t n) override {
    data_.append(static_cast<const char*>(data), n);
  }
  void OnDownloadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  void OnUploadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  bool GetAuthCredentials(bool, const CefString&, int, const CefString&, const CefString&,
                          CefRefPtr<CefAuthCallback>) override { return false; }
 private:
  CefRefPtr<CefMessageRouterBrowserSide::Callback> cb_;
  CefRefPtr<CefURLRequest> req_;
  std::string data_;
  IMPLEMENT_REFCOUNTING(HoloCrxFetchClient);
};
}  // namespace

// window.HoloBridge.call(cmd) → window.cefQuery('holo:svc:<cmd>') → here. ORIGIN TIER: only holo://
// frames are served; any other origin is refused (SEC-2/SEC-5). This is the boundary that keeps the web
// from reaching the Hologram service.
//
// P2: the handler holds no Hologram logic — it RELAYS. A permitted query is forwarded (by id) to the
// privileged service context (the OS home frame), which runs the real modules (holo-resolve = the one
// intent front door, and window.Q / HoloTerms when present) and replies via 'holo:svcreply:<id>:<json>'.
// The original callback is held open until that reply arrives, then resolved. The browser process never
// interprets intent or governance itself; it only enforces the origin tier and carries the message.
class HoloBridgeHandler : public CefMessageRouterBrowserSide::Handler {
 public:
  explicit HoloBridgeHandler(SimpleHandler* owner) : owner_(owner) {}

  bool OnQuery(CefRefPtr<CefBrowser> browser,
               CefRefPtr<CefFrame> frame,
               int64_t query_id,
               const CefString& request,
               bool persistent,
               CefRefPtr<Callback> callback) override {
    const std::string req = request.ToString();
    const std::string origin = frame->GetURL().ToString();

    // Capture relay (Holo Messenger): a per-platform capture bundle on a web origin (web.whatsapp.com,
    // …) posts a rendered message here because BroadcastChannel can't cross into the holo://os inbox.
    // CONTENT-BLIND + cross-origin by design: the host forwards the opaque payload to the holo://os
    // inbox frame(s), which mint the κ and verify-before-trust. Allowed from ANY origin (it can only
    // reach the inbox, never the service); the inbox is the trust boundary, not this relay.
    if (req.rfind("holo:capture:", 0) == 0) {
      owner_->RelayCapture(req.substr(13));   // URI-encoded JSON payload (URL-safe → embeds in a JS string)
      callback->Success("{\"ok\":true}");
      return true;
    }

    // Governance verdict path: the service returns a navigation verdict (origin holo://os only).
    if (req.rfind("holo:govverdict:", 0) == 0) {
      if (origin.rfind("holo://os", 0) != 0) {
        callback->Failure(403, "holo-bridge: only the service context may rule");
        return true;
      }
      const std::string rest = req.substr(16);  // "<gid>:<allow|block>"
      const size_t colon = rest.find(':');
      if (colon == std::string::npos) { callback->Failure(400, "holo-bridge: malformed verdict"); return true; }
      const int gid = std::atoi(rest.substr(0, colon).c_str());
      owner_->ResolveGov(gid, rest.substr(colon + 1) == "allow");
      callback->Success("{\"ok\":true}");
      return true;
    }

    // Host-driven open path: the service (origin holo://os only) streams a composed κ-surface in as a
    // new tab. Restricted to holo:// URLs so it can never be turned into an arbitrary-page launcher.
    if (req.rfind("holo:open:", 0) == 0) {
      if (origin.rfind("holo://os", 0) != 0) {
        callback->Failure(403, "holo-bridge: only the service context may open surfaces");
        return true;
      }
      const std::string u = req.substr(10);
      if (u.rfind("holo://", 0) != 0) {
        callback->Failure(400, "holo-bridge: open only holo:// surfaces");
        return true;
      }
      owner_->OpenTab(u);
      callback->Success("{\"ok\":true}");
      return true;
    }

    // Reply path: the service context (and only it — origin holo://os) returns results here.
    if (req.rfind("holo:svcreply:", 0) == 0) {
      if (origin.rfind("holo://os", 0) != 0) {
        callback->Failure(403, "holo-bridge: only the service context may reply");
        return true;
      }
      const std::string rest = req.substr(14);  // "<id>:<json>"
      const size_t colon = rest.find(':');
      if (colon == std::string::npos) { callback->Failure(400, "holo-bridge: malformed reply"); return true; }
      const int id = std::atoi(rest.substr(0, colon).c_str());
      owner_->ResolvePending(id, rest.substr(colon + 1));
      callback->Success("{\"ok\":true}");  // ack the reply query itself
      return true;
    }

    // CRX fetch path: a holo:// page (the Extensions manager) asks the host to download a Web Store CRX
    // by id, bypassing CORS. The host builds the canonical URL from the validated id (SSRF-safe), fetches
    // it in the browser process, and returns the bytes base64; the page mints the κ + verifies (Law L5).
    if (req.rfind("holo:crxfetch:", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) {
        callback->Failure(403, "holo-bridge: crxfetch only from a holo:// origin");
        return true;
      }
      const std::string id = req.substr(14);
      if (!IsExtId(id)) { callback->Failure(400, "holo-bridge: bad extension id"); return true; }
      CefRefPtr<HoloCrxFetchClient> client = new HoloCrxFetchClient(callback);  // self-owned until complete
      client->Start(CrxUrl(id));
      return true;  // callback resolved asynchronously in OnRequestComplete
    }

    // Install-from-store path: the "Add to Hologram" button injected onto a Chrome Web Store detail page
    // (the ONLY verb permitted from the Web Store web origin — re-validated here) opens the Extensions
    // manager (a trusted holo:// page) at #add=<id>, which then runs the κ-verified install with its own UI.
    if (req.rfind("holo:installext:", 0) == 0) {
      const bool from_store = origin.rfind("https://chromewebstore.google.com/", 0) == 0;
      if (!from_store && origin.rfind("holo://", 0) != 0) {
        callback->Failure(403, "holo-bridge: installext only from the Web Store or holo://");
        return true;
      }
      const std::string id = req.substr(16);
      if (!IsExtId(id)) { callback->Failure(400, "holo-bridge: bad extension id"); return true; }
      // In-place install (seamless, like Chrome): relay to the trusted service frame, which fetches +
      // verifies + pins and replies — the store page then shows a toast, no tab switch. Fall back to
      // opening the manager only if the service context isn't available.
      CefRefPtr<CefFrame> svc = owner_->ServiceFrame();
      if (svc) {
        const int qid = owner_->StashPending(callback);
        svc->ExecuteJavaScript("window.__holoInstallExt&&window.__holoInstallExt(" + std::to_string(qid) +
                                   ",\"" + id + "\");",
                               svc->GetURL(), 0);
      } else {
        owner_->OpenTab("holo://os/usr/share/frame/extensions.html#add=" + id);
        callback->Success("{\"ok\":true,\"fallback\":\"manager\"}");
      }
      return true;
    }

    if (req.rfind("holo:svc:", 0) != 0) {
      return false;  // not a bridge query
    }
    if (origin.rfind("holo://", 0) != 0) {
      // The security boundary: a non-holo (web/extension) origin must never reach the service.
      callback->Failure(403, "holo-bridge: origin not permitted");
      return true;
    }

    // Forward path: relay the command to the privileged service context.
    CefRefPtr<CefFrame> svc = owner_->ServiceFrame();
    if (!svc) {
      callback->Failure(503, "holo-bridge: service context unavailable");
      return true;
    }
    const std::string cmd = req.substr(9);
    const int id = owner_->StashPending(callback);  // callback held open; resolved on the reply
    const std::string js = "window.__holoSvc&&window.__holoSvc(" + std::to_string(id) + ",\"" +
                           json_escape(cmd) + "\",\"" + json_escape(origin) + "\");";
    svc->ExecuteJavaScript(js, svc->GetURL(), 0);
    return true;
  }

 private:
  SimpleHandler* owner_;  // not owned; outlives the handler
};

SimpleHandler::SimpleHandler() {
  CefMessageRouterConfig config;
  router_ = CefMessageRouterBrowserSide::Create(config);
  bridge_.reset(new HoloBridgeHandler(this));
  router_->AddHandler(bridge_.get(), /*first=*/false);
  LoadAdHostsOnce();  // preload the ad ruleset at startup so the first request is never stalled
  LoadAdKappaOnce();
}

SimpleHandler::~SimpleHandler() {
  if (router_ && bridge_) router_->RemoveHandler(bridge_.get());
}

void SimpleHandler::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  // The first browser is the OS shell window; its main frame hosts the Hologram service context.
  if (!main_browser_) main_browser_ = browser;
  browser_list_.push_back(browser);
}

// The service context is the OS home frame — but only while it is still the OS shell (a holo://os
// document). If the user navigates that tab away, ServiceFrame() returns null and the relay fails
// closed with 503 rather than executing JS in an arbitrary page. (P2 hosts the service in the shell
// frame, like the web build; a dedicated windowless service browser is the hardening step.)
CefRefPtr<CefFrame> SimpleHandler::ServiceFrame() {
  CEF_REQUIRE_UI_THREAD();
  if (!main_browser_) return nullptr;
  CefRefPtr<CefFrame> f = main_browser_->GetMainFrame();
  if (!f) return nullptr;
  return f->GetURL().ToString().rfind("holo://os", 0) == 0 ? f : nullptr;
}

// RelayCapture — forward a captured message (URI-encoded JSON, content-blind) to every holo://os main
// frame. The inbox surface listens for the 'holo-capture' window event, mints the κ and verifies before
// it ingests; this host step only carries opaque bytes across the origin boundary. The payload is
// encodeURIComponent output (no ", \\, or newline), so it embeds safely in a double-quoted JS string.
void SimpleHandler::RelayCapture(const std::string& payload) {
  CEF_REQUIRE_UI_THREAD();
  const std::string js =
      "window.dispatchEvent(new MessageEvent('holo-capture',{data:decodeURIComponent(\"" + payload + "\")}));";
  for (auto& b : browser_list_) {
    CefRefPtr<CefFrame> f = b->GetMainFrame();
    if (f && f->GetURL().ToString().rfind("holo://os", 0) == 0)
      f->ExecuteJavaScript(js, f->GetURL(), 0);
  }
}

int SimpleHandler::StashPending(CefRefPtr<CefMessageRouterBrowserSide::Callback> callback) {
  CEF_REQUIRE_UI_THREAD();
  const int id = next_query_id_++;
  pending_[id] = callback;
  return id;
}

void SimpleHandler::ResolvePending(int id, const std::string& json) {
  CEF_REQUIRE_UI_THREAD();
  auto it = pending_.find(id);
  if (it == pending_.end()) return;  // unknown / already resolved
  it->second->Success(json);
  pending_.erase(it);
}

void SimpleHandler::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  router_->OnBeforeClose(browser);
  if (main_browser_ && main_browser_->IsSame(browser)) main_browser_ = nullptr;  // service host gone
  for (auto it = browser_list_.begin(); it != browser_list_.end(); ++it) {
    if ((*it)->IsSame(browser)) { browser_list_.erase(it); break; }
  }
  if (browser_list_.empty()) CefQuitMessageLoop();
}

// ── DevTools at F12 ────────────────────────────────────────────────────────────────────────────
// The native browser embeds the COMPLETE Chromium inspector. We open it; we do not reimplement it.
// This is the literal "F12, just like Chrome": the inspector reflects the live renderer — the whole
// tab, every element, every byte — by construction. The front-end's own asset loads route through
// the holo:// κ scheme (sealed, verified) so the DevTools surface is itself substrate-native.
//
// DOCKED RIGHT, like Chrome — but NOT via CefBrowserHost::ShowDevTools. That API, in a host with custom
// chrome, opens a DETACHED inspector window that cannot dock (and a second OS window lands on its own DPI
// surface, which is what made it look soft). Instead F12 toggles the IN-PAGE right-slide dock: the same
// vendored Chrome devtools-frontend, κ-served (holo://), mounted over the κ-CDP backend, sliding in from
// the right at a golden-ratio width. Consequences the operator asked for: it ALWAYS slides from the right,
// the width is golden-ratio, it shares this window's exact device-scale (pixel-crisp / high-DPI), and the
// backend is in-process (low latency). 100% κ-native: the dock + frontend are κ-served, handles alias κ.
void SimpleHandler::ShowHoloDevTools(CefRefPtr<CefBrowser> browser, const CefPoint& inspect_at) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser) return;
  CefRefPtr<CefFrame> frame = browser->GetMainFrame();  // the OS shell frame owns window.HoloDevDock
  if (!frame) return;
  // Toggle the dock in the shell. Harmless no-op if the dock isn't installed (non-shell main frame).
  frame->ExecuteJavaScript(
      "window.HoloDevDock&&window.HoloDevDock.toggle&&window.HoloDevDock.toggle();",
      "holo://devtools/toggle", 0);
}

bool SimpleHandler::OnKeyEvent(CefRefPtr<CefBrowser> browser,
                               const CefKeyEvent& event,
                               CefEventHandle os_event) {
  CEF_REQUIRE_UI_THREAD();
  if (event.type != KEYEVENT_RAWKEYDOWN && event.type != KEYEVENT_KEYDOWN) return false;
  if (!browser) return false;
  const bool ctrl = (event.modifiers & EVENTFLAG_CONTROL_DOWN) != 0;
  const bool shift = (event.modifiers & EVENTFLAG_SHIFT_DOWN) != 0;
  const int code = event.windows_key_code;
  constexpr int VK_F12_ = 0x7B, VK_I_ = 0x49, VK_J_ = 0x4A, VK_C_ = 0x43;  // F12, I, J, C
  const bool is_devtools_chord =
      (code == VK_F12_) || (ctrl && shift && (code == VK_I_ || code == VK_J_ || code == VK_C_));
  if (!is_devtools_chord) return false;

  // Toggle the IN-PAGE right-docked Holo DevTools (the κ-served real Chrome frontend over the κ-CDP
  // backend, injected into every tab by holo-devtools-dock-boot.js). We CONSUME the chord (return true)
  // so Chrome's own F12 never opens its detached window — the whole reason it kept "opening as a new
  // window." The inspector docks right at a golden-ratio width and reflects this tab's live κ-holospace.
  CefRefPtr<CefFrame> frame = browser->GetMainFrame();
  if (frame) {
    frame->ExecuteJavaScript(
        "window.HoloDevDock&&window.HoloDevDock.toggle&&window.HoloDevDock.toggle();",
        "holo://devtools/toggle", 0);
  }
  return true;  // consume — do NOT let Chrome open its detached DevTools window
}

namespace {
// Messenger platforms are FIRST-CLASS destinations of the unified inbox — the user is signing into
// their OWN accounts (the whole point of Holo Messenger), not disclosing PII to an arbitrary site. So
// they are exempt from the conscience gate's data-minimisation red-line (which guards against LEAKING
// the operator's PII outward, a different act). Host-suffix match, mirroring holo-bridge-adapters.
bool IsMessengerHost(const std::string& url) {
  static const char* const kMsgrHosts[] = {
      "web.whatsapp.com", "web.telegram.org", "discord.com", "discordapp.com", "app.slack.com",
      "x.com", "twitter.com", "mobile.twitter.com", "www.messenger.com", "messenger.com",
      "www.instagram.com", "instagram.com", "www.linkedin.com", "linkedin.com", "messages.google.com" };
  const std::string host = HostOf(url);
  if (host.empty()) return false;
  for (const char* d : kMsgrHosts) {
    const size_t dl = std::strlen(d);
    if (host.size() >= dl && host.compare(host.size() - dl, dl, d) == 0 &&
        (host.size() == dl || host[host.size() - dl - 1] == '.'))
      return true;
  }
  return false;
}

// The block page shown when the user's constitution refuses a destination. A data: URL (not http/https)
// so it is not itself re-judged. Minimal, honest, no external assets.
std::string BlockPageUrl(const std::string& url) {
  return std::string("data:text/html,") +
         "<title>Blocked%20by%20Hologram</title>" +
         "<body style='font:16px system-ui;background:%230b0b12;color:%23e8e8f0;padding:14vh%2010vw'>" +
         "<h1 style='font-weight:600'>Blocked%20by%20your%20Hologram%20constitution</h1>" +
         "<p>This%20navigation%20was%20refused%20by%20the%20conscience%20gate%20(red-line%20P5%20%E2%80%94%20" +
         "data%20minimisation):%20the%20destination%20carries%20personally-identifying%20data.</p></body>";
}
}  // namespace

bool SimpleHandler::OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                                   CefRefPtr<CefFrame> frame,
                                   CefRefPtr<CefRequest> request,
                                   bool /*user_gesture*/,
                                   bool /*is_redirect*/) {
  router_->OnBeforeBrowse(browser, frame);
  if (!frame->IsMain()) return false;  // govern only top-level navigations, not subframes/subresources
  const std::string url = request->GetURL().ToString();
  // Only WEB schemes are judged by the conscience gate here. holo:// is governed at its own κ-mount
  // (Terms/Privacy/conscience); chrome://, about:, data: are internal/already-decided and pass.
  // New tab / NTP → Hologram home (replace Google's new-tab page). Redirect once; holo:// isn't re-matched.
  if (url.rfind("chrome://newtab", 0) == 0 || url.rfind("chrome://new-tab-page", 0) == 0) {
    frame->LoadURL("holo://os/home.html?embed=1");
    return true;
  }
  if (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0) return false;
  if (IsMessengerHost(url)) return false;  // a sanctioned messenger destination — never gated by the PII red-line
  // Our own re-navigation of a cleared URL passes exactly once (so the verdict isn't re-run into a loop).
  auto a = approved_.find(url);
  if (a != approved_.end()) { approved_.erase(a); return false; }
  // The verdict runs in the service (the user's policy is JS). No service context ⇒ governance can't
  // run; rather than brick browsing we let it through (the home/service tab being closed is the known
  // limitation of hosting the service in the shell frame; the dedicated service context removes it).
  CefRefPtr<CefFrame> svc = ServiceFrame();
  if (!svc) return false;
  const int gid = next_gov_id_++;
  gov_pending_[gid] = { browser, url };
  const std::string js = "window.__holoGov&&window.__holoGov(" + std::to_string(gid) + ",\"" +
                         json_escape(url) + "\");";
  svc->ExecuteJavaScript(js, svc->GetURL(), 0);
  return true;  // hold the navigation; ResolveGov re-navigates if the constitution allows it
}

void SimpleHandler::ResolveGov(int gov_id, bool allow) {
  CEF_REQUIRE_UI_THREAD();
  auto it = gov_pending_.find(gov_id);
  if (it == gov_pending_.end()) return;
  CefRefPtr<CefBrowser> browser = it->second.browser;
  const std::string url = it->second.url;
  gov_pending_.erase(it);
  if (!browser) return;
  if (allow) {
    approved_.insert(url);                          // one-shot pass for our own re-navigation
    browser->GetMainFrame()->LoadURL(url);
  } else {
    browser->GetMainFrame()->LoadURL(BlockPageUrl(url));
  }
}

CefRefPtr<CefResourceRequestHandler> SimpleHandler::GetResourceRequestHandler(
    CefRefPtr<CefBrowser> /*browser*/,
    CefRefPtr<CefFrame> /*frame*/,
    CefRefPtr<CefRequest> /*request*/,
    bool /*is_navigation*/,
    bool /*is_download*/,
    const CefString& /*request_initiator*/,
    bool& /*disable_default_handling*/) {
  return this;  // screen every resource load through OnBeforeResourceLoad
}

// Substitute, don't deny: ads/detectors are SURROGATED (served inert 200) in GetResourceHandler, not
// cancelled here — a cancelled request is the #1 anti-adblock tell. Nothing is refused at this stage.
cef_return_value_t SimpleHandler::OnBeforeResourceLoad(CefRefPtr<CefBrowser> /*browser*/,
                                                       CefRefPtr<CefFrame> /*frame*/,
                                                       CefRefPtr<CefRequest> /*request*/,
                                                       CefRefPtr<CefCallback> /*callback*/) {
  return RV_CONTINUE;
}

// Serve an inert surrogate (HTTP 200) for ad/detector requests so the page can't tell anything was blocked:
// gpt→no-op window.googletag, analytics→window.ga/gtag, other ad scripts→empty no-op, ad images→1×1 GIF,
// everything else→empty 200. A success, never a cancel. (the κ substrate at holo:// is never touched.)
CefRefPtr<CefResourceHandler> SimpleHandler::GetResourceHandler(CefRefPtr<CefBrowser> /*browser*/,
                                                               CefRefPtr<CefFrame> /*frame*/,
                                                               CefRefPtr<CefRequest> request) {
  const std::string url = request->GetURL().ToString();
  if (url.rfind("holo://", 0) == 0) return nullptr;
  // Open-web κ-cache: serve a HIT from the substrate, ZERO network — every cacheable subresource, any site,
  // any tab. (Populated by the tee filter on the cold miss; see GetResourceResponseFilter.)
  if (IsCacheableWeb(request)) {
    uint8_t* p = nullptr; size_t len = 0; char* mime = nullptr;
    if (kr_cache_get(WebCache(), url.c_str(), &p, &len, &mime) == 1)
      return new HoloKappaCacheHandler(p, len, mime);
  }
  if (!IsAdRequest(url) && !IsAaDetect(url)) return nullptr;  // not ad/detector → normal network load
  if (IsGptScript(url))
    return new HoloSurrogateHandler(kGptSurrogate, sizeof(kGptSurrogate) - 1, "application/javascript");
  if (IsGaScript(url))
    return new HoloSurrogateHandler(kGaSurrogate, sizeof(kGaSurrogate) - 1, "application/javascript");
  switch (request->GetResourceType()) {
    case RT_SCRIPT:
      return new HoloSurrogateHandler(kNoopJs, sizeof(kNoopJs) - 1, "application/javascript");
    case RT_IMAGE:
      return new HoloSurrogateHandler(reinterpret_cast<const char*>(kGif1x1), sizeof(kGif1x1), "image/gif");
    default:
      return new HoloSurrogateHandler("", 0, "text/plain");  // empty 200 for xhr/fetch/beacon/etc.
  }
}

CefRefPtr<CefResponseFilter> SimpleHandler::GetResourceResponseFilter(
    CefRefPtr<CefBrowser> /*browser*/,
    CefRefPtr<CefFrame> /*frame*/,
    CefRefPtr<CefRequest> request,
    CefRefPtr<CefResponse> response) {
  const CefRequest::ResourceType rt = request->GetResourceType();

  // Inject the per-page bootstrap(s) into real-web top-level HTML (NOT holo://; the substrate is untouched and
  // the OS shell runs its own). Playground is NO LONGER here — it moved to app.cc host-injection (CSP-proof);
  // this splice now carries the messenger-capture boot (kTag). Same CSP caveat applies to it on strict hosts.
  if (rt == RT_MAIN_FRAME) {
    const std::string url = request->GetURL().ToString();
    const std::string mime = response ? response->GetMimeType().ToString() : std::string();
    if (url.rfind("holo://", 0) != 0 && mime.find("text/html") != std::string::npos)
      return new HoloPlaygroundInjectFilter();
  }

  LoadAdKappaOnce();
  const std::string url = request->GetURL().ToString();
  if (url.rfind("holo://", 0) == 0) return nullptr;  // never touch the κ substrate
  // ad-κ scripts take precedence (the ad filter drops denylisted payloads by content κ)
  if (!g_ad_kappa.empty() && rt == RT_SCRIPT) return new HoloAdKappaFilter();
  // Open-web κ-cache POPULATE: tee a cacheable subresource body into the substrate (cold miss only — a HIT
  // is served upstream with no filter). Applies to EVERY site in EVERY CEF tab; cold-novel only.
  if (IsCacheableWeb(request)) {
    const std::string mime = response ? response->GetMimeType().ToString() : std::string();
    return new HoloKappaTeeFilter(url, mime, ImmutableByHeaders(response, url));
  }
  return nullptr;
}

void SimpleHandler::OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                              TerminationStatus /*status*/,
                                              int /*error_code*/,
                                              const CefString& /*error_string*/) {
  router_->OnRenderProcessTerminated(browser);
}

bool SimpleHandler::OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                             CefRefPtr<CefFrame> frame,
                                             CefProcessId source_process,
                                             CefRefPtr<CefProcessMessage> message) {
  return router_->OnProcessMessageReceived(browser, frame, source_process, message);
}

void SimpleHandler::OpenTab(const std::string& holo_url) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::OpenTab, this, holo_url));
    return;
  }
  // Same Chrome-runtime browser the app opens its window with — Chromium presents it as a real surface.
  CefBrowserSettings settings;
  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Hologram");
  window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
  CefBrowserHost::CreateBrowser(window_info, this, holo_url, settings, nullptr, nullptr);
}

void SimpleHandler::CloseAllBrowsers(bool force_close) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::CloseAllBrowsers, this, force_close));
    return;
  }
  for (auto& b : browser_list_) b->GetHost()->CloseBrowser(force_close);
}
