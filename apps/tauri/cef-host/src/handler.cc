// handler.cc — browser tracking + the origin-tiered Hologram bridge (the seam's security boundary).
#include "handler.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include "holo_media.h"  // κ Universal Media Resolver backend (ffmpeg H.264→VP9/Opus transcode)
#include "holo_osr.h"     // off-screen projection producer: OpenOsr / DispatchOsrInput (P4 live projection)
#include "kappa_scheme.h"  // HoloCreateScHandler — native /sc/* media streaming for the dock apps
#include "holo_hello.h"   // native platform-authenticator (Windows Hello) login ceremony (no iframe / no prompt)
#include "holo_winicon.h" // force the Hologram H as the native window + taskbar icon (de-brand the Chromium logo)

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
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"

#include <cstdio>

#include "broker_server.h"
#include "window.h"  // HoloShellWindowDelegate / HoloBrowserViewDelegate — shell-is-chrome Views window
#include "sha256.h"  // hash-link the lifecycle strand (process L5)

#include <ctime>

// ── The unified operator identity. Set by the trusted shell/greeter (window.cefQuery 'holo:identity:…') right
// after the TEE-secured biometric login gate succeeds, and read by the DID-document endpoint (kappa_scheme.cc).
// So the host's W3C peer/mesh/agent DID IS the authenticated user's operator κ — one identity, every surface.
// Thread-safe: OnQuery runs on the UI thread; the resource handler reads on the IO thread.
namespace {
std::mutex g_operator_mu;
std::string g_operator_did;          // the operator κ (already a valid did:holo:sha256:<hex>)
std::vector<uint8_t> g_operator_pub;  // the operator's Ed25519 public key bytes
}  // namespace

// The shared κ dir the mesh sidecar uses — identical to SharedCache(): HOLO_SHARED_DIR, else %TEMP%\holo-shared-kappa.
std::string HostSharedDir() {
  std::string dir;
  if (const char* d = std::getenv("HOLO_SHARED_DIR")) dir = d;
  if (dir.empty()) {
    const char* t = std::getenv("TEMP");
    if (!t) t = std::getenv("TMP");
    dir = std::string(t ? t : ".") + "\\holo-shared-kappa";
  }
  return dir;
}

// The mesh node's public key (hex), written by the node at startup — what the shell signs to issue a delegation.
std::string HostMeshPub() {
  std::ifstream f(HostSharedDir() + "\\_mesh.pub", std::ios::binary);
  std::string hex;
  std::getline(f, hex);
  while (!hex.empty() && (hex.back() == '\n' || hex.back() == '\r' || hex.back() == ' ')) hex.pop_back();
  return hex;
}

// Write the login-issued delegation (operator signs the node's mesh key) so the node starts proving its identity.
void SetHostDelegation(const std::string& line) {
  const std::string dir = HostSharedDir();
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  std::ofstream f(dir + "\\_operator.delegation", std::ios::trunc | std::ios::binary);
  if (f) f << line;
}

// Store the operator identity the shell pushed (κ + public-key hex). Empty `did` clears it (logout → anonymous).
void SetHostOperator(const std::string& did, const std::string& pub_hex) {
  std::vector<uint8_t> pub;
  for (size_t i = 0; i + 1 < pub_hex.size(); i += 2)
    pub.push_back(static_cast<uint8_t>(std::strtol(pub_hex.substr(i, 2).c_str(), nullptr, 16)));
  {
    std::lock_guard<std::mutex> lk(g_operator_mu);
    g_operator_did = did;
    g_operator_pub = std::move(pub);
  }
  // Tether the MESH peer to the login too: write the operator DID into the shared dir, so the local mesh
  // sidecar advertises content as served by THIS authenticated user (did:holo:<operator>). Empty did (logout)
  // writes an empty file → the sidecar reverts to anonymous.
  std::error_code ec;
  std::filesystem::create_directories(HostSharedDir(), ec);
  std::ofstream f(HostSharedDir() + "\\_operator.did", std::ios::trunc | std::ios::binary);
  if (f) f << did;
}

// The current authenticated operator identity, or false if none (pre-login / logged out). Used by did.json.
bool HostOperator(std::string& did, std::vector<uint8_t>& pub) {
  std::lock_guard<std::mutex> lk(g_operator_mu);
  if (g_operator_did.empty() || g_operator_pub.empty()) return false;
  did = g_operator_did;
  pub = g_operator_pub;
  return true;
}

// VALIDATE-BEFORE-SERVE for Linked Data. If a response IS JSON-LD — an ld+json / did+json type, or JSON that
// declares an `@context` — re-derive its W3C conformance (kr_ld_validate: every property must be an AS2 /
// schema.org / DID-core term, a JSON-LD keyword, or a term the doc's OWN @context declares) and return
// "valid"/"invalid" to stamp as X-Holo-LD, so every semantic object the substrate emits carries a conformance
// attestation — not just the DID document. Returns nullptr for non-LD responses (no stamp). Bounded: LD docs
// are small, so >1 MiB bodies are skipped rather than copied/parsed on the hot path.
const char* HoloLdVerdict(const std::string& mime, const char* body, size_t len) {
  if (!body || len == 0 || len > (1u << 20)) return nullptr;
  const bool ld_mime = mime.find("ld+json") != std::string::npos || mime.find("did+json") != std::string::npos;
  const bool json_mime = mime.find("json") != std::string::npos;
  // Also treat a `{`-prefixed body as a JSON-LD candidate even without an LD mime — this catches a κ-object
  // fetched over the mesh and served as octet-stream (until MIME rides the mesh). Images/HTML don't start '{'.
  size_t i = 0;
  while (i < len && (body[i] == ' ' || body[i] == '\t' || body[i] == '\n' || body[i] == '\r')) ++i;
  const bool looks_json = i < len && body[i] == '{';
  if (!ld_mime && !json_mime && !looks_json) return nullptr;  // not JSON / Linked Data
  std::string s(body, len);
  if (!ld_mime && s.find("@context") == std::string::npos) return nullptr;  // plain JSON, not Linked Data
  return kr_ld_validate(s.c_str()) == 1 ? "valid" : "invalid";
}

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

// True for a youtube.com / youtu.be PAGE that should open in the native Hologram YouTube surface instead of the
// raw site. Measured (Phase 0): YouTube's polymer feed never instantiates on this engine — the home/search/
// channel shell hangs on skeleton loaders. So we route the human-facing site (home, search, channel, playlist,
// AND watch) to holo://os/apps/youtube, which reads the same catalog via yt-dlp metadata and projects every
// video through Holo Video. music./studio. subdomains and asset/API hosts (i.ytimg, googlevideo, youtubei) are
// not matched — those are sub-resources, not top-level navigations, so they never reach this gate anyway.
static bool IsYouTubeSite(const std::string& url) {
  const std::string host = HostOf(url);
  return host == "youtube.com" || host == "www.youtube.com" || host == "m.youtube.com" ||
         host == "youtu.be" || host == "www.youtu.be";
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
  // Resident working set auto-sized to this device's RAM (no setting): weak laptop → small, workstation
  // → large. Takes full advantage of the hardware while staying lean; abstracts the complexity entirely.
  static KCache* c = kr_cache_new_auto();
  return c;
}

// ── Planetary shared-κ substrate. The layer above the local cache: a content-addressed store keyed BY κ
// behind a transport every node reaches, so the web's FIRST load for you can be served from a blob a PEER
// already minted (origin untouched, only a hash crosses the wire). A read re-derives the κ and refuses a
// mismatch (L5), so an untrusted relay is safe. This landing backs it with a directory (HOLO_SHARED_DIR, or
// a temp subdir) — a real cross-process/persistent stand-in for a relay; a network relay is the same
// get/put-BY-κ interface. The url→κ the HIT seam needs comes from the gossip manifest (kr_shared_note on a
// cold miss). NULL ⇒ shared layer disabled (the local cache + network still work).
KShared* SharedCache() {
  static KShared* s = [] {
    std::string dir;
    if (const char* d = std::getenv("HOLO_SHARED_DIR")) dir = d;
    if (dir.empty()) {
      const char* t = std::getenv("TEMP");
      if (!t) t = std::getenv("TMP");
      dir = std::string(t ? t : ".") + "\\holo-shared-kappa";
    }
    return kr_shared_open(dir.c_str());
  }();
  return s;
}

// Which loads are cacheable: GET, http(s), and a static, immutable-by-nature subresource type — now
// including MEDIA (video/audio), served RANGE-AWARE (206) from κ so <video>/<audio> can seek. Documents
// and XHR/fetch stay EXCLUDED: dynamic responses must never be served stale. A 206 partial is never
// STORED as if whole (only full 200 bodies are teed — see GetResourceResponseFilter), so a stored object
// is always complete and any byte-range is sliced from it on replay (HoloKappaCacheHandler).
bool IsCacheableWeb(CefRefPtr<CefRequest> request) {
  if (request->GetMethod().ToString() != "GET") return false;
  const std::string url = request->GetURL().ToString();
  if (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0) return false;
  switch (request->GetResourceType()) {
    case RT_SCRIPT:
    case RT_STYLESHEET:
    case RT_IMAGE:
    case RT_FONT_RESOURCE:
    case RT_MEDIA:
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

// Map a URL's file extension → a sensible Content-Type. The mesh wire (BareNetSync) carries bytes only — no
// MIME — so a peer-fetched blob lands with the stored mime "application/octet-stream". We recover the type from
// the request URL the local browser already holds, so a CSS/JS/font/image served over the mesh renders instead
// of downloading. Content-addressed: the bytes are L5-verified regardless; this only labels them.
static std::string HoloMimeFromUrl(const std::string& url) {
  std::string path = url;
  const size_t q = path.find_first_of("?#");
  if (q != std::string::npos) path = path.substr(0, q);
  const size_t dot = path.find_last_of('.');
  if (dot == std::string::npos || dot < path.find_last_of('/') + 1) return std::string();
  std::string ext = path.substr(dot + 1);
  for (char& c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (ext == "css") return "text/css";
  if (ext == "js" || ext == "mjs") return "text/javascript";
  if (ext == "json") return "application/json";
  if (ext == "wasm") return "application/wasm";
  if (ext == "html" || ext == "htm") return "text/html";
  if (ext == "svg") return "image/svg+xml";
  if (ext == "png") return "image/png";
  if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
  if (ext == "gif") return "image/gif";
  if (ext == "webp") return "image/webp";
  if (ext == "avif") return "image/avif";
  if (ext == "ico") return "image/x-icon";
  if (ext == "woff2") return "font/woff2";
  if (ext == "woff") return "font/woff";
  if (ext == "ttf") return "font/ttf";
  if (ext == "otf") return "font/otf";
  if (ext == "mp4" || ext == "m4v") return "video/mp4";
  if (ext == "webm") return "video/webm";
  if (ext == "mp3") return "audio/mpeg";
  if (ext == "m4a") return "audio/mp4";
  if (ext == "wav") return "audio/wav";
  if (ext == "txt") return "text/plain";
  if (ext == "xml") return "application/xml";
  if (ext == "pdf") return "application/pdf";
  return std::string();
}

// Serve a κ-HIT: a Rust-heap buffer (freed via kr_free) + mime (kr_cache_free_mime). Mirrors HoloSurrogateHandler.
class HoloKappaCacheHandler : public CefResourceHandler {
 public:
  // `source` is the observable X-Holo-Source value: "kappa-cache" for a LOCAL hit, "kappa-shared" for a
  // hit served from a PEER's blob via the shared substrate. Both are content-addressed + L5-verified.
  // `mime_hint` (optional) labels a blob whose stored mime is missing/octet-stream — e.g. a mesh-fetched
  // object, where the wire carried no MIME — derived from the request URL extension. The stored mime wins
  // when it is meaningful; the hint only fills the gap so the resource renders rather than downloads.
  HoloKappaCacheHandler(uint8_t* data, size_t len, char* mime, const char* source = "kappa-cache",
                        std::string mime_hint = std::string())
      : data_(data), len_(len), mime_(mime), source_(source), mime_hint_(std::move(mime_hint)) {}
  ~HoloKappaCacheHandler() override {
    if (data_) kr_free(data_, len_);
    if (mime_) kr_cache_free_mime(mime_);
  }
  bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback>) override {
    handle_request = true;
    range_end_ = (len_ > 0) ? len_ - 1 : 0;  // default span = the whole object [0, len-1]
    // Honor a single byte-range so a fully-cached media object SEEKS (HTML <video>/<audio> issue Range
    // requests). The stored object is always complete, so any range is just a slice — no network.
    const std::string r = request ? request->GetHeaderByName("Range").ToString() : std::string();
    if (len_ > 0 && r.rfind("bytes=", 0) == 0) {
      const std::string spec = r.substr(6);
      const size_t dash = spec.find('-');
      if (dash != std::string::npos && spec.find(',') == std::string::npos) {  // a single range only
        const std::string a = spec.substr(0, dash), b = spec.substr(dash + 1);
        size_t start = 0, end = len_ - 1;
        bool ok = true;
        if (!a.empty()) {                       // bytes=START-[END]
          start = static_cast<size_t>(std::strtoull(a.c_str(), nullptr, 10));
          if (!b.empty()) end = static_cast<size_t>(std::strtoull(b.c_str(), nullptr, 10));
        } else if (!b.empty()) {                // bytes=-SUFFIX → the last SUFFIX bytes
          const size_t suffix = static_cast<size_t>(std::strtoull(b.c_str(), nullptr, 10));
          start = (suffix >= len_) ? 0 : len_ - suffix;
        } else {
          ok = false;
        }
        if (end >= len_) end = len_ - 1;
        if (ok && start <= end) { range_start_ = start; range_end_ = end; partial_ = true; }
      }
    }
    off_ = range_start_;
    return true;
  }
  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString&) override {
    std::string mt = mime_ ? std::string(mime_) : std::string();
    if ((mt.empty() || mt == "application/octet-stream") && !mime_hint_.empty()) mt = mime_hint_;  // recover MIME for a mesh blob
    response->SetMimeType(mt.empty() ? std::string("application/octet-stream") : mt);
    CefResponse::HeaderMap h;
    response->GetHeaderMap(h);
    h.insert(std::make_pair("X-Holo-Source", source_));           // observable proof in DevTools/Network
    h.insert(std::make_pair("Access-Control-Allow-Origin", "*"));  // a κ-hit must not break CORS-mode loads
    h.insert(std::make_pair("Accept-Ranges", "bytes"));            // advertise seekability (media)
    // validate-before-serve: every LD κ-object served from the cache / shared substrate / mesh carries its W3C
    // conformance verdict, so a consumer or agent trusts the meaning, not just the bytes.
    if (const char* ld = HoloLdVerdict(mime_ ? std::string(mime_) : std::string(), reinterpret_cast<const char*>(data_), len_))
      h.insert(std::make_pair("X-Holo-LD", ld));
    const size_t slice = (range_end_ >= range_start_) ? (range_end_ - range_start_ + 1) : 0;
    if (partial_) {
      response->SetStatus(206);
      response->SetStatusText("Partial Content");
      h.insert(std::make_pair("Content-Range", "bytes " + std::to_string(range_start_) + "-" +
                                                   std::to_string(range_end_) + "/" + std::to_string(len_)));
    } else {
      response->SetStatus(200);
      response->SetStatusText("OK");
    }
    response->SetHeaderMap(h);
    response_length = static_cast<int64_t>(slice);
  }
  bool Read(void* out, int n, int& read, CefRefPtr<CefResourceReadCallback>) override {
    const size_t limit = (range_end_ < len_) ? range_end_ + 1 : len_;  // exclusive end within data_
    if (off_ >= limit) { read = 0; return false; }
    const size_t avail = limit - off_;
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
  const char* source_;
  std::string mime_hint_;   // URL-derived fallback type for a blob with no/octet-stream stored mime (mesh)
  size_t off_ = 0;
  size_t range_start_ = 0;
  size_t range_end_ = 0;    // inclusive end of the served span
  bool partial_ = false;    // true → 206 Partial Content
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
      // Also publish to the SHARED substrate so the next node anywhere rides it, and gossip url→κ so a node
      // that never fetched this url can resolve its κ. The byte transport stays κ-only; only the public
      // url↔κ fact is shared. (kr_shared_put recomputes the κ from the bytes — the put cannot mislabel.)
      if (KShared* sc = SharedCache()) {
        char kx[65] = {0};
        kr_sha256_hex(reinterpret_cast<const uint8_t*>(buf_.data()), buf_.size(), kx);
        kr_shared_put(sc, kx, reinterpret_cast<const uint8_t*>(buf_.data()), buf_.size(), mime_.c_str());
        kr_shared_note(sc, url_.c_str(), kx);
      }
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

// ── κ Universal Media Resolver ─────────────────────────────────────────────────────────────────────
// The prebuilt libcef has no H.264/AAC decoder, so clear .mp4 media the web ships does not play. This
// handler intercepts such a load at the SAME GetResourceHandler seam the κ-cache owns, transcodes the
// source → VP9/Opus WebM (which the engine DOES decode) via ffmpeg, and serves it — content-addressed in
// the κ-substrate so a repeat anywhere is instant (X-Holo-Source: kappa-media). DRM is untouched (the CDM
// path is separate). Fail-closed = no worse than today (the engine couldn't play the source anyway).
// Cache key namespaces media so a transcode can't collide with the open-web κ-cache.
static std::string HoloMediaCacheKey(const std::string& url) { return "holo-media-vp9:" + url; }

// Opt-in master switch (HOLO_MEDIA_RESOLVER=1), read once. OFF by default so the resolver can never affect
// normal operation until explicitly enabled.
static bool HoloMediaResolverEnabled() {
  static const bool on = [] { const char* e = std::getenv("HOLO_MEDIA_RESOLVER"); return e && e[0] == '1'; }();
  return on;
}

class HoloMediaResolverHandler : public CefResourceHandler {
 public:
  explicit HoloMediaResolverHandler(std::string url) : url_(std::move(url)) {}

  bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback> callback) override {
    // Parse a Range header up front. We can satisfy ranges only from a COMPLETE (cache-hit) buffer; a live
    // transcode is served as a linear 200 (the browser plays progressively, no seek until it's κ-cached).
    const std::string range = request->GetHeaderByName("Range").ToString();
    if (range.rfind("bytes=", 0) == 0) {
      has_range_ = true;
      const std::string r = range.substr(6);
      const size_t dash = r.find('-');
      if (dash != std::string::npos) {
        if (dash > 0) range_start_ = std::strtoull(r.substr(0, dash).c_str(), nullptr, 10);
        const std::string e = r.substr(dash + 1);
        if (!e.empty()) range_end_ = std::strtoull(e.c_str(), nullptr, 10);
      }
    }
    handle_request = false;  // decide later — cache lookup / transcode happens off the IO thread
    CefRefPtr<CefResourceHandler> self(this);
    const std::string key = HoloMediaCacheKey(url_);
    std::thread([self, this, key, callback]() {
      // κ-media-cache HIT → instant + seekable (complete buffer, Range supported).
      uint8_t* p = nullptr; size_t len = 0; char* mime = nullptr;
      if (kr_cache_get(WebCache(), key.c_str(), &p, &len, &mime) == 1) {
        data_.assign(reinterpret_cast<const char*>(p), len);
        from_cache_ = true;
        if (p) kr_free(p, len);
        if (mime) kr_cache_free_mime(mime);
        callback->Continue();
        return;
      }
      // MISS → STREAM the transcode: serve bytes as ffmpeg emits them so a feature-length film starts in
      // ~1-2 s instead of after a whole-file transcode. We read the FIRST chunk before committing headers
      // so an immediate failure becomes a clean 502 (not an empty 200), then drain the rest into buf_.
      HoloTranscodeStream* st = HoloTranscodeStreamStart(url_);
      if (!st) { failed_ = true; callback->Continue(); return; }
      char tmp[65536];
      int r = HoloTranscodeStreamRead(st, tmp, sizeof(tmp));
      if (r <= 0) { failed_ = true; HoloTranscodeStreamFree(st); callback->Continue(); return; }
      { std::lock_guard<std::mutex> lk(mu_); buf_.append(tmp, static_cast<size_t>(r)); }
      streaming_ = true;
      callback->Continue();  // 200 streaming; first cluster already buffered for an instant start
      for (;;) {
        if (cancelled_) { std::lock_guard<std::mutex> lk(mu_); complete_ = true; break; }
        int n = HoloTranscodeStreamRead(st, tmp, sizeof(tmp));
        if (n > 0) {
          { std::lock_guard<std::mutex> lk(mu_); buf_.append(tmp, static_cast<size_t>(n)); }
          WakePending();
        } else {
          const bool clean = (n == 0);
          std::string whole;
          { std::lock_guard<std::mutex> lk(mu_); complete_ = true; if (clean) whole = buf_; }
          // κ-cache the fully-assembled stream so the NEXT open is instant + seekable (Range path above).
          if (clean && !whole.empty())
            kr_cache_put(WebCache(), key.c_str(), reinterpret_cast<const uint8_t*>(whole.data()),
                         whole.size(), "video/webm", 0 /*revalidatable*/);
          WakePending();
          break;
        }
      }
      HoloTranscodeStreamFree(st);
    }).detach();
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length,
                          CefString& /*redirectUrl*/) override {
    CefResponse::HeaderMap h;
    response->GetHeaderMap(h);
    h.insert(std::make_pair("Access-Control-Allow-Origin", "*"));
    if (failed_ || (!streaming_ && data_.empty())) {
      response->SetStatus(502);
      response->SetStatusText("Media Transcode Failed");
      response->SetHeaderMap(h);
      response_length = 0;
      return;
    }
    response->SetMimeType("video/webm");
    if (streaming_) {
      // Live transcode: unknown total length, no random access. Linear 200; CEF reads until Read() signals
      // EOF. No Accept-Ranges so <video> plays progressively rather than issuing ranges we can't satisfy.
      h.insert(std::make_pair("X-Holo-Source", "kappa-media-stream"));
      response->SetStatus(200);
      response->SetStatusText("OK");
      response->SetHeaderMap(h);
      response_length = -1;  // unknown → stream until EOF
      return;
    }
    // Complete buffer (cache hit): seekable, Range-capable.
    const uint64_t total = data_.size();
    h.insert(std::make_pair("X-Holo-Source", from_cache_ ? "kappa-media-cache" : "kappa-media"));
    h.insert(std::make_pair("Accept-Ranges", "bytes"));
    if (range_start_ >= total) range_start_ = 0, has_range_ = false;  // invalid range → serve whole
    const uint64_t end = (has_range_ && range_end_ + 1 != 0 && range_end_ < total) ? range_end_ : total - 1;
    serve_off_ = has_range_ ? range_start_ : 0;
    serve_end_ = end;  // inclusive
    if (has_range_) {
      response->SetStatus(206);
      response->SetStatusText("Partial Content");
      h.insert(std::make_pair("Content-Range",
                              "bytes " + std::to_string(serve_off_) + "-" + std::to_string(serve_end_) +
                                  "/" + std::to_string(total)));
    } else {
      response->SetStatus(200);
      response->SetStatusText("OK");
    }
    response->SetHeaderMap(h);
    response_length = static_cast<int64_t>(serve_end_ - serve_off_ + 1);
  }

  bool Read(void* out, int n, int& read, CefRefPtr<CefResourceReadCallback> cb) override {
    if (streaming_) {
      std::lock_guard<std::mutex> lk(mu_);
      if (sread_ < buf_.size()) {  // bytes available now → sync copy
        const size_t cnt = std::min<size_t>(static_cast<size_t>(n), buf_.size() - sread_);
        std::memcpy(out, buf_.data() + sread_, cnt);
        sread_ += cnt; read = static_cast<int>(cnt);
        return true;
      }
      if (complete_) { read = 0; return false; }  // drained + finished → EOF
      // nothing buffered yet and more is coming → async: park the callback; the reader wakes it.
      pend_cb_ = cb; pend_out_ = out; pend_n_ = n; read = 0;
      return true;
    }
    // complete-buffer path (cache hit / failure)
    const uint64_t pos = serve_off_ + read_off_;
    if (failed_ || pos > serve_end_) { read = 0; return false; }
    const uint64_t avail = serve_end_ - pos + 1;
    const size_t cnt = static_cast<size_t>(std::min<uint64_t>(static_cast<uint64_t>(n), avail));
    std::memcpy(out, data_.data() + pos, cnt);
    read_off_ += cnt;
    read = static_cast<int>(cnt);
    return true;
  }

  void Cancel() override { cancelled_ = true; }

 private:
  // Fulfil a parked async Read once bytes have arrived (or the stream finished). Continue() is invoked
  // OUTSIDE the lock so CEF's re-entrant Read() can take the lock without deadlocking.
  void WakePending() {
    CefRefPtr<CefResourceReadCallback> cb;
    int produced = 0;
    {
      std::lock_guard<std::mutex> lk(mu_);
      if (!pend_cb_) return;
      if (sread_ < buf_.size()) {
        const size_t cnt = std::min<size_t>(static_cast<size_t>(pend_n_), buf_.size() - sread_);
        std::memcpy(pend_out_, buf_.data() + sread_, cnt);
        sread_ += cnt; produced = static_cast<int>(cnt);
      } else if (!complete_) {
        return;  // still nothing — keep waiting
      }                          // else: complete + drained → produced stays 0 (EOF)
      cb = pend_cb_; pend_cb_ = nullptr; pend_out_ = nullptr; pend_n_ = 0;
    }
    cb->Continue(produced);
  }

  std::string url_;
  std::string data_;                 // complete transcoded WebM (cache-hit path; written before Continue)
  bool from_cache_ = false;
  std::atomic<bool> failed_{false};
  bool has_range_ = false;
  uint64_t range_start_ = 0, range_end_ = ~0ull;  // ~0 = open-ended
  uint64_t serve_off_ = 0, serve_end_ = 0, read_off_ = 0;
  // streaming path
  bool streaming_ = false;
  std::atomic<bool> cancelled_{false};
  std::mutex mu_;
  std::string buf_;                  // grows as ffmpeg emits (guarded by mu_)
  bool complete_ = false;            // EOF/error reached (guarded by mu_)
  uint64_t sread_ = 0;               // streaming read offset (guarded by mu_)
  CefRefPtr<CefResourceReadCallback> pend_cb_;  // parked async read (guarded by mu_)
  void* pend_out_ = nullptr;
  int pend_n_ = 0;
  IMPLEMENT_REFCOUNTING(HoloMediaResolverHandler);
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
  HoloPlaygroundInjectFilter() = default;
  // url+mime ⇒ ALSO capture the document into the κ-cache for the Living Window manifest. Capture-only:
  // documents are never served as cache-hits (IsCacheableWeb excludes them), so there is no stale-serve risk.
  HoloPlaygroundInjectFilter(std::string url, std::string mime) : url_(std::move(url)), mime_(std::move(mime)) {}
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
      decided_ = true;  // end of body → capture the document (for the manifest), then splice (no-op)
      // Document-capture: store the ORIGINAL page bytes in the κ-cache so the Living Window composes from the
      // PAGES you browsed, not only subresources. Documents are NEVER served as cache-hits (IsCacheableWeb
      // excludes them) — capture-only, no stale-serve; the κ is over the real page bytes (provenance = the browse).
      if (!url_.empty() && buf_.size() <= kCap) {
        kr_cache_put(WebCache(), url_.c_str(), reinterpret_cast<const uint8_t*>(buf_.data()), buf_.size(),
                     mime_.c_str(), 0);
      }
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

  std::string buf_, url_, mime_;
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

// Expose the one shared open-web κ-cache to the κ-scheme handler (kappa_scheme.cc), so it can serve the
// Living Window's manifest (holo://os/cache/entries.json) from what you've browsed. External linkage —
// the cache itself is the anon-namespace magic-static above; this is the only door to it.
KCache* HoloWebCache() { return WebCache(); }
// External-linkage door to the planetary shared-κ transport (the anon-namespace SharedCache magic-static above)
// — the producer publishes cross-device projection tiles to it, and the κ serve route falls back to it.
KShared* HoloSharedCache() { return SharedCache(); }

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

    // ── κ-fabric goodput proof (InfiniBand-class) — run the bare-metal benchmark in native Rust and return
    // the measured ceilings + the effective-goodput sweep vs IB as JSON. So a holo:// page surfaces the proof
    // LIVE, the hot path (SIMD BLAKE3 + data-parallel verify) running in the host, not the browser JS. From
    // holo:// only. "holo:fabric:goodput[:<object_mb>]" (default 64 MiB).
    if (req.rfind("holo:fabric:goodput", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) { callback->Failure(403, "holo-bridge: fabric proof only from holo://"); return true; }
      size_t mb = 64;
      const size_t c = req.rfind(':');
      if (c != std::string::npos && c > std::string("holo:fabric:goodput").size() - 1) {
        const long v = std::atol(req.substr(c + 1).c_str());
        if (v > 0) mb = static_cast<size_t>(v);
      }
      char* json = kr_fabric_goodput(mb);     // bare-metal measurement, heap JSON
      if (json) { callback->Success(CefString(json)); kr_cache_free_mime(json); }
      else { callback->Failure(500, "kr_fabric_goodput failed"); }
      return true;
    }

    // ── O(1) compute bridge (holo:compute:*) — the upstream Hologram content-addressed tensor engine,
    // running BARE-METAL in-process. The host loads hologram_ffi.dll (beside the exe) ONCE and calls its C
    // ABI; a holo:// page surfaces the O(1) memo collapse (novel recompute vs κ-addressed graph-memo hit)
    // measured by the NATIVE engine, not the browser. "holo:compute:o1demo". The seam every app's
    // holo-compute call routes through; this verb is the de-risk proof that the engine is host-callable.
    // From holo:// only. (LoadLibrary is lazy + cached for the process; a missing DLL fails cleanly.)
    if (req.rfind("holo:compute:o1demo", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) { callback->Failure(403, "holo-bridge: compute only from holo://"); return true; }
      typedef char* (*O1DemoFn)();
      typedef void (*O1FreeFn)(char*);
      static HMODULE s_eng = nullptr;
      static O1DemoFn s_demo = nullptr;
      static O1FreeFn s_free = nullptr;
      if (!s_eng) {
        s_eng = LoadLibraryA("hologram_ffi.dll");   // deployed beside holo_cef_host.exe
        if (s_eng) {
          s_demo = reinterpret_cast<O1DemoFn>(GetProcAddress(s_eng, "hologram_o1_demo"));
          s_free = reinterpret_cast<O1FreeFn>(GetProcAddress(s_eng, "hologram_o1_demo_free"));
        }
      }
      if (!s_demo) { callback->Failure(500, "holo:compute: hologram engine not available (hologram_ffi.dll)"); return true; }
      char* json = s_demo();
      if (json) { callback->Success(CefString(json)); if (s_free) s_free(json); }
      else { callback->Failure(500, "holo:compute: o1 demo failed"); }
      return true;
    }

    // ── Verified-streaming PRODUCER bridge (holo:bao:*) — a holo:// page streams an OS-sealed κ-object as
    // BLAKE3-verified chunks straight from the native engine: render/play on chunk 0, the whole object never
    // re-hashed per request, each chunk proven by the consumer (holo-bao-stream / kr_bao_verify_slice). Reads
    // ONLY from the OS dir (HOLO_OS_DIR), path-sanitized — those bytes are already L5-sealed; the producer
    // emits proofs over them and the consumer verifies each chunk against the root it expects from the
    // catalog. "holo:bao:open:<rel-path>" → {"root","chunks","bytes"} (builds+caches the encoder once);
    // "holo:bao:chunk:<roothex>:<index>" → {"index","bytes"(hex),"proof"(hex, packed N×33)}. holo:// only.
    if (req.rfind("holo:bao:", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) { callback->Failure(403, "holo-bridge: bao stream only from holo://"); return true; }
      static std::mutex s_bao_mu;
      static std::map<std::string, BaoEncoder*> s_bao_cache;     // root hex → encoder (LRU-bounded below)
      auto hexenc = [](const uint8_t* p, size_t n) { static const char* H = "0123456789abcdef"; std::string s; s.reserve(n * 2); for (size_t i = 0; i < n; i++) { s.push_back(H[p[i] >> 4]); s.push_back(H[p[i] & 15]); } return s; };

      if (req.rfind("holo:bao:open:", 0) == 0) {
        std::string rel = req.substr(std::string("holo:bao:open:").size());
        // path sanitize: no traversal, no absolute / drive-qualified paths — read strictly under the OS dir.
        if (rel.empty() || rel.find("..") != std::string::npos || rel[0] == '/' || rel[0] == '\\' || (rel.size() > 1 && rel[1] == ':')) { callback->Failure(400, "holo:bao: bad path"); return true; }
        std::string osdir = "dist"; if (const char* e = std::getenv("HOLO_OS_DIR")) osdir = e;
        std::ifstream f(osdir + "/" + rel, std::ios::binary);
        if (!f) { callback->Failure(404, "holo:bao: not found"); return true; }
        std::string bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        BaoEncoder* enc = kr_bao_encoder_new(bytes.empty() ? nullptr : reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
        if (!enc) { callback->Failure(500, "holo:bao: encoder"); return true; }
        char root[65] = {0}; kr_bao_encoder_root(enc, root);
        const uint64_t chunks = kr_bao_encoder_chunk_count(enc);
        {
          std::lock_guard<std::mutex> lk(s_bao_mu);
          auto it = s_bao_cache.find(root);
          if (it != s_bao_cache.end()) { kr_bao_encoder_free(enc); }       // already cached (dedup) → drop the dup
          else { if (s_bao_cache.size() >= 8) { kr_bao_encoder_free(s_bao_cache.begin()->second); s_bao_cache.erase(s_bao_cache.begin()); } s_bao_cache[root] = enc; }
        }
        callback->Success(CefString(std::string("{\"root\":\"") + root + "\",\"chunks\":" + std::to_string(chunks) + ",\"bytes\":" + std::to_string(bytes.size()) + "}"));
        return true;
      }

      if (req.rfind("holo:bao:chunk:", 0) == 0) {
        const std::string rest = req.substr(std::string("holo:bao:chunk:").size());   // "<roothex>:<index>"
        const size_t colon = rest.find(':');
        if (colon == std::string::npos) { callback->Failure(400, "holo:bao: bad chunk req"); return true; }
        const std::string roothex = rest.substr(0, colon);
        const uint64_t index = std::strtoull(rest.substr(colon + 1).c_str(), nullptr, 10);
        BaoEncoder* enc = nullptr;
        { std::lock_guard<std::mutex> lk(s_bao_mu); auto it = s_bao_cache.find(roothex); if (it != s_bao_cache.end()) enc = it->second; }
        if (!enc) { callback->Failure(404, "holo:bao: open the object first"); return true; }
        uint8_t* cp = nullptr; size_t cl = 0; uint8_t* pp = nullptr; size_t pc = 0;
        if (kr_bao_encoder_chunk(enc, index, &cp, &cl, &pp, &pc) != 1) { callback->Failure(416, "holo:bao: index out of range"); return true; }
        std::string json = std::string("{\"index\":") + std::to_string(index) + ",\"bytes\":\"" + hexenc(cp, cl) + "\",\"proof\":\"" + hexenc(pp, pc * 33) + "\"}";
        kr_free(cp, cl); kr_free(pp, pc * 33);
        callback->Success(CefString(json));
        return true;
      }
      callback->Failure(400, "holo:bao: unknown verb");
      return true;
    }

    // ── Live projection (P4): the κ-tile lens surface drives the off-screen producer. ──
    // Input: the projector page captures DOM input on its canvas and forwards it here; we replay it on the
    // off-screen producer (which renders the real page) — closing the click-to-photon loop. From holo:// only.
    if (req.rfind("holo:osrinput:", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) { callback->Failure(403, "holo-bridge: osrinput only from holo://"); return true; }
      holo::DispatchOsrInput(req.substr(14));
      callback->Success("{\"ok\":true}");
      return true;
    }
    // Open a URL as a projected tab: the service opens the lens page, which fires holo:osrready, on which we
    // spawn the producer at the pending URL pointed at the lens frame. (Service origin only — it renders web.)
    static std::string s_pending_project_url;
    if (req.rfind("holo:project:", 0) == 0) {
      std::fprintf(stderr, "HOLO-PROJECT: project verb, origin=%s\n", origin.c_str()); std::fflush(stderr);
      if (origin.rfind("holo://os", 0) != 0) { callback->Failure(403, "holo-bridge: only the service may project"); return true; }
      s_pending_project_url = req.substr(13);
      owner_->OpenPopupWindow("holo://os/usr/lib/holo/holo-osr-projector.html");   // SEALED lens (no dev seam); top-level window w/ the main client (router)
      std::fprintf(stderr, "HOLO-PROJECT: opened lens window, pending=%s\n", s_pending_project_url.c_str()); std::fflush(stderr);
      callback->Success("{\"ok\":true}");
      return true;
    }
    if (req.rfind("holo:osrready", 0) == 0) {
      if (origin.find("holo-osr-projector") == std::string::npos) { callback->Failure(403, "holo-bridge: not the projector surface"); return true; }
      // The lens reports the resolution to render the producer at (its native display res) → pixel-native, no
      // upscale. "holo:osrready:<w>:<h>"; default 1280x800 if absent.
      int ow = 1280, oh = 800;
      // "holo:osrready:<w>:<h>[:<uri-encoded target>]". The optional 3rd field lets an in-OS lens NODE (an
      // iframe with ?target=<web url>) carry its OWN target inline → the producer is per-lens, with no shared
      // pending-url race across multiple projected tabs. The target is URI-encoded (encodeURIComponent), so it
      // contains no ':' to break this split. With no 3rd field we are the legacy popup lens (host holds the url).
      std::string node_url;
      const std::string rest = req.substr(std::string("holo:osrready").size());   // ":<w>:<h>[:<t>]" or ""
      if (rest.size() > 1 && rest[0] == ':') {
        const std::string body = rest.substr(1);
        const size_t c1 = body.find(':');
        if (c1 != std::string::npos) {
          const std::string after = body.substr(c1 + 1);
          const size_t c2 = after.find(':');
          const int w = std::atoi(body.substr(0, c1).c_str());
          const int h = std::atoi((c2 == std::string::npos ? after : after.substr(0, c2)).c_str());
          if (w >= 320 && h >= 240 && w <= 4096 && h <= 4096) { ow = w; oh = h; }
          if (c2 != std::string::npos && c2 + 1 < after.size()) {
            node_url = CefURIDecode(after.substr(c2 + 1), true,
                                    static_cast<cef_uri_unescape_rule_t>(UU_NORMAL | UU_SPACES | UU_PATH_SEPARATORS |
                                                                         UU_URL_SPECIAL_CHARS_EXCEPT_PATH_SEPARATORS))
                           .ToString();
          }
        }
      }
      const std::string proj_url = !node_url.empty() ? node_url : s_pending_project_url;
      if (!proj_url.empty()) {
        holo::OpenOsr(proj_url, frame, ow, oh);
        if (node_url.empty()) s_pending_project_url.clear();
        std::fprintf(stderr, "HOLO-PROJECT: producer opened at %dx%d (%s)\n", ow, oh, node_url.empty() ? "popup" : "node");
        std::fflush(stderr);
      }
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

    // ISP block-fallback resolve result: the service resolved a blocked URL's host to a content κ (κ-roots/
    // DoH, off-DNS). Format "holo:blockresolved:<id>:<κ-or-empty>". Only the service context may answer.
    if (req.rfind("holo:blockresolved:", 0) == 0) {
      if (origin.rfind("holo://os", 0) != 0) {
        callback->Failure(403, "holo-bridge: only the service context may resolve a block");
        return true;
      }
      const std::string rest = req.substr(std::string("holo:blockresolved:").size());  // "<id>:<κ-or-empty>"
      const size_t colon = rest.find(':');
      if (colon == std::string::npos) { callback->Failure(400, "holo-bridge: malformed block resolve"); return true; }
      owner_->ResolveBlock(std::atoi(rest.substr(0, colon).c_str()), rest.substr(colon + 1));
      callback->Success("{\"ok\":true}");
      return true;
    }

    // Omnibox-resolve reply: the service (origin holo://os only) returns the canonical destination for a held
    // omnibox query (Strategy A). Format "holo:omniresolved:<rid>:<dest-url-or-empty>". The dest may itself
    // contain colons (holo://…), so split on the FIRST colon after the rid only.
    if (req.rfind("holo:omniresolved:", 0) == 0) {
      if (origin.rfind("holo://os", 0) != 0) {
        callback->Failure(403, "holo-bridge: only the service context may resolve the omnibox");
        return true;
      }
      const std::string rest = req.substr(std::string("holo:omniresolved:").size());  // "<rid>:<dest>"
      const size_t colon = rest.find(':');
      if (colon == std::string::npos) { callback->Failure(400, "holo-bridge: malformed omni reply"); return true; }
      const int rid = std::atoi(rest.substr(0, colon).c_str());
      owner_->ResolveOmni(rid, rest.substr(colon + 1));   // empty tail ⇒ service handled it; ResolveOmni no-ops
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

    // A pinned extension's action, PROXIED (E2 — the κ-rail extension proxy). The native Chromium toolbar is
    // suppressed for holo:// (CEF_CTT_NONE), so the rail icon IS the extension's button. The shell sends the
    // extension's popup URL (chrome-extension://<id>/<popup>, taken from the manifest at pin time). We validate
    // it strictly — a valid [a-p]{32} id and a traversal-free relative path — then open it as a tab. Only the
    // Chrome runtime serves chrome-extension://, so the extension must be loaded (--load-extension); an
    // unloaded id just yields Chromium's own error page (no host risk). holo:// origin only (SEC tier).
    // P1.5 — the shell pushes its live bookmark κ-list here; the loopback broker serves it to the
    // κ-projector extension, which mirrors it onto Chrome's native bookmarks bar. holo:// origin only.
    if (req.rfind("holo:bar:push:", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) { callback->Failure(403, "holo-bridge: bar push only from a holo:// origin"); return true; }
      holo::SetBrokerBarJson(req.substr(14));
      callback->Success("{\"ok\":true}");
      return true;
    }

    if (req.rfind("holo:extaction:", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) { callback->Failure(403, "holo-bridge: extaction only from a holo:// origin"); return true; }
      const std::string url = req.substr(15);                       // chrome-extension://<id>/<relpath>
      const std::string pfx = "chrome-extension://";
      if (url.rfind(pfx, 0) != 0) { callback->Failure(400, "holo-bridge: extaction expects a chrome-extension url"); return true; }
      const std::string rest = url.substr(pfx.size());              // <id>/<relpath>
      const size_t slash = rest.find('/');
      const std::string id = (slash == std::string::npos) ? rest : rest.substr(0, slash);
      if (!IsExtId(id)) { callback->Failure(400, "holo-bridge: bad extension id"); return true; }
      const std::string path = (slash == std::string::npos) ? std::string("popup.html") : rest.substr(slash + 1);
      if (path.empty() || path.find("..") != std::string::npos || path.find('\\') != std::string::npos || path[0] == '/') {
        callback->Failure(400, "holo-bridge: bad extension path"); return true;
      }
      owner_->OpenPopupWindow("chrome-extension://" + id + "/" + path);
      callback->Success("{\"ok\":true}");
      return true;
    }

    // WebAuthn PASSKEY PROVIDER (P4): a web page called navigator.credentials.get(). Route the ceremony to
    // the trusted holo://os shell to sign with a vault passkey under TEE step-up. Allowed from ANY origin
    // (any site may request a passkey); the security is that signing happens in the shell, gated by step-up,
    // and BOUND to the origin we pass here — the frame's REAL committed URL, which the page cannot forge.
    if (req.rfind("holo:webauthn:", 0) == 0) {
      CefRefPtr<CefFrame> svc = owner_->ServiceFrame();
      if (!svc) { callback->Failure(503, "holo-webauthn: service unavailable"); return true; }
      const std::string payload = req.substr(14);  // JSON ceremony {type,rpId,challenge,allowCredentials}
      const int id = owner_->StashPending(callback);
      const std::string cmd = "webauthn:" + payload;
      const std::string js = "window.__holoSvc&&window.__holoSvc(" + std::to_string(id) + ",\"" +
                             json_escape(cmd) + "\",\"" + json_escape(origin) + "\");";
      svc->ExecuteJavaScript(js, svc->GetURL(), 0);
      return true;
    }

    // [holo-hello] NATIVE platform-authenticator (Windows Hello) ceremony for the OS login gate — the host
    // calls webauthn.dll directly, firing the REAL biometric dialog on the login page with NO iframe, NO
    // localhost, NO permission prompt. Only a holo:// origin (the greeter) may invoke it. The ceremony BLOCKS
    // (it shows the OS dialog), so it runs on a worker thread; the result returns over the same callback.
    if (req.rfind("holo:hello:", 0) == 0) {
      if (origin.rfind("holo://", 0) != 0) { callback->Failure(403, "holo-hello: only a holo:// origin may run the native ceremony"); return true; }
      const std::string payload = req.substr(11);   // JSON {op,name?,rpId?,credentialId?,challenge?}
      auto jget = [](const std::string& s, const char* k) -> std::string {
        std::string key = std::string("\"") + k + "\""; auto p = s.find(key); if (p == std::string::npos) return "";
        p = s.find(':', p + key.size()); if (p == std::string::npos) return ""; p++;
        while (p < s.size() && s[p] == ' ') p++;
        if (p < s.size() && s[p] == '"') { auto e = s.find('"', p + 1); return s.substr(p + 1, e - p - 1); }
        return "";
      };
      const std::string op = jget(payload, "op"), rpId = jget(payload, "rpId"), name = jget(payload, "name");
      const std::string credentialId = jget(payload, "credentialId"), challenge = jget(payload, "challenge");
      CefWindowHandle hwnd = (browser && browser->GetHost()) ? browser->GetHost()->GetWindowHandle() : 0;  // read on UI thread
      CefRefPtr<Callback> cb = callback;
      std::thread([cb, op, rpId, name, credentialId, challenge, hwnd]() {
        std::string out;
        if (op == "avail") out = holo::HelloAvailable() ? "{\"ok\":true,\"available\":true}" : "{\"ok\":true,\"available\":false}";
        else if (op == "enroll") out = holo::HelloEnroll((void*)hwnd, rpId, "Hologram", name);
        else if (op == "assert") out = holo::HelloAssert((void*)hwnd, rpId, credentialId, challenge);
        else out = "{\"ok\":false,\"error\":\"holo-hello: unknown op\"}";
        cb->Success(out);
      }).detach();
      return true;
    }

    // [holo-cred] the UNIFIED credential relay: web2 autofill (fill/save), TOTP, and (later) web3 all ride
    // ONE path — same shape as the passkey relay above. A web frame asks; we route to the trusted shell
    // with the frame's REAL committed origin (unforgeable), which dispatches over the vault + step-up.
    if (req.rfind("holo:cred:", 0) == 0) {
      CefRefPtr<CefFrame> svc = owner_->ServiceFrame();
      if (!svc) { callback->Failure(503, "holo-cred: service unavailable"); return true; }
      const std::string payload = req.substr(10);   // JSON {op,...}
      const int id = owner_->StashPending(callback);
      const std::string cmd = "cred:" + payload;
      const std::string js = "window.__holoSvc&&window.__holoSvc(" + std::to_string(id) + ",\"" +
                             json_escape(cmd) + "\",\"" + json_escape(origin) + "\");";
      svc->ExecuteJavaScript(js, svc->GetURL(), 0);
      return true;
    }

    // [holo-auth] the UNIVERSAL authorization relay: ANY app/web page authenticates through the ONE seam.
    // A frame asks (mode SIGN|RELEASE|PROVE, or kind oidc|siwe); we route to the trusted shell with the
    // frame's REAL committed origin (unforgeable context). The shell's window.HoloAuth runs the one biometric
    // and returns an L5-verifiable, PQ authorization. Same shape as the cred relay — one path for everything.
    if (req.rfind("holo:auth:", 0) == 0) {
      CefRefPtr<CefFrame> svc = owner_->ServiceFrame();
      if (!svc) { callback->Failure(503, "holo-auth: service unavailable"); return true; }
      const std::string payload = req.substr(10);   // JSON {mode|kind,spec,...}
      const int id = owner_->StashPending(callback);
      const std::string cmd = "auth:" + payload;
      const std::string js = "window.__holoSvc&&window.__holoSvc(" + std::to_string(id) + ",\"" +
                             json_escape(cmd) + "\",\"" + json_escape(origin) + "\");";
      svc->ExecuteJavaScript(js, svc->GetURL(), 0);
      return true;
    }

    // [unified identity] the trusted shell/greeter pushes the TEE-authenticated operator identity here right
    // after the biometric login gate. Format: holo:identity:<operatorKappa>|<pubHex> (empty payload = logout).
    // The host serves it as its W3C DID Document at /.well-known/did.json — the peer/mesh/agent DID IS the
    // operator. ONLY holo://os (the shell, which speaks for the authenticated user) may set it.
    if (req.rfind("holo:identity:", 0) == 0) {
      if (origin.rfind("holo://os", 0) != 0) {
        callback->Failure(403, "holo-identity: only the shell may set the operator identity");
        return true;
      }
      const std::string payload = req.substr(14);
      const size_t bar = payload.find('|');
      const std::string did = (bar == std::string::npos) ? payload : payload.substr(0, bar);
      const std::string pubhex = (bar == std::string::npos) ? std::string() : payload.substr(bar + 1);
      SetHostOperator(did, pubhex);
      callback->Success("{\"ok\":true}");
      return true;
    }

    // [unified identity → mesh] the shell asks for the local mesh node's public key, signs a delegation binding it
    // to the operator (at the TEE gate), and pushes it back — so the mesh peer proves it serves on behalf of the
    // user, trustlessly. The operator's sovereign key never leaves the shell; the host only relays + persists.
    if (req == "holo:meshpub") {
      if (origin.rfind("holo://os", 0) != 0) { callback->Failure(403, "holo-meshpub: shell only"); return true; }
      callback->Success("{\"meshPub\":\"" + HostMeshPub() + "\"}");
      return true;
    }
    if (req.rfind("holo:delegation:", 0) == 0) {
      if (origin.rfind("holo://os", 0) != 0) { callback->Failure(403, "holo-delegation: shell only"); return true; }
      SetHostDelegation(req.substr(16));  // <op_did>\t<op_pub>\t<mesh_pub>\t<sig>; the node picks it up + proves
      callback->Success("{\"ok\":true}");
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

// ── Permission tier (the device-access twin of the origin tier in OnQuery). The native boot lands
// on holo://os/login, and the operator authenticates at the native Windows Hello gate BEFORE the OS
// can do anything privileged. The sealed holo:// surface is trusted by construction — the same tier
// that lets it reach the Hologram service. So a permission request from a holo:// origin is granted
// silently: no "holo://os wants to — Access other apps and services on this device" prompt on boot,
// and the access a new user login needs (local-network κ peer-delivery/discovery, window management,
// notifications) is auto-granted. A NON-holo (web) origin returns false → default Chrome handling:
// the prompt still appears, so the web stays gated. Runs on the UI thread (per CefPermissionHandler).
bool SimpleHandler::OnShowPermissionPrompt(
    CefRefPtr<CefBrowser> browser,
    uint64_t prompt_id,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefPermissionPromptCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  const std::string origin = requesting_origin.ToString();
  if (origin.rfind("holo://", 0) == 0) {
    callback->Continue(CEF_PERMISSION_RESULT_ACCEPT);  // trusted OS surface → grant, no prompt
    return true;
  }
  return false;  // web origin → default Chrome handling (prompt shown; boundary holds)
}

// Media (getUserMedia) is a separate CEF callback from the generic prompt above; mirror the same
// origin tier so a holo:// OS app (calls, capture) is granted exactly what it asked for, while web
// origins fall through to default handling. |allowed| must equal |requested| for getUserMedia.
bool SimpleHandler::OnRequestMediaAccessPermission(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefMediaAccessCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  const std::string origin = requesting_origin.ToString();
  if (origin.rfind("holo://", 0) == 0) {
    callback->Continue(requested_permissions);  // trusted OS surface → grant exactly what was asked
    return true;
  }
  return false;  // web origin → default Chrome handling
}

void SimpleHandler::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  // The first browser is the OS shell window; its main frame hosts the Hologram service context.
  if (!main_browser_) main_browser_ = browser;
  browser_list_.push_back(browser);
  LogLife("browser created (OnAfterCreated) · count=" + std::to_string(browser_list_.size()));
  // De-brand the native window + taskbar icon: the Chrome runtime stamps the Chromium product logo onto
  // the window (WM_SETICON) and taskbar (relaunch-icon). Overwrite both with the Hologram H. Re-applied on
  // a short delay too, in case Chrome re-sets the icon after the window is fully shown.
  if (browser->GetHost()) {
    void* wh = reinterpret_cast<void*>(browser->GetHost()->GetWindowHandle());
    if (wh) {
      holo::ApplyHologramWindowIcon(wh);
      CefPostDelayedTask(TID_UI, base::BindOnce(&holo::ApplyHologramWindowIcon, wh), 1500);
    }
  }
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

// ── Lifecycle trail / strand (process L5) ──────────────────────────────────────────────────────────────
namespace {
// Percent-encode the WHOLE diagnostic document once → a valid data: URL (encodes <,>,#,space,quotes,UTF-8).
// With the data: MIME declaring charset=utf-8, multibyte punctuation (— · → ') decodes correctly (no mojibake).
std::string UrlEsc(const std::string& s) {
  static const char* hexd = "0123456789ABCDEF";
  std::string o;
  for (unsigned char c : s) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '/' || c == ':')
      o.push_back(static_cast<char>(c));
    else { o.push_back('%'); o.push_back(hexd[c >> 4]); o.push_back(hexd[c & 0xf]); }
  }
  return o;
}
// HTML-escape dynamic TEXT (reason, trail lines, the retry URL) so it can't break the document structure.
std::string HtmlEsc(const std::string& s) {
  std::string o;
  o.reserve(s.size());
  for (char c : s) {
    switch (c) {
      case '&': o += "&amp;"; break;
      case '<': o += "&lt;"; break;
      case '>': o += "&gt;"; break;
      case '"': o += "&quot;"; break;
      case '\'': o += "&#39;"; break;
      default: o += c;
    }
  }
  return o;
}
}  // namespace

void SimpleHandler::LogLife(const std::string& event) {
  std::fprintf(stderr, "HOLO-LIFE: %s\n", event.c_str());
  std::fflush(stderr);
  if (life_trail_.size() >= 64) life_trail_.erase(life_trail_.begin());
  life_trail_.push_back(event);
  AppendStrand(event);
}

void SimpleHandler::AppendStrand(const std::string& event) {
  // Hash-linked append-only: each line commits to the previous via sha256(prev | seq | event), so a dropped,
  // reordered, or edited entry no longer re-derives (the holo-strand tamper-evidence model; an operator
  // signature over the head κ is the documented follow-up). Append across launches = the full boot history.
  if (strand_path_.empty()) {
    strand_path_ = "holo-lifecycle-strand.jsonl";
    if (const char* p = std::getenv("HOLO_LIFECYCLE_STRAND")) { if (p[0]) strand_path_ = p; }
  }
  const std::string h =
      holo_sha256::Hex(strand_head_ + "|" + std::to_string(strand_seq_) + "|" + event);
  const std::string line = "{\"seq\":" + std::to_string(strand_seq_) +
                           ",\"ts\":" + std::to_string(static_cast<long long>(std::time(nullptr))) +
                           ",\"event\":\"" + json_escape(event) + "\",\"prev\":\"" + strand_head_ +
                           "\",\"hash\":\"" + h + "\"}\n";
  strand_head_ = h;
  strand_seq_++;
  std::ofstream f(strand_path_, std::ios::app | std::ios::binary);
  if (f) f << line;
}

// Mirror the live lifecycle verdict into the shell so the CDP boot-proof reads ground truth, not a guess.
void SimpleHandler::PushLifecycleToShell() {
  CefRefPtr<CefFrame> svc = ServiceFrame();
  if (!svc) return;
  std::string ev = "[";
  for (size_t i = 0; i < life_trail_.size(); ++i) {
    if (i) ev += ",";
    ev += "\"" + json_escape(life_trail_[i]) + "\"";
  }
  ev += "]";
  const std::string js =
      "window.__holoLifecycle={healthy:" + std::string(survived_live_ ? "true" : "false") +
      ",strategy:\"" + std::string(prefer_views_ ? "views" : "native") +
      "\",paintMs:" + std::to_string(paint_ms_) +
      ",strandHead:\"" + strand_head_ + "\",heals:" + std::to_string(heal_count_) +
      ",events:" + ev + "};";
  svc->ExecuteJavaScript(js, svc->GetURL(), 0);
}

// The fail-loud diagnostic page (a data: URL — not re-judged, no external assets): the reason + a one-click
// retry + the recent lifecycle trail. Used both as a new window (boot collapse) and in-place (content fail).
std::string SimpleHandler::DiagnosticDataUrl(const std::string& reason) {
  last_reason_ = reason;
  // Recent steps (demoted into the collapsed details — engineers read it, newcomers ignore it).
  std::string rows;
  const size_t start = life_trail_.size() > 14 ? life_trail_.size() - 14 : 0;
  for (size_t i = start; i < life_trail_.size(); ++i)
    rows += "<li>" + HtmlEsc(life_trail_[i]) + "</li>";

  // Build the FULL document as plain HTML (friendly copy first, technical detail collapsed), then encode the
  // whole thing once. Self-contained: no external CSS/JS/fonts/images — it must render when nothing else works.
  const std::string doc =
      "<!doctype html><html><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
      "<title>Hologram</title><style>"
      ":root{color-scheme:dark}html,body{height:100%;margin:0}"
      "body{background:#0b0b12;color:#e8e8f0;"
      "font:18px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;"
      "display:flex;align-items:center;justify-content:center;padding:6vh 7vw;box-sizing:border-box}"
      ".card{max-width:640px;width:100%}"
      ".mark{font-size:34px;line-height:1;color:#7cc4ff;margin-bottom:22px}"
      "h1{font-size:30px;font-weight:600;letter-spacing:-.01em;margin:0 0 16px}"
      "p.msg{font-size:19px;color:#d7d8e3;margin:0 0 30px}"
      "a.btn{display:inline-block;padding:14px 30px;border-radius:11px;background:#7cc4ff;color:#0b0b12;"
      "font-size:17px;font-weight:600;text-decoration:none}"
      "a.btn:hover{background:#9bd2ff}a.btn:focus-visible{outline:3px solid #bfe0ff;outline-offset:3px}"
      "details{margin-top:46px;border-top:1px solid #20212c;padding-top:18px}"
      "summary{cursor:pointer;font-size:15px;font-weight:600;color:#c7c9d4}"
      "details p{font-size:15px;color:#aeb0bd;margin:16px 0 8px}"
      ".cmd{display:block;font-family:ui-monospace,Consolas,monospace;font-size:14px;background:#15161f;"
      "border:1px solid #20212c;border-radius:8px;padding:12px 14px;color:#e8e8f0;overflow:auto}"
      "ol{margin:14px 0 0;padding-left:24px;color:#9a9cab;font-size:14px;line-height:1.8}"
      "</style></head><body><div class=\"card\">"
      // Canonical enclosed-H mark + wordmark, inlined (this page must render when nothing else can).
      "<div class=\"mark\"><svg width=\"58\" height=\"58\" viewBox=\"0 0 128 128\" fill=\"none\" stroke=\"#7cc4ff\" stroke-width=\"8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M64 16 L106 40 V88 L64 112 L22 88 V40 Z\"></path><path d=\"M49 44 V84 M79 44 V84 M49 64 H79\"></path></svg>"
      "<div style=\"font:600 14px system-ui;letter-spacing:.16em;text-transform:uppercase;color:#7cc4ff;margin-top:12px\">Hologram</div></div>"
      "<h1>Hologram needs a quick refresh</h1>"
      "<p class=\"msg\">" + HtmlEsc(reason) + "</p>"
      "<a class=\"btn\" href=\"" + HtmlEsc(boot_url_) + "\">Try again</a>"
      "<details><summary>Technical details</summary>"
      "<p>If <b>Try again</b> doesn\xE2\x80\x99t help, the app\xE2\x80\x99s sealed files are out of date. "
      "Reseal them, then reopen Hologram:</p>"
      "<code class=\"cmd\">cd holo-apps/apps/tauri &amp;&amp; node _reseal-dist.mjs</code>"
      "<p>Recent steps:</p><ol>" + rows + "</ol>"
      "</details></div></body></html>";
  return "data:text/html;charset=utf-8," + UrlEsc(doc);
}

// Fail-LOUD: when every boot strategy has collapsed, open a guaranteed-simple native window showing WHY
// (the last lifecycle events) + a one-click retry — never an empty exit or a windowless idle process.
void SimpleHandler::OpenDiagnosticWindow(const std::string& reason) {
  const std::string html = DiagnosticDataUrl(reason);
  CefBrowserSettings settings;
  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Hologram");
  window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
  CefBrowserHost::CreateBrowser(window_info, this, html, settings, nullptr, nullptr);
  survived_live_ = true;  // the diagnostic IS a live window; its later user-close is a legitimate shutdown
}

// Content-failure guard (see header): the canonical login itself failed to load (commonly a stale seal →
// the κ verifier refuses login.html → ERR_INVALID_RESPONSE). Replace the dead Chrome error in-place with the
// honest diagnostic so boot always lands on the login OR a clear, recoverable surface.
void SimpleHandler::OnLoadError(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                ErrorCode errorCode,
                                const CefString& errorText,
                                const CefString& failedUrl) {
  CEF_REQUIRE_UI_THREAD();
  if (!frame || !frame->IsMain()) return;          // only the top-level document, not sub-resources/frames
  if (errorCode == ERR_ABORTED) return;            // a superseded/cancelled navigation is not a failure
  const std::string url = failedUrl.ToString();
  if (url.rfind("data:", 0) == 0) return;          // never recurse on the diagnostic page itself
  if (url.rfind("holo://os", 0) != 0) return;      // only guard the canonical OS entry (login/shell), not web

  // Transient-error retry for EVERY canonical OS entry (login.html, shell.html, the projector lens, …). The κ
  // scheme/HotStore can still be opening when the first request lands during boot, so the verifier returns
  // ERR_INVALID_RESPONSE on a frame that is in fact perfectly sealed — a one-shot race, not a stale seal. The
  // store becomes ready within a couple of seconds (longer under a cold-restart storm: measured up to ~2.7 s,
  // ~18 reloads), so we reload until it is. Bound by WALL-CLOCK grace, NOT a retry count — a reloaded main
  // frame gets a fresh identifier each time, so a count-keyed cap silently never binds (a genuinely stale seal
  // would then retry forever and never reach the diagnostic). Keyed by url with the first-failure timestamp:
  // within the grace window we keep reloading (race resolves silently); past it we fall to the honest
  // diagnostic (a real stale seal escapes). The browser stays alive across reloads, so the 2500 ms boot-health
  // latch still sees a live window and does not false-heal. This is what makes boot reliable — it was ~1-in-4
  // boots dead-ending on the diagnostic purely from the store-open race (now 0/20, all races recovered).
  {
    static std::map<std::string, std::chrono::steady_clock::time_point> s_first;  // url → first failure
    static std::map<std::string, int> s_count;
    constexpr int kGraceMs = 12000;  // keep retrying the κ-store boot race up to this long, then give up loud
    constexpr int kStepMs = 200;
    const auto now = std::chrono::steady_clock::now();
    auto it = s_first.find(url);
    if (it == s_first.end()) it = s_first.emplace(url, now).first;
    const int elapsed =
        static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(now - it->second).count());
    if (elapsed < kGraceMs) {
      const int n = ++s_count[url];
      LogLife("canonical entry transient load error (" + errorText.ToString() + ") on " + url + " — retry " +
              std::to_string(n) + " (" + std::to_string(elapsed) + "/" + std::to_string(kGraceMs) + " ms)");
      CefRefPtr<CefFrame> f = frame;
      CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<CefFrame> fr, std::string u) { if (fr) fr->LoadURL(u); }, f, url), kStepMs);
      return;
    }
    s_first.erase(url);  // grace exhausted → genuine failure → diagnostic; reset so a later Try-again is fresh
    s_count.erase(url);
  }

  const std::string reason =
      "Some of Hologram's files changed since they were last checked, so it paused to keep you safe. "
      "Click Try again below. This usually fixes it.";  // plain English; the error code lives in the trail
  LogLife("CONTENT FAIL on canonical entry: " + url + " (" + errorText.ToString() +
          ") then diagnostic in place");
  frame->LoadURL(DiagnosticDataUrl(reason));       // replace the raw browser error with the honest surface
}

// ── Boot-health supervisor ───────────────────────────────────────────────────────────────────────────
void SimpleHandler::StartBoot(const std::string& boot_url) {
  boot_url_ = boot_url;
  boot_start_ = std::chrono::steady_clock::now();  // start the instant-boot clock (→ paintMs at login load-end)
  // Strategy choice. The PROVEN native-hosted Chrome window is the default — it always boots and is the
  // safety net. The shell-is-chrome Views window (one toolbar-less Chrome BrowserView in a CefWindow) is the
  // intended single-chrome model, but Chrome-style top-level Views windows WEDGE the UI thread inside
  // CreateTopLevelWindow in this CEF dist (observed: the call never returns — see the HOLO-LIFE trail), so it
  // is opt-in via HOLO_WINDOW_MODE=views until the dist supports it. Either way the supervisor guards the
  // boot; the in-page holospace tab model gives one-window-with-tabs regardless of which window hosts it.
  bool prefer_views = false;
  if (const char* m = std::getenv("HOLO_WINDOW_MODE")) prefer_views = (std::string(m) == "views");
  OpenBootWindow(prefer_views);
}

void SimpleHandler::OpenBootWindow(bool prefer_views) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::OpenBootWindow, this, prefer_views));
    return;
  }
  prefer_views_ = prefer_views;
  survived_live_ = false;
  // Arm the health check FIRST, so it runs even if window creation wedges or silently no-ops (observed: a
  // Chrome-style CreateTopLevelWindow can produce NO browser at all in this CEF dist — OnAfterCreated never
  // fires). The latch is the actual verdict, not a rubber stamp: at T_live it checks for a live browser.
  CefPostDelayedTask(TID_UI, base::BindOnce(&SimpleHandler::OnLiveLatch, this), 2500);
  CefBrowserSettings settings;
  settings.background_color = CefColorSetARGB(255, 0x0B, 0x0E, 0x14);  // brand-dark base — no white flash pre-paint
  if (prefer_views) {
    // Shell-is-chrome: ONE toolbar-less Chrome BrowserView (CEF_CTT_NONE for holo://) in a CefWindow. The
    // shell draws all chrome and opens apps as in-page holospace tabs → one window, one chrome, real tabs.
    LogLife("open shell window: VIEWS (shell is chrome, toolbar less)");
    LogLife("views: creating browser view");
    CefRefPtr<CefBrowserView> view = CefBrowserView::CreateBrowserView(
        this, boot_url_, settings, nullptr, nullptr, new HoloBrowserViewDelegate(/*is_holo=*/true));
    LogLife(view ? "views: browser view created" : "views: browser view NULL");
    LogLife("views: creating top level window");
    CefWindow::CreateTopLevelWindow(new HoloShellWindowDelegate(view));
    LogLife("views: top level window create returned");
  } else {
    // Proven fallback: the native-hosted Chrome window (the path that has always booted). Used to self-heal
    // a Views no-show/collapse so the user gets a live OS instead of a vanished or windowless process.
    LogLife("open shell window: NATIVE HOSTED (proven fallback)");
    CefWindowInfo window_info;
    window_info.SetAsPopup(nullptr, "Hologram");
    window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
    CefBrowserHost::CreateBrowser(window_info, this, boot_url_, settings, nullptr, nullptr);
    LogLife("native hosted browser requested");
  }
}

void SimpleHandler::OnLiveLatch() {
  if (survived_live_) return;
  if (!browser_list_.empty()) {            // a live browser exists at T_live → boot is healthy
    survived_live_ = true;
    LogLife("boot health latch: HEALTHY (window alive at T_live)");
    PushLifecycleToShell();
    return;
  }
  // No live browser at T_live → the window never came up (silent no-show) or already collapsed. Self-heal
  // into the proven native-hosted strategy. Bounded, so a genuinely broken host eventually fails loud.
  constexpr int kMaxHeal = 2;
  if (heal_count_ < kMaxHeal) {
    heal_count_++;
    LogLife(prefer_views_ ? "boot health latch: NO WINDOW (views failed), healing to native hosted"
                          : "boot health latch: NO WINDOW (native failed), retrying");
    OpenBootWindow(/*prefer_views=*/false);
    return;
  }
  LogLife("boot health latch: no window on any strategy, opening diagnostic surface (loop HELD)");
  OpenDiagnosticWindow("Hologram had trouble opening its window. Click Try again to restart it.");
}

void SimpleHandler::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  router_->OnBeforeClose(browser);
  if (main_browser_ && main_browser_->IsSame(browser)) main_browser_ = nullptr;  // service host gone
  for (auto it = browser_list_.begin(); it != browser_list_.end(); ++it) {
    if ((*it)->IsSame(browser)) { browser_list_.erase(it); break; }
  }
  if (!browser_list_.empty()) return;

  // Boot-health gate (process L5): the loop may quit ONLY after a healthy boot. If the window collapsed
  // before the liveness latch (created-then-immediately-closed), do NOT vanish — self-heal into the proven
  // native-hosted strategy and HOLD the loop. Bounded, so a genuinely broken host still exits loud.
  if (survived_live_) {
    LogLife("last window closed after healthy boot, shutting down");
    CefQuitMessageLoop();
    return;
  }
  constexpr int kMaxHeal = 2;
  if (heal_count_ < kMaxHeal) {
    heal_count_++;
    LogLife(prefer_views_ ? "PREMATURE COLLAPSE (views), healing to native hosted; loop HELD"
                          : "PREMATURE COLLAPSE (native), reopening; loop HELD");
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::OpenBootWindow, this, /*prefer_views=*/false));
    return;  // hold the loop; do NOT quit
  }
  LogLife("collapse persisted on all strategies, opening diagnostic surface (loop HELD)");
  CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::OpenDiagnosticWindow, this,
                                     std::string("Hologram had trouble opening its window. Click Try again "
                                                 "to restart it.")));
}

// ── DevTools at F12 ────────────────────────────────────────────────────────────────────────────
// The native browser embeds the COMPLETE Chromium inspector. We open it; we do not reimplement it.
// This is the literal "F12, just like Chrome": the inspector reflects the live renderer — the whole
// tab, every element, every byte — by construction. The front-end's own asset loads route through
// the holo:// κ scheme (sealed, verified) so the DevTools surface is itself substrate-native.
//
// F12 opens the standard Chromium DevTools window (the original, detached inspector) against the live
// renderer — the complete, feature-complete real inspector, reflecting the entire tab. (We tried an
// in-page right-slide dock; reverted by request — this is the plain native window.)
void SimpleHandler::ShowHoloDevTools(CefRefPtr<CefBrowser> browser, const CefPoint& inspect_at) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser) return;
  CefWindowInfo window_info;
#if defined(OS_WIN)
  window_info.SetAsPopup(nullptr, "DevTools");
#endif
  CefBrowserSettings settings;
  browser->GetHost()->ShowDevTools(window_info, this, settings, inspect_at);
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

  // Toggle the standard Chromium DevTools window against the live renderer (the original detached
  // inspector). Consume the chord so we don't also trigger Chrome's own accelerator (double-open).
  CefRefPtr<CefBrowserHost> host = browser->GetHost();
  if (host->HasDevTools()) host->CloseDevTools();
  else ShowHoloDevTools(browser, CefPoint());
  return true;  // consume
}

namespace {
// Messenger platforms are FIRST-CLASS destinations of the unified inbox — the user is signing into
// their OWN accounts (the whole point of Holo Messenger), not disclosing PII to an arbitrary site. So
// they are exempt from the conscience gate's data-minimisation red-line (which guards against LEAKING
// the operator's PII outward, a different act). Host-suffix match, mirroring holo-bridge-adapters.
// The operator's OWN machine (localhost / 127.0.0.1) is never an external destination -- it hosts the
// step-up broker (a valid WebAuthn origin) and the dev preview. The conscience gate guards LEAKING PII
// OUTWARD; loopback is not outward, so it is exempt (and must be, or the broker cannot load top-level).
bool IsLoopback(const std::string& url) {
  const std::string h = HostOf(url);
  return h == "localhost" || h == "127.0.0.1" || h == "[::1]";
}
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
    // Top-level home takes NO ?embed: home.html self-redirects to the full shell.html only when top-level and
    // unembedded. ?embed means "hosted inside the shell", which suppresses that redirect — so a standalone new
    // tab carrying ?embed renders black (embedded mode with no parent shell). Drop it.
    frame->LoadURL("holo://os/home.html");
    return true;
  }
  // ── Unify-the-chrome (Strategy A): the native omnibox's free-text/search path is wired to the holo search
  // template holo://os/omni?q=<raw> (set as the default search provider in HoloDeferredHostInit). Hold that
  // navigation and resolve the raw query through the SAME resolver the shell uses (holo-omni-resolve in the
  // service frame) → canonical destination → re-navigate. Direct holo:// and http(s):// entries are NOT
  // touched here; they fall through to the κ-scheme and the governance/projection path as before.
  {
    const std::string kOmni = "holo://os/omni?q=";
    if (url.rfind(kOmni, 0) == 0) {
      const std::string raw = CefURIDecode(url.substr(kOmni.size()), true,
                                           static_cast<cef_uri_unescape_rule_t>(UU_NORMAL | UU_SPACES |
                                               UU_URL_SPECIAL_CHARS_EXCEPT_PATH_SEPARATORS)).ToString();
      CefRefPtr<CefFrame> svc = ServiceFrame();
      if (!svc || raw.empty()) { frame->LoadURL("holo://os/find.html?q=" + url.substr(kOmni.size())); return true; }  // fail-soft: no service ⇒ Find
      const int rid = next_omni_id_++;
      omni_pending_[rid] = { browser, raw };
      svc->ExecuteJavaScript("window.__holoOmniResolve&&window.__holoOmniResolve(" + std::to_string(rid) + ",\"" +
                             json_escape(raw) + "\");", svc->GetURL(), 0);
      return true;  // hold; ResolveOmni re-navigates to the destination the resolver returns
    }
  }
  // ── Holospace tab (Phase 2.0): a holospace κ URL boots the STANDALONE host document, so a real CEF tab
  // renders one tiled holospace with no shell chrome. Rewrite holo://space/<ref> → the host doc carrying the
  // ref (the host's boot() loads + L5-verifies the space, then tiles its members). A space κ (holo://space/
  // <64hex>) resolves via the κ-store; a named template id is a later refinement (name→κ).
  if (url.rfind("holo://space/", 0) == 0) {
    frame->LoadURL("holo://os/holospace-host.html?ref=" +
                   CefURIEncode(url, false).ToString());
    return true;
  }
  if (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0) return false;
  // ── Hologram-native YouTube: route youtube.com / youtu.be to the native surface (the raw polymer feed does
  // not render on this engine — Phase 0). The app reads ?src=<original URL> and routes home/search/channel/
  // watch, projecting every video through Holo Video. Our app's own data (holo://os/sc/*) and thumbnails
  // (i.ytimg.com) are not youtube.com top-level navigations, so this never loops.
  if (IsYouTubeSite(url)) {
    frame->LoadURL("holo://os/apps/youtube/index.html?src=" + CefURIEncode(url, false).ToString());
    return true;
  }
  if (IsMessengerHost(url)) return false;  // a sanctioned messenger destination — never gated by the PII red-line
  if (IsLoopback(url)) return false;       // operator's own machine (broker / dev preview) -- not outward
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

// ResolveOmni — the service returned a canonical destination for a held omnibox query. Navigate there. An
// empty destination means the service handled it itself (a live web3/holo-name shape it opened via HoloOpen,
// or a deliberate refusal) — do nothing. A holo://os/omni?q= result would loop, so guard against it.
void SimpleHandler::ResolveOmni(int omni_id, const std::string& dest_url) {
  CEF_REQUIRE_UI_THREAD();
  auto it = omni_pending_.find(omni_id);
  if (it == omni_pending_.end()) return;
  CefRefPtr<CefBrowser> browser = it->second.browser;
  omni_pending_.erase(it);
  if (!browser || dest_url.empty()) return;
  if (dest_url.rfind("holo://os/omni?q=", 0) == 0) return;  // never re-enter the search route
  browser->GetMainFrame()->LoadURL(dest_url);
}

// ── ISP name-filter fallback (HOLO_BLOCK_FALLBACK) ──────────────────────────────────────────────────────────
// A parental-controls / content filter reads NAMES: it bounces the wanted URL to its block page. The substrate
// answers by CONTENT — a peer's κ (content-addressed, L5-verified) instead of the block page. The trigger is the
// only new part; delivery is the EXISTING kappa-shared/mesh path. Opt-in + reversible: off ⇒ host unchanged.
namespace {
std::mutex g_block_mu;
std::map<int, std::string> g_block_capture;  // browserId → the wanted URL a WebSafe redirect tried to hide

bool HoloBlockFallbackEnabled() {
  static int e = -1;
  if (e < 0) { const char* v = std::getenv("HOLO_BLOCK_FALLBACK"); e = (v && *v && std::string(v) != "0") ? 1 : 0; }
  return e == 1;
}

// The known ISP filter LANDING hosts (substring match on the URL — exact host parsing is unnecessary here,
// these strings appear only in a filter's block-page URL). Mirrors holo-block-detect.mjs ISP_BLOCK_HOSTS.
bool HoloIsIspBlockUrl(const std::string& url) {
  static const char* kHosts[] = {
      "://websafe.virginmedia.com", "://contentblocked.virginmedia.com", "://blackhole.virginmedia.com",
      "://homesafe.talktalk.co.uk", "://barred.sky.com", "://blocked.bt.com",
  };
  for (const char* h : kHosts) if (url.find(h) != std::string::npos) return true;
  return false;
}
}  // namespace

// DelegateBlockResolve — a filter bounced `url` and no peer holds its κ. Ask the service's κ-roots/DoH resolver
// (window.__holoBlockResolve, holo-block-fallback.mjs) to name it without a plaintext DNS query. The service
// answers over the cefQuery bridge ("holo:blockresolved:<id>:<κ>") → ResolveBlock. UI thread only (no service ⇒
// leave the block page; the peer-has-κ path already missed). Mirrors the governance hold→async→re-nav pattern.
void SimpleHandler::DelegateBlockResolve(CefRefPtr<CefBrowser> browser, const std::string& url) {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<CefFrame> svc = ServiceFrame();
  if (!svc || !browser) return;
  const int id = next_block_id_++;
  block_pending_[id] = { browser, url };
  svc->ExecuteJavaScript("window.__holoBlockResolve&&window.__holoBlockResolve(" + std::to_string(id) + ",\"" +
                         json_escape(url) + "\");", svc->GetURL(), 0);
}

// ResolveBlock — the service returned the wanted URL's content κ (or empty = unresolved → leave the block page).
// Note url→κ into the shared substrate so GetResourceHandler's serve path finds it, then re-navigate to the
// marked URL; the serve mesh-pulls the κ (L5-verified) and returns it as kappa-block-bypass.
void SimpleHandler::ResolveBlock(int block_id, const std::string& kappa) {
  CEF_REQUIRE_UI_THREAD();
  auto it = block_pending_.find(block_id);
  if (it == block_pending_.end()) return;
  CefRefPtr<CefBrowser> browser = it->second.browser;
  const std::string url = it->second.url;
  block_pending_.erase(it);
  if (!browser || kappa.empty()) return;                               // unresolved → honest: leave the block page
  if (KShared* sc = SharedCache()) kr_shared_note(sc, url.c_str(), kappa.c_str());  // url→κ for the serve path
  { std::lock_guard<std::mutex> lk(g_block_mu); g_block_capture[browser->GetIdentifier()] = url; }
  const std::string sentinel = url + (url.find('?') == std::string::npos ? "?" : "&") + "__holobypass=1";
  browser->GetMainFrame()->LoadURL(sentinel);
  LogLife("block-fallback: nameless-resolved " + url + " → κ; serving via " + sentinel);
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

// OnResourceRedirect — catch the WebSafe bounce. Only rewrite back to the wanted URL when a peer ACTUALLY holds
// its κ and the bytes are reachable (local shared dir or fetched via the mesh) — so a no-peer case leaves the
// block page and CANNOT redirect-loop. The capture is consumed once in GetResourceHandler.
void SimpleHandler::OnResourceRedirect(CefRefPtr<CefBrowser> browser,
                                       CefRefPtr<CefFrame> frame,
                                       CefRefPtr<CefRequest> request,
                                       CefRefPtr<CefResponse> /*response*/,
                                       CefString& new_url) {
  if (!HoloBlockFallbackEnabled() || !browser) return;
  const std::string old_url = request->GetURL().ToString();
  const std::string nu = new_url.ToString();
  if (!HoloIsIspBlockUrl(nu) || HoloIsIspBlockUrl(old_url)) return;   // not a filter bounce (or already on it)
  // FAST PATH — does a peer already hold THIS exact URL's κ (the gossip manifest)? If so, re-nav to the marked
  // URL and serve it; no name-resolve needed. (kr_shared_get re-derives + L5-verifies inside.)
  bool peer_has = false;
  if (KShared* sc = SharedCache()) {
    if (char* k = kr_shared_kappa_for(sc, old_url.c_str())) {
      uint8_t* sp = nullptr; size_t sl = 0; char* sm = nullptr;
      peer_has = (kr_shared_get(sc, k, &sp, &sl, &sm) == 1) ||
                 (kr_mesh_get(k) == 1 && kr_shared_get(sc, k, &sp, &sl, &sm) == 1);
      if (peer_has) { kr_free(sp, sl); if (sm) kr_cache_free_mime(sm); }  // only confirming reachability
      kr_cache_free_mime(k);
    }
  }
  if (peer_has) {
    // Drive a FRESH navigation to the WANTED url + a __holobypass marker (the codebase's proven re-nav pattern —
    // frame->LoadURL, as YouTube/new-tab use — not a new_url mutation, which this CEF aborts). The marker keeps it
    // off the redirect-loop and governance paths; same origin as the wanted url ⇒ it inherits the cleared nav.
    const std::string sentinel = old_url + (old_url.find('?') == std::string::npos ? "?" : "&") + "__holobypass=1";
    { std::lock_guard<std::mutex> lk(g_block_mu); g_block_capture[browser->GetIdentifier()] = old_url; }
    CefRefPtr<CefFrame> f = frame;
    CefPostTask(TID_UI, base::BindOnce([](CefRefPtr<CefFrame> fr, std::string u) { if (fr) fr->LoadURL(u); }, f, sentinel));
    LogLife("block-fallback (peer-has-κ): serving " + old_url + " via " + sentinel);
    return;
  }
  // NAMELESS RESOLVE — no peer holds this URL. Delegate to the service's κ-roots/DoH resolver (off the ISP
  // DNS). ResolveBlock takes the κ it returns, notes url→κ, and re-navigates to the marked URL to serve it.
  CefRefPtr<CefBrowser> b = browser;
  CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::DelegateBlockResolve, this, b, old_url));
  LogLife("block-fallback: no peer holds " + old_url + " → delegating nameless resolve");
}

// Serve an inert surrogate (HTTP 200) for ad/detector requests so the page can't tell anything was blocked:
// gpt→no-op window.googletag, analytics→window.ga/gtag, other ad scripts→empty no-op, ad images→1×1 GIF,
// everything else→empty 200. A success, never a cancel. (the κ substrate at holo:// is never touched.)
CefRefPtr<CefResourceHandler> SimpleHandler::GetResourceHandler(CefRefPtr<CefBrowser> browser,
                                                               CefRefPtr<CefFrame> /*frame*/,
                                                               CefRefPtr<CefRequest> request) {
  const std::string url = request->GetURL().ToString();
  // Native /sc/* media streaming for the dock apps (Holo Video / Holo Vinyl). Routed here — not via the
  // holo:// scheme factory — so 206/range works for <video> (the factory path breaks follow-up range reads).
  if (CefRefPtr<CefResourceHandler> sc = HoloCreateScHandler(url)) return sc;
  if (url.rfind("holo://", 0) == 0) return nullptr;
  // ISP block fallback: OnResourceRedirect rewrote a filter bounce to the WANTED url + a __holobypass marker.
  // This request IS that marked load → serve the wanted url's content-addressed bytes (X-Holo-Source:
  // kappa-block-bypass) instead of the block page. One-shot: clear the capture so a later genuine load is not
  // shadowed. The wanted bytes are addressed by the ORIGINAL (captured) url, not the marked url.
  if (HoloBlockFallbackEnabled() && browser && url.find("__holobypass=1") != std::string::npos) {
    std::string original;
    { std::lock_guard<std::mutex> lk(g_block_mu);
      auto it = g_block_capture.find(browser->GetIdentifier());
      if (it != g_block_capture.end()) { original = it->second; g_block_capture.erase(it); } }
    if (!original.empty()) {
      if (KShared* sc = SharedCache()) {
        if (char* k = kr_shared_kappa_for(sc, original.c_str())) {
          uint8_t* sp = nullptr; size_t sl = 0; char* sm = nullptr;
          bool got = (kr_shared_get(sc, k, &sp, &sl, &sm) == 1) ||
                     (kr_mesh_get(k) == 1 && kr_shared_get(sc, k, &sp, &sl, &sm) == 1);
          kr_cache_free_mime(k);
          if (got) return new HoloKappaCacheHandler(sp, sl, sm, "kappa-block-bypass", HoloMimeFromUrl(original));
        }
      }
      // peer's bytes vanished between the redirect check and now → fall through to the network (honest miss).
    }
  }
  // Open-web κ-cache: serve a HIT from the substrate, ZERO network — every cacheable subresource, any site,
  // any tab. (Populated by the tee filter on the cold miss; see GetResourceResponseFilter.)
  if (IsCacheableWeb(request)) {
    uint8_t* p = nullptr; size_t len = 0; char* mime = nullptr;
    if (kr_cache_get(WebCache(), url.c_str(), &p, &len, &mime) == 1)
      return new HoloKappaCacheHandler(p, len, mime);  // LOCAL hit
    // Local miss → the PLANETARY layer: if a peer gossiped this url's κ, fetch the bytes BY κ from the shared
    // substrate (re-derived + L5-verified inside kr_shared_get; a hostile blob ⇒ miss ⇒ falls through to the
    // network). This is the web's FIRST load for THIS machine served from a blob another node already minted.
    if (KShared* sc = SharedCache()) {
      if (char* k = kr_shared_kappa_for(sc, url.c_str())) {
        uint8_t* sp = nullptr; size_t sl = 0; char* sm = nullptr;
        if (kr_shared_get(sc, k, &sp, &sl, &sm) == 1) {
          kr_cache_free_mime(k);
          return new HoloKappaCacheHandler(sp, sl, sm, "kappa-shared", HoloMimeFromUrl(url));  // local shared-dir hit
        }
        // Shared-dir miss but a peer gossiped this κ → ask the local mesh sidecar to fetch it from a remote
        // peer (it verifies + persists the blob into HOLO_SHARED_DIR), then re-read. No gateway / no peer /
        // timeout ⇒ 0 ⇒ fall through to the origin floor (the seamless contract: mesh only accelerates).
        if (kr_mesh_get(k) == 1 && kr_shared_get(sc, k, &sp, &sl, &sm) == 1) {
          kr_cache_free_mime(k);
          return new HoloKappaCacheHandler(sp, sl, sm, "kappa-mesh", HoloMimeFromUrl(url));  // fetched from a peer over the mesh
        }
        kr_cache_free_mime(k);
      }
    }
  }
  // κ Universal Media Resolver (opt-in): a clear .mp4/H.264 media load the engine can't decode → transcode to
  // VP9/Opus WebM at this seam and serve it (κ-cached for instant repeats). Only media-typed GET loads for
  // non-DRM clear containers are touched; everything else falls through. Fail-closed = no worse than today.
  if (HoloMediaResolverEnabled() && request->GetMethod().ToString() == "GET" &&
      request->GetResourceType() == RT_MEDIA && HoloIsTranscodableMediaUrl(url)) {
    return new HoloMediaResolverHandler(url);
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
      return new HoloPlaygroundInjectFilter(url, mime);  // + document-capture for the Living Window manifest
  }

  LoadAdKappaOnce();
  const std::string url = request->GetURL().ToString();
  if (url.rfind("holo://", 0) == 0) return nullptr;  // never touch the κ substrate
  // ad-κ scripts take precedence (the ad filter drops denylisted payloads by content κ)
  if (!g_ad_kappa.empty() && rt == RT_SCRIPT) return new HoloAdKappaFilter();
  // Open-web κ-cache POPULATE: tee a cacheable subresource body into the substrate (cold miss only — a HIT
  // is served upstream with no filter). Applies to EVERY site in EVERY CEF tab; cold-novel only.
  if (IsCacheableWeb(request)) {
    // Only POPULATE from a FULL body (200). A 206 partial — common for media and large files — would store
    // a fragment as if it were the whole object → corrupt range serves. Skip partials; a later full GET (or
    // a 200 from a non-range fetch) populates. RANGE SERVING from a stored-whole object is on the hit path.
    if (response && response->GetStatus() == 206) return nullptr;
    const std::string mime = response ? response->GetMimeType().ToString() : std::string();
    return new HoloKappaTeeFilter(url, mime, ImmutableByHeaders(response, url));
  }
  return nullptr;
}

void SimpleHandler::OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                              TerminationStatus /*status*/,
                                              int /*error_code*/,
                                              const CefString& /*error_string*/) {
  LogLife("render process terminated");
  router_->OnRenderProcessTerminated(browser);

  // SELF-HEAL: a renderer death — commonly a cascade from an intermittent network-service crash on this host —
  // otherwise leaves a canonical surface (the OS shell, or a projected lens) stranded on a dead/sad tab with no
  // recovery (OnLoadError's grace only covers load errors while the renderer is ALIVE). The OS's own surfaces
  // are LOCAL, content-addressed κ served by the HotStore — independent of the network — so a reload brings them
  // straight back; the projected lens's present-mailbox holds the last frame meanwhile and re-projects resident
  // κ in ~1 frame. Only holo:// surfaces self-heal (external pages are the user's to reload); bounded per
  // browser so a genuine crash-loop falls through to the boot-health supervisor instead of spinning.
  if (!browser) return;
  CefRefPtr<CefFrame> mf = browser->GetMainFrame();
  const std::string url = mf ? mf->GetURL().ToString() : std::string();
  if (url.rfind("holo://", 0) != 0) return;
  static std::map<int, std::pair<int, std::chrono::steady_clock::time_point>> s_heal;  // browserId → (count, window start)
  const int id = browser->GetIdentifier();
  const auto now = std::chrono::steady_clock::now();
  auto& e = s_heal[id];
  if (std::chrono::duration<double>(now - e.second).count() > 30.0) e = {0, now};  // fresh 30s budget window
  if (e.first >= 5) { LogLife("render self-heal: budget exhausted — leaving surface to the supervisor"); return; }
  ++e.first;
  CefRefPtr<CefBrowser> b = browser;
  CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<CefBrowser> br) { if (br) br->Reload(); }, b), 400);
  LogLife("render self-heal: reloading holo:// surface after renderer death");
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
  // One window, in-page tabs (shell-is-chrome). A native-hosted Chrome browser has NO API to add a tab to an
  // existing window — every CefBrowserHost::CreateBrowser spawns a NEW top-level window. So route the open
  // through the shell's own tab model: window.HoloOpen(ref) mounts the surface as a holospace TAB in the
  // running shell window (a κ content address renders inline, verified — L5). OS file-path surfaces
  // (holo://os/… — e.g. the extensions manager) and the case where the shell frame is gone fall back to a
  // native window, preserving the old behaviour as a safety net.
  CefRefPtr<CefFrame> svc = ServiceFrame();
  if (svc && holo_url.rfind("holo://os/", 0) != 0) {
    svc->ExecuteJavaScript("window.HoloOpen&&window.HoloOpen(\"" + json_escape(holo_url) + "\");",
                           svc->GetURL(), 0);
    return;
  }
  CefBrowserSettings settings;
  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Hologram");
  window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
  CefBrowserHost::CreateBrowser(window_info, this, holo_url, settings, nullptr, nullptr);
}

// OpenPopupWindow — open a URL as its OWN top-level window (not an in-page tab). Extension action popups
// live at chrome-extension://<id>/<popup>, which is NOT a web-accessible resource → it cannot load in an
// iframe (the shell's in-page-tab path). A small Chrome-runtime popup window is the faithful rendering of
// an action popup AND the only way the bytes load. UI-thread only (CreateBrowser).
void SimpleHandler::OpenPopupWindow(const std::string& url) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::OpenPopupWindow, this, url));
    return;
  }
  CefBrowserSettings settings;
  CefWindowInfo window_info;
  window_info.SetAsPopup(nullptr, "Hologram");
  window_info.runtime_style = CEF_RUNTIME_STYLE_CHROME;
  CefBrowserHost::CreateBrowser(window_info, this, url, settings, nullptr, nullptr);
}

void SimpleHandler::OnLoadStart(CefRefPtr<CefBrowser> /*browser*/,
                               CefRefPtr<CefFrame> frame,
                               TransitionType /*transition_type*/) {
  CEF_REQUIRE_UI_THREAD();
  if (!frame || !frame->IsMain()) return;
  // New Tab Page → Hologram home/launcher. The chrome-runtime NTP commits as chrome://newtab or
  // chrome://new-tab-page[-third-party], BYPASSING OnBeforeBrowse — so redirect it here, at load start,
  // before the Chrome NTP paints. A new tab lands on the Hologram home instead of Google's tiles.
  const std::string u = frame->GetURL().ToString();
  if (u.rfind("chrome://newtab", 0) == 0 || u.rfind("chrome://new-tab-page", 0) == 0) {
    frame->LoadURL("holo://os/home.html");
  }
}

void SimpleHandler::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                              CefRefPtr<CefFrame> frame,
                              int /*httpStatusCode*/) {
  CEF_REQUIRE_UI_THREAD();
  if (frame->IsMain()) {
    const std::string fu = frame->GetURL().ToString();
    // Instant-boot metric: the FIRST main-frame load-end is "boot → canonical login on screen". Stamp it once.
    if (paint_ms_ < 0 && fu.rfind("holo://os", 0) == 0) {
      paint_ms_ = static_cast<long>(std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - boot_start_).count());
      LogLife("canonical login on screen: paintMs=" + std::to_string(paint_ms_) + " (" + fu + ")");
    }
    LogLife("main frame load end: " + fu);
    PushLifecycleToShell();
  }
  // First boot only: once the greeter has handed the main window off to the shell (login.html → shell.html
  // after sign-in), open the companion spaces as TABS in THIS window — not separate top-level windows.
  // Gated to the OS shell's main frame and fired once for the process (reloads/in-shell nav won't reopen).
  if (opened_boot_tabs_) return;
  if (!frame->IsMain()) return;
  if (main_browser_ && !main_browser_->IsSame(browser)) return;  // only the shell window, not the new tabs
  const std::string u = frame->GetURL().ToString();
  if (u.find("/shell.html") == std::string::npos) return;  // still on login.html → wait for the handoff
  opened_boot_tabs_ = true;
  // Open the companion spaces as in-page holospace TABS via the shell's own open path (window.HoloOpen) —
  // NOT window.open. In the shell-is-chrome single window apps are in-page tabs in THIS one window; HoloOpen
  // mounts each κ as a verified tab (a content-address κ renders inline, L5). window.open would spawn a
  // SEPARATE native top-level window (CEF: a native-hosted Chrome parent creates a popup WINDOW by default).
  // HoloOpen is wired by the shell's async module init, which can land just after load → retry briefly. The
  // two are SEQUENCED (await the first) so the second lands in its OWN tab (needNewTab() reads the first
  // tab's content, which is only present after its open resolves). Bare holo://<hex> (no trailing slash) so
  // the shell classifies it as a κ content address, not an app-id lookup.
  frame->ExecuteJavaScript(
      "(function(){var n=0;function go(){var o=window.HoloOpen;if(o){"
      "Promise.resolve(o('holo://18a46e721bab6d9a36645fecb95b0a79ae6ff10487237b413f39195785459972'))"
      ".then(function(){return o('holo://10e335d22cdf44081e7f974d29bac06be207b859f7d583b70e756927ccefe0e2');});"
      "}else if(n++<100){setTimeout(go,50);}}go();})();",
      frame->GetURL(), 0);
}

void SimpleHandler::CloseAllBrowsers(bool force_close) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::CloseAllBrowsers, this, force_close));
    return;
  }
  for (auto& b : browser_list_) b->GetHost()->CloseBrowser(force_close);
}
