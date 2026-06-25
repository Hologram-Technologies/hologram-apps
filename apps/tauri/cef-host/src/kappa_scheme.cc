// kappa_scheme.cc — serve content-addressed, dual-axis-verified bytes for holo://os/*.
//
// The resource handler runs in the browser process (the network service), BEFORE bytes reach the
// renderer: it asks the Rust verifier (kr_resolve) for the bytes of the requested κ-path, and the
// verifier re-derives both content-address axes and refuses tamper/unpinned (Law L5 / SEC-1 / SEC-6).
// A refusal becomes the HTTP status (403/404) with an empty body — fail-closed.
#include "kappa_scheme.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "include/cef_request.h"
#include "include/cef_response.h"
#include "include/cef_task.h"

#include "holo_sc.h"  // native /sc/* streaming backend (yt-dlp resolve + ffmpeg copy-mux, CEF-free)
#include <cctype>
#include "address_map.h"  // GENERATED short-address → canonical-rest map (mirrors holo-address.mjs)

// CanonicalizeRest — map a short native address to its canonical rest (the part after holo://), mirroring
// holo-address.resolve. The host runs CEF_RUNTIME_STYLE_CHROME, so the omnibox shows the committed top-level
// URL verbatim; committing the short form makes the bar read holo://os/login instead of holo://os/login.html.
// The OS origin host stays "os" (same-origin model intact) — only the path shortens, so keys are "os/<token>".
// A canonical path (os/login.html) or subresource (os/_shared/x.mjs) is not a key ⇒ passthrough. Pure lookup,
// never widens reachability (every value is a path already served). Case-insensitive on the key; on a miss the
// ORIGINAL rest is returned unchanged, so the served path's case is preserved.
static std::string CanonicalizeRest(const std::string& rest) {
  std::string r = rest;
  if (!r.empty() && r.back() == '/') r.pop_back();           // tolerate a lone trailing slash (holo://os/login/)
  if (r.empty()) return rest;
  std::string key = r;
  std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) { return (char)std::tolower(c); });
  for (int i = 0; i < kHoloAddressMapCount; ++i)
    if (key == kHoloAddressMap[i].shortKey) return kHoloAddressMap[i].canonRest;
  return rest;
}

// The shared open-web κ-cache (defined in handler.cc). KCache is declared in kappa_route.h (via hot_store.h).
KCache* HoloWebCache();
// The planetary shared-κ transport (handler.cc). Lets a κ minted on ANOTHER node be served here by content
// address — the cross-device projection path (KShared + kr_shared_get come from kappa_route.h via hot_store.h).
KShared* HoloSharedCache();

// The TEE-authenticated operator identity (set in handler.cc by the trusted shell after the biometric login
// gate). When present, the host's DID Document IS the operator's κ — one unified identity across every surface.
bool HostOperator(std::string& did, std::vector<uint8_t>& pub);

// Validate-before-serve for Linked Data (defined in handler.cc): "valid"/"invalid" if the response is JSON-LD,
// else nullptr. Lets every holo:// LD κ-object the substrate emits carry its W3C conformance verdict (X-Holo-LD).
const char* HoloLdVerdict(const std::string& mime, const char* body, size_t len);

namespace {

// The host's peer/agent identity public key. Production roots this in the operator's Ed25519 key (the JS
// identity layer); for now a stable per-install value from HOLO_PEER_KEY (hex) or a deterministic dev default.
std::vector<uint8_t> HostPeerKey() {
  if (const char* h = std::getenv("HOLO_PEER_KEY")) {
    std::string s(h);
    std::vector<uint8_t> out;
    for (size_t i = 0; i + 1 < s.size(); i += 2)
      out.push_back(static_cast<uint8_t>(std::strtol(s.substr(i, 2).c_str(), nullptr, 16)));
    if (!out.empty()) return out;
  }
  static const char kSeed[] = "holo-peer-key-v1";
  char hex[65] = {0};
  kr_sha256_hex(reinterpret_cast<const uint8_t*>(kSeed), sizeof(kSeed) - 1, hex);
  std::vector<uint8_t> out(32);
  for (int i = 0; i < 32; ++i) {
    char b[3] = {hex[i * 2], hex[i * 2 + 1], 0};
    out[i] = static_cast<uint8_t>(std::strtol(b, nullptr, 16));
  }
  return out;
}

// ── /sc/* native streaming handler ───────────────────────────────────────────────────────────────────
// The left-nav media apps (Holo Video, Holo Vinyl/Music) load holo://os/sc/vstream|stream|resolve|track|
// search — routes the dev server provides but the sealed native image does not. This handler ports them so
// the dock plays in the native host, STREAMING the bytes as they arrive (no whole-file buffering) for low
// latency, and serving a finished vstream from a disk cache (instant + seekable) on repeat.

// percent-decode a query value.
std::string UrlDecode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size()) {
      auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      const int hi = hex(s[i + 1]), lo = hex(s[i + 2]);
      if (hi >= 0 && lo >= 0) { out.push_back(static_cast<char>((hi << 4) | lo)); i += 2; continue; }
    }
    out.push_back(s[i] == '+' ? ' ' : s[i]);
  }
  return out;
}

// pull a single query parameter (decoded) out of a raw "a=1&b=2" string.
std::string QueryParam(const std::string& query, const std::string& key) {
  size_t i = 0;
  while (i < query.size()) {
    size_t amp = query.find('&', i);
    if (amp == std::string::npos) amp = query.size();
    const std::string pair = query.substr(i, amp - i);
    const size_t eq = pair.find('=');
    if (eq != std::string::npos && pair.substr(0, eq) == key) return UrlDecode(pair.substr(eq + 1));
    i = amp + 1;
  }
  return std::string();
}

// sha256 hex of `s` (the cache-file key), via the κ-route verifier already linked in.
std::string Sha256Hex(const std::string& s) {
  char hex[65] = {0};
  kr_sha256_hex(reinterpret_cast<const uint8_t*>(s.data()), s.size(), hex);
  return std::string(hex);
}

// Fires a resource-read callback on the thread it's posted to (the IO thread). A plain CefTask avoids the
// base::BindOnce-on-a-member-pointer path, which doesn't compile against this CEF's bind headers.
class HoloReadContinueTask : public CefTask {
 public:
  HoloReadContinueTask(CefRefPtr<CefResourceReadCallback> cb, int n) : cb_(std::move(cb)), n_(n) {}
  void Execute() override { if (cb_) cb_->Continue(n_); }
 private:
  CefRefPtr<CefResourceReadCallback> cb_;
  int n_;
  IMPLEMENT_REFCOUNTING(HoloReadContinueTask);
  DISALLOW_COPY_AND_ASSIGN(HoloReadContinueTask);
};

class HoloScHandler : public CefResourceHandler {
 public:
  HoloScHandler(std::string sub, std::string query) : sub_(std::move(sub)), query_(std::move(query)) {}

  ~HoloScHandler() {
    // The progressive .part is redundant once copied to the cache; drop it when the request ends.
    if (streamfile_.is_open()) streamfile_.close();
    if (!stream_tmp_.empty()) std::remove(stream_tmp_.c_str());
  }

  bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback> callback) override {
    // The worker holds a ref to this handler (CefRefPtr) and is detached: the destructor never blocks on a
    // long ffmpeg run, and if the tab closes mid-transcode the worker still finishes + warms the cache.
    CefRefPtr<HoloScHandler> self(this);
    if (request) range_hdr_ = request->GetHeaderByName("Range").ToString();  // honored only on the complete kFile path

    // Metadata routes (resolve / track / search) → buffered yt-dlp -J JSON, off the IO thread.
    if (sub_ == "resolve" || sub_ == "track" || sub_ == "search") {
      mime_ = "application/json";
      handle_request = false;
      open_cb_ = callback;
      std::thread([self]() { self->RunJson(); }).detach();
      return true;
    }

    // vstream (video) / stream (audio) — resolve, transcode to a SEEKABLE cache file, then serve it whole.
    // (Streaming a container to a pipe does not work here: the engine demuxer rejects a non-seekable WebM
    // with "Format error", and a CefResourceHandler 206 corrupts a <video>'s follow-up range request. A
    // complete seekable file served as one 200 plays cleanly — video AND audio — and repeats are instant.)
    if (sub_ == "vstream" || sub_ == "stream") {
      audio_ = (sub_ == "stream");
      mime_ = audio_ ? "audio/webm" : "video/webm";
      const std::string url = QueryParam(query_, "url");
      const std::string dir = HoloScCacheDir();
      if (url.empty() || !HoloHasYtDlp() || dir.empty()) {
        mode_ = kError; status_ = 502; handle_request = true; return true;
      }
      // Quality ceiling for EVERY streamed video: best available up to maxH (highest bitrate, SDR-preferred).
      // Default 1080p Full-HD; override with HOLO_SC_MAXH (e.g. 1440 / 2160) to push quality where the engine
      // stays stable. A client may request less, but the default/8K request is served at the ceiling.
      int maxH = 1080;
      if (const char* e = std::getenv("HOLO_SC_MAXH")) { const int v = std::atoi(e); if (v >= 360) maxH = v; }
      const int reqH = std::atoi(QueryParam(query_, "h").c_str());
      stream_url_ = url;
      stream_height_ = (reqH > 0) ? std::min(reqH, maxH) : maxH;
      const std::string key = audio_ ? ("a|" + url) : (url + "|" + std::to_string(stream_height_));
      cache_final_ = dir + "\\" + Sha256Hex(key) + (audio_ ? ".weba" : ".webm");

      // Cache HIT → serve the finished file immediately (instant repeat).
      if (StatFile(cache_final_)) { mode_ = kFile; from_cache_ = true; handle_request = true; return true; }

      // MISS, PROGRESSIVE (HOLO_SC_PROGRESSIVE=1, video only) → start a streamable -live webm and serve it AS
      // IT GROWS, so a long video starts in seconds instead of after a full download. Default-off: the proven
      // whole-file path below is untouched until the flag is set.
      if (!audio_ && EnvFlagOn("HOLO_SC_PROGRESSIVE")) {
        mode_ = kStream;
        handle_request = false;
        open_cb_ = callback;
        std::thread([self]() { self->RunStreamingTranscode(); }).detach();
        return true;
      }

      // MISS → transcode to the cache file on a worker, then serve it.
      mode_ = kFile;
      handle_request = false;
      open_cb_ = callback;
      std::thread([self]() { self->RunTranscode(); }).detach();
      return true;
    }

    mode_ = kError;
    status_ = 404;
    handle_request = true;
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length,
                          CefString& /*redirectUrl*/) override {
    CefResponse::HeaderMap h;
    response->GetHeaderMap(h);
    h.insert(std::make_pair("Access-Control-Allow-Origin", "*"));
    h.insert(std::make_pair("Cache-Control", "no-store"));

    if (mode_ == kError || sfailed_ || (mode_ == kFile && file_total_ == 0)) {
      response->SetStatus(status_ == 200 ? 502 : status_);
      response->SetStatusText("Stream Unavailable");
      response->SetHeaderMap(h);
      response_length = 0;
      return;
    }

    response->SetMimeType(mime_);
    response->SetStatus(200);
    response->SetStatusText("OK");

    if (mode_ == kStream) {
      // Progressive: serve the streamable webm AS IT GROWS, starting from the first cluster. The media stack
      // REFUSES an unknown length (response_length = -1 → err:4, MEASURED) but plays a streamable webm fine
      // when a byte-length is present (even with the webm duration N/A — MEASURED via the truncated-file test).
      // We don't know the final size of a growing remux, so declare a large SENTINEL and let Read() report the
      // true end (EOF when ffmpeg finishes); the media has played to its end by then. No Accept-Ranges: this
      // source is sequential, not seekable. The completed file is published to the cache for a seekable repeat.
      h.insert(std::make_pair("X-Holo-Source", "sc-stream"));
      response->SetHeaderMap(h);
      response_length = 0x100000000LL;   // 4 GiB sentinel — covers any long SDR stream; real EOF stops playback
      return;
    }

    if (mode_ == kFile) {
      // The complete file on disk SEEKS: honor a single byte-range with a 206 (mirroring handler.cc's cache
      // handler), advertise Accept-Ranges, and SLICE FROM DISK at Read time — never buffer the whole file (a 4K
      // file is hundreds of MB; that OOM'd the host). A full request still serves the whole file as one 200.
      h.insert(std::make_pair("X-Holo-Source", from_cache_ ? "sc-cache" : "sc-transcode"));
      h.insert(std::make_pair("Accept-Ranges", "bytes"));
      mediafile_.open(cache_final_, std::ios::binary);
      uint64_t start = 0, end = (file_total_ > 0) ? file_total_ - 1 : 0;
      bool partial = false;
      if (file_total_ > 0 && range_hdr_.rfind("bytes=", 0) == 0) {
        const std::string spec = range_hdr_.substr(6);
        const size_t dash = spec.find('-');
        if (dash != std::string::npos && spec.find(',') == std::string::npos) {  // a single range only
          const std::string a = spec.substr(0, dash), b = spec.substr(dash + 1);
          bool ok = true;
          if (!a.empty()) {                       // bytes=START-[END]
            start = std::strtoull(a.c_str(), nullptr, 10);
            if (!b.empty()) end = std::strtoull(b.c_str(), nullptr, 10);
          } else if (!b.empty()) {                // bytes=-SUFFIX → the last SUFFIX bytes
            const uint64_t suffix = std::strtoull(b.c_str(), nullptr, 10);
            start = (suffix >= file_total_) ? 0 : file_total_ - suffix;
          } else { ok = false; }
          if (end >= file_total_) end = file_total_ - 1;
          if (ok && start <= end) partial = true;
        }
      }
      if (partial) {
        const uint64_t slice = end - start + 1;
        response->SetStatus(206);
        response->SetStatusText("Partial Content");
        h.insert(std::make_pair("Content-Range", "bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(file_total_)));
        if (mediafile_) mediafile_.seekg(static_cast<std::streamoff>(start));
        kfile_remaining_ = slice;
        response->SetHeaderMap(h);
        response_length = static_cast<int64_t>(slice);
      } else {
        kfile_remaining_ = file_total_;
        response->SetHeaderMap(h);
        response_length = static_cast<int64_t>(file_total_);
      }
      return;
    }
    response->SetHeaderMap(h);  // kJson
    response_length = static_cast<int64_t>(body_.size());
  }

  bool Read(void* data_out, int bytes_to_read, int& bytes_read,
            CefRefPtr<CefResourceReadCallback> callback) override {
    bytes_read = 0;
    if (bytes_to_read <= 0) return false;
    if (mode_ == kStream) {
      // Serve from the growing file. If bytes are available now, return them synchronously. If we're at the
      // current end but ffmpeg is still writing, go ASYNC: stash the request; the pump thread fulfills it when
      // more bytes land (or signals EOF via Continue(0) once writing is done). Real EOF (done + drained) is a
      // synchronous false.
      std::lock_guard<std::mutex> lk(smtx_);
      const int n = ReadAvail(data_out, bytes_to_read);
      if (n > 0) { bytes_read = n; return true; }
      if (transcode_done_) return false;                 // done + drained → EOF
      pending_out_ = data_out;
      pending_len_ = bytes_to_read;
      pending_cb_ = callback;
      return true;                                       // async: pump will Continue() this callback
    }
    if (mode_ == kFile) {
      if (!mediafile_ || kfile_remaining_ == 0) return false;   // slice (206) or whole file (200) fully served
      uint64_t want = static_cast<uint64_t>(bytes_to_read);
      if (want > kfile_remaining_) want = kfile_remaining_;
      mediafile_.read(static_cast<char*>(data_out), static_cast<std::streamsize>(want));
      const std::streamsize got = mediafile_.gcount();
      if (got <= 0) return false;
      kfile_remaining_ -= static_cast<uint64_t>(got);
      bytes_read = static_cast<int>(got);
      return true;
    }
    if (body_off_ >= body_.size()) return false;  // kJson
    const size_t n = std::min(static_cast<size_t>(bytes_to_read), body_.size() - body_off_);
    std::memcpy(data_out, body_.data() + body_off_, n);
    body_off_ += n;
    bytes_read = static_cast<int>(n);
    return true;
  }

  void Cancel() override { cancelled_ = true; }

 private:
  enum Mode { kError, kJson, kFile, kStream };

  // True if an env flag is set to a non-empty, non-"0" value.
  static bool EnvFlagOn(const char* name) {
    const char* e = std::getenv(name);
    return e && e[0] && !(e[0] == '0' && e[1] == '\0');
  }

  // Current size of a file on disk (0 if missing). Used to watch the streaming file grow.
  static uint64_t FileSizeOf(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) return 0;
    const std::streamoff sz = f.tellg();
    return sz > 0 ? static_cast<uint64_t>(sz) : 0;
  }

  // Record the cached file's size (for Content-Length). The bytes are streamed from disk at Read time, never
  // buffered whole. Returns false if missing/empty.
  bool StatFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) return false;
    const std::streamoff sz = f.tellg();
    if (sz <= 0) return false;
    file_total_ = static_cast<uint64_t>(sz);
    return true;
  }

  // Buffered yt-dlp -J for resolve/track/search.
  void RunJson() {
    std::string cmd = "\"" + HoloYtDlpPath() + "\" -J --no-warnings ";
    if (sub_ == "search") {
      const std::string q = QueryParam(query_, "q");
      int n = std::atoi(QueryParam(query_, "n").c_str());
      if (n <= 0 || n > 50) n = 24;
      if (q.find('"') != std::string::npos) { Fail(); return; }  // refuse a quote that would break the arg
      cmd += "--flat-playlist \"scsearch" + std::to_string(n) + ":" + q + "\"";
    } else {
      const std::string url = QueryParam(query_, "url");
      if (url.empty() || url.find('"') != std::string::npos) { Fail(); return; }
      if (sub_ == "resolve") cmd += "--flat-playlist ";
      cmd += "\"" + url + "\"";
    }
    std::string out;
    const int code = HoloRunCapture(cmd, out, 30000);
    body_ = (code == 0 && !out.empty()) ? out : std::string("{\"error\":\"resolve failed\"}");
    mode_ = kJson;
    if (open_cb_) open_cb_->Continue();
  }

  // Resolve + transcode to the seekable cache file, then load it for serving. A concurrent request for the
  // same media may have produced the file first (a .part rename is atomic) — re-check before transcoding.
  void RunTranscode() {
    if (StatFile(cache_final_)) { from_cache_ = true; Done(); return; }
    const std::string tmp = cache_final_ + ".part." + Sha256Hex(query_).substr(0, 8);
    bool ok = false;
    if (!cancelled_) {
      if (audio_) {
        std::string direct;
        ok = HoloScResolveAudioUrl(stream_url_, direct) && HoloScTranscodeAudioToFile(direct, tmp);
      } else {
        std::vector<std::string> urls;
        ok = HoloScResolveVideoUrls(stream_url_, stream_height_, urls) &&
             HoloScTranscodeVideoToFile(urls, tmp);
      }
    }
    if (ok && !cancelled_) {
      std::remove(cache_final_.c_str());
      std::rename(tmp.c_str(), cache_final_.c_str());  // publish the COMPLETE file → instant repeats
      if (!StatFile(cache_final_)) ok = false;
    }
    std::remove(tmp.c_str());  // best-effort cleanup of any leftover partial
    if (!ok) { Fail(); return; }
    Done();
  }

  void Done() { if (open_cb_) open_cb_->Continue(); }  // bytes ready → GetResponseHeaders serves the 200

  void Fail() {
    sfailed_ = true;
    if (open_cb_) open_cb_->Continue();  // let GetResponseHeaders run (it reports 502)
  }

  // Read up to `len` newly-available bytes from the growing stream file into `out`. Caller holds smtx_.
  // Re-seeks each call (the file grows under us, and an ifstream latches EOF until cleared). Returns count.
  int ReadAvail(void* out, int len) {
    if (!streamfile_.is_open() || len <= 0) return 0;
    streamfile_.clear();                                       // drop a latched eof/fail from a prior short read
    streamfile_.seekg(static_cast<std::streamoff>(read_off_));
    streamfile_.read(static_cast<char*>(out), len);
    const std::streamsize got = streamfile_.gcount();
    if (got > 0) read_off_ += static_cast<uint64_t>(got);
    return static_cast<int>(got);
  }

  // Progressive worker: resolve → start a streamable -live webm → signal headers once a playable prefix exists
  // → pump bytes to the (async) reader until ffmpeg finishes → publish the completed file to the cache.
  void RunStreamingTranscode() {
    // Another request may have produced the finished file meanwhile → serve that (instant), skip streaming.
    if (StatFile(cache_final_)) { from_cache_ = true; mode_ = kFile; if (open_cb_) open_cb_->Continue(); return; }

    // Unique part path per request (this != that) so two concurrent same-URL streams never clobber one file.
    stream_tmp_ = cache_final_ + ".part." + Sha256Hex(std::to_string(reinterpret_cast<uintptr_t>(this)));
    std::remove(stream_tmp_.c_str());

    std::vector<std::string> urls;
    if (cancelled_ || !HoloScResolveVideoUrls(stream_url_, stream_height_, urls)) { Fail(); return; }
    proc_ = HoloScStartStreamingVideo(urls, stream_tmp_);
    if (!proc_) { Fail(); return; }

    // Wait for a minimal playable prefix (EBML header + first cluster) OR for ffmpeg to exit early.
    const uint64_t kMinBytes = 65536;
    for (int i = 0; i < 1200 && !cancelled_; ++i) {            // up to ~60s for first bytes (resolve+download)
      if (FileSizeOf(stream_tmp_) >= kMinBytes) break;
      if (!HoloScProcRunning(proc_)) break;                    // exited before min — serve whatever it wrote
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (cancelled_) { TeardownProc(); std::remove(stream_tmp_.c_str()); Fail(); return; }
    if (FileSizeOf(stream_tmp_) == 0) { TeardownProc(); Fail(); return; }  // nothing produced → 502

    streamfile_.open(stream_tmp_, std::ios::binary);
    if (!streamfile_.is_open()) { TeardownProc(); Fail(); return; }
    mode_ = kStream;
    if (open_cb_) open_cb_->Continue();                        // headers (200, length -1) → Read() begins
    RunStreamPump();
  }

  // Drive the stream to completion: fulfill async reads as bytes land, mark done when ffmpeg exits, then
  // publish the finished file to the cache (instant repeats via the kFile path).
  void RunStreamPump() {
    for (;;) {
      if (cancelled_) break;
      if (!HoloScProcRunning(proc_)) transcode_done_ = true;   // ffmpeg finished writing the whole stream
      // Fulfill a parked read if bytes are available now (or signal EOF if writing is done). Capture the
      // callback under the lock but fire Continue() OUTSIDE it — Continue() can re-enter Read() on the IO
      // thread, which also takes smtx_.
      CefRefPtr<CefResourceReadCallback> ready;
      int ready_n = 0;
      {
        std::lock_guard<std::mutex> lk(smtx_);
        if (pending_cb_) {
          const int n = ReadAvail(pending_out_, pending_len_);
          if (n > 0 || transcode_done_) { ready = pending_cb_; ready_n = n; pending_cb_ = nullptr; pending_out_ = nullptr; }
        }
      }
      // Continue() MUST run on the IO thread (Read() was called there); the pump is a worker thread, so
      // marshal it. Calling it directly from this thread corrupts CEF's resource pipeline (crashes under the
      // sustained async reads a long, still-growing stream produces — a short clip finishes before it shows).
      if (ready) CefPostTask(TID_IO, new HoloReadContinueTask(ready, ready_n));
      if (transcode_done_) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    // Settle any read that raced in right as we exited the loop. On a clean finish, hand it the final bytes /
    // EOF; on cancel, just drop the parked callback (the request is tearing down — don't touch data_out).
    CefRefPtr<CefResourceReadCallback> last;
    int last_n = 0;
    {
      std::lock_guard<std::mutex> lk(smtx_);
      if (pending_cb_ && !cancelled_) { last = pending_cb_; last_n = ReadAvail(pending_out_, pending_len_); }
      pending_cb_ = nullptr; pending_out_ = nullptr;
    }
    if (last) CefPostTask(TID_IO, new HoloReadContinueTask(last, last_n));
    TeardownProc();
    // Publish the COMPLETE streamed file to the cache so the next play is an instant kFile hit. Copy (not
    // rename) because our read handle may still be open; best-effort, only on a clean finish.
    if (!cancelled_ && transcode_done_ && FileSizeOf(stream_tmp_) > 0) {
      std::ifstream in(stream_tmp_, std::ios::binary);
      std::ofstream out(cache_final_, std::ios::binary | std::ios::trunc);
      if (in && out) { out << in.rdbuf(); }
    }
  }

  void TeardownProc() {
    if (proc_) {
      if (cancelled_ && HoloScProcRunning(proc_)) HoloScProcKill(proc_);
      HoloScProcClose(proc_);
      proc_ = 0;
    }
  }

  std::string sub_, query_;
  Mode mode_ = kError;
  CefString mime_ = "application/json";
  uint16_t status_ = 200;

  CefRefPtr<CefCallback> open_cb_;        // signals "headers ready" once
  std::atomic<bool> cancelled_{false};
  std::atomic<bool> sfailed_{false};

  std::string body_;                      // the kJson response body (small)
  size_t body_off_ = 0;

  // media transcode/cache — the file is STREAMED from disk (mediafile_), never buffered whole in RAM
  std::string stream_url_, cache_final_;
  std::ifstream mediafile_;
  uint64_t file_total_ = 0;
  int stream_height_ = 0;
  bool audio_ = false;
  bool from_cache_ = false;
  // kFile range/206: a fully-cached/finished file is complete on disk, so it SEEKS — honor a single byte-range
  // (HTML <video>/<audio> issue Range requests), mirroring handler.cc's HoloKappaCacheHandler. Slice from disk.
  std::string range_hdr_;            // raw "Range:" header captured in Open()
  uint64_t kfile_remaining_ = 0;     // bytes still to serve for this kFile response (the slice, or the whole file)

  // progressive streaming (kStream): serve the growing -live webm; an async read parks here until the pump
  // thread feeds it more bytes (or signals EOF). All file/pending access is guarded by smtx_.
  std::string stream_tmp_;
  std::ifstream streamfile_;
  uintptr_t proc_ = 0;
  uint64_t read_off_ = 0;
  std::atomic<bool> transcode_done_{false};
  std::mutex smtx_;
  void* pending_out_ = nullptr;
  int pending_len_ = 0;
  CefRefPtr<CefResourceReadCallback> pending_cb_;

  IMPLEMENT_REFCOUNTING(HoloScHandler);
  DISALLOW_COPY_AND_ASSIGN(HoloScHandler);
};

class KappaResourceHandler : public CefResourceHandler {
 public:
  explicit KappaResourceHandler(HotStore* store) : store_(store) {}
  ~KappaResourceHandler() override {
    if (data_) {
      kr_free(data_, size_);
    }
  }

  bool Open(CefRefPtr<CefRequest> request,
            bool& handle_request,
            CefRefPtr<CefCallback> /*callback*/) override {
    handle_request = true;  // resolved synchronously below

    // holo://os/apps/browser/index.html → "/os/apps/browser/index.html" (kr flat_key strips "os/").
    std::string url = request->GetURL().ToString();
    static const std::string kScheme = "holo://";
    std::string rest =
        (url.size() >= kScheme.size() && url.compare(0, kScheme.size(), kScheme) == 0)
            ? url.substr(kScheme.size())
            : url;
    rest = rest.substr(0, rest.find_first_of("?#"));  // drop query/fragment
    rest = CanonicalizeRest(rest);                     // holo://login → os/login.html (the bar reads the short form)
    std::string req = "/" + rest;
    path_ = req;                                       // remembered for the scoped-CORS decision below

    // The Living Window manifest: holo://os/cache/entries.json → the open-web κ-cache contents (what you've
    // browsed), as JSON. Served at the OS origin so it is same-origin to the window and NOT readable by any
    // other κ-app cross-origin (origin-gated by construction). Metadata only (url/κ/mime/len) — no bodies.
    if (req == "/os/cache/entries.json") {
      char* j = HoloWebCache() ? kr_cache_entries(HoloWebCache()) : nullptr;
      synth_ = j ? std::string(j) : std::string("[]");
      if (j) kr_cache_free_mime(j);                    // free the Rust string with ITS allocator (never kr_free)
      synthetic_ = true;
      status_ = 200;
      size_ = synth_.size();
      mime_ = "application/json";
      return true;
    }

    // The host's W3C DID Document — its κ-rooted peer/agent identity (did:holo), at the standard
    // /.well-known/did.json so any W3C consumer or agent resolves + verifies it (self-certifying: the DID is
    // sha256(key)). VALIDATE-BEFORE-SERVE: the document is checked as conformant Linked Data (kr_ld_validate)
    // and stamped X-Holo-LD in the headers below. Public identity ⇒ ACAO:* (set in GetResponseHeaders).
    if (req == "/os/.well-known/did.json") {
      // UNIFIED IDENTITY: once the user has passed the TEE-secured login gate, the shell pushes the operator κ +
      // public key, and the host's DID IS the operator (one identity, every surface). Before login it falls back
      // to a provisional device identity, so the endpoint always resolves. Validate-before-serve either way.
      std::string opDid;
      std::vector<uint8_t> opPub;
      char* doc = nullptr;
      if (HostOperator(opDid, opPub)) {
        doc = kr_did_document_for(opDid.c_str(), opPub.data(), opPub.size(), "holo-mesh://auto");
      } else {
        std::vector<uint8_t> key = HostPeerKey();
        doc = kr_did_document(key.data(), key.size(), "holo-mesh://auto");
      }
      synth_ = doc ? std::string(doc) : std::string("{}");
      ld_valid_ = doc && kr_ld_validate(synth_.c_str()) == 1;  // validate-before-serve
      if (doc) kr_cache_free_mime(doc);
      synthetic_ = true;
      did_endpoint_ = true;
      status_ = 200;
      size_ = synth_.size();
      mime_ = "application/did+json";
      return true;
    }

    // The Living Window pulls a captured object's bytes BY its κ: holo://os/cache/sha256/<hex>. Same OS
    // origin (origin-gated). Content-addressed (the hex IS the hash) ⇒ immutable + re-derived (L5). The
    // buffer is Rust-owned (freed via kr_free in the destructor, like a kr_resolve buffer); the mime is
    // copied into mime_ and the Rust string freed immediately.
    static const std::string kCachePfx = "/os/cache/sha256/";
    if (req.compare(0, kCachePfx.size(), kCachePfx) == 0) {
      const std::string hex = req.substr(kCachePfx.size());
      char* m = nullptr;
      if (HoloWebCache() && kr_cache_get_kappa(HoloWebCache(), hex.c_str(), &data_, &size_, &m) == 1) {
        status_ = 200;
        mime_ = m ? m : "application/octet-stream";   // CefString copies the chars
        if (m) kr_cache_free_mime(m);                 // free the Rust mime now; mime_ holds a copy
      } else if (HoloSharedCache() && kr_shared_get(HoloSharedCache(), hex.c_str(), &data_, &size_, &m) == 1) {
        // CROSS-DEVICE: not minted locally → served from the planetary shared-κ transport (another node's
        // projection tile). kr_shared_get re-derives the κ and refuses a mismatch (L5), so the relay is untrusted.
        status_ = 200;
        mime_ = m ? m : "application/octet-stream";
        if (m) kr_cache_free_mime(m);
      } else if (HoloSharedCache() && kr_mesh_get(hex.c_str()) == 1 &&
                 kr_shared_get(HoloSharedCache(), hex.c_str(), &data_, &size_, &m) == 1) {
        // WAN: shared-dir miss but the κ is fetchable over the MESH — the local sidecar (kr_mesh_get) pulls the
        // tile from a remote PEER, verifies (L5) + persists it, then kr_shared_get serves it. So a projection tile
        // travels machine-to-machine by content address, novelty-only — the same peer leg the open-web κ-cache
        // uses, now for live scene tiles. No peer / no gateway / timeout ⇒ 404 (origin floor), never a hang.
        status_ = 200;
        mime_ = m ? m : "application/octet-stream";
        if (m) kr_cache_free_mime(m);
      } else {
        status_ = 404;
      }
      return true;
    }

    // The FAST σ-axis: the projection lens pulls a κ tile by its BLAKE3 address (holo://os/cache/blake3/<hex>).
    // Same cache, same L5 (re-derive BLAKE3) — the OSR producer hashes tiles on this axis (~3.2 GB/s) and the
    // lens fetches + verifies on it. Mirrors the sha256 route above.
    static const std::string kCacheB3Pfx = "/os/cache/blake3/";
    if (req.compare(0, kCacheB3Pfx.size(), kCacheB3Pfx) == 0) {
      const std::string hex = req.substr(kCacheB3Pfx.size());
      char* m = nullptr;
      if (HoloWebCache() && kr_cache_get_b3(HoloWebCache(), hex.c_str(), &data_, &size_, &m) == 1) {
        status_ = 200;
        mime_ = m ? m : "application/octet-stream";
        if (m) kr_cache_free_mime(m);
      } else {
        status_ = 404;
      }
      return true;
    }

    // DEV: serve the Living Window page + its bundle + css from $HOLO_LW_DIR for holo://os/lw/* — lets the
    // in-host experience run WITHOUT sealing into the tree (the production path is the reseal). Same OS origin,
    // so the page can fetch the holo://os/cache/* endpoints. Gated by the env var (absent ⇒ inactive); a path
    // with ".." is refused. NOT a sealed/verified path — explicitly a dev seam.
    static const std::string kLwPfx = "/os/lw/";
    if (req.compare(0, kLwPfx.size(), kLwPfx) == 0 && req.find("..") == std::string::npos) {
      const char* dir = std::getenv("HOLO_LW_DIR");
      if (dir && dir[0]) {
        const std::string file = std::string(dir) + req.substr(kLwPfx.size() - 1);  // dir + "/<name>"
        std::ifstream f(file, std::ios::binary);
        if (f) {
          std::ostringstream ss; ss << f.rdbuf();
          synth_ = ss.str();
          synthetic_ = true; status_ = 200; size_ = synth_.size();
          const std::string ext = file.substr(file.find_last_of('.') + 1);
          mime_ = ext == "html" ? "text/html"
                : ext == "js"   ? "text/javascript"
                : ext == "mjs"  ? "text/javascript"   // ES modules need a JS MIME or the import is refused
                : ext == "css"  ? "text/css"
                : ext == "json" ? "application/json"
                : ext == "webm" ? "video/webm"
                : ext == "mp4"  ? "video/mp4"
                : ext == "mp3"  ? "audio/mpeg" : "application/octet-stream";
          return true;
        }
      }
      status_ = 404;
      return true;
    }

    // DEV: serve the κ-native retro game engine + its cores/ROMs from $HOLO_RETRO_DIR for
    // holo://os/retro/* — the console twin of the qemu path runs IN the native host (real libretro
    // core → κ-ROM verify-on-read → WebGPU super-res → κ-audio worklet), no dev server. Cross-origin
    // isolation is intrinsic here (the COOP/COEP headers below apply to every response), so the SAB
    // audio ring + AudioWorklet work without an external COI server. Rooted at the HOLOGRAM dir so the
    // engine's sibling import of ../holospaces-alpine-P0/kappa-engine/* resolves. Gated by the env var
    // (absent ⇒ inactive); ".." is refused. A dev seam, NOT a sealed/verified path (that is the reseal).
    static const std::string kRetroPfx = "/os/retro/";
    if (req.compare(0, kRetroPfx.size(), kRetroPfx) == 0 && req.find("..") == std::string::npos) {
      const char* dir = std::getenv("HOLO_RETRO_DIR");
      if (dir && dir[0]) {
        const std::string file = std::string(dir) + req.substr(kRetroPfx.size() - 1);  // dir + "/<path>"
        std::ifstream f(file, std::ios::binary);
        if (f) {
          std::ostringstream ss; ss << f.rdbuf();
          synth_ = ss.str();
          synthetic_ = true; status_ = 200; size_ = synth_.size();
          const std::string ext = file.substr(file.find_last_of('.') + 1);
          mime_ = ext == "html" ? "text/html"
                : ext == "js"   ? "text/javascript"
                : ext == "mjs"  ? "text/javascript"          // ES modules need a JS MIME
                : ext == "css"  ? "text/css"
                : ext == "json" ? "application/json"
                : ext == "wasm" ? "application/wasm"          // WebAssembly.instantiateStreaming requires this
                : (ext == "gb" || ext == "gbc" || ext == "gba" || ext == "nes" ||
                   ext == "sfc" || ext == "md"  || ext == "bin")
                                ? "application/octet-stream"  // ROM cartridges (fetched as ArrayBuffer)
                : "application/octet-stream";
          return true;
        }
      }
      status_ = 404;
      return true;
    }

    const char* mime = nullptr;
    status_ = store_->resolve(req.c_str(), &data_, &size_, &mime);  // hot-reloadable store (live reseal)
    mime_ = mime ? mime : "application/octet-stream";
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t& response_length,
                          CefString& /*redirectUrl*/) override {
    response->SetStatus(status_);
    // CefResponse::SetMimeType wants the BARE type ("text/html"), not "text/html; charset=utf-8" —
    // the charset suffix makes Chromium treat the document as non-HTML and render it as plain text.
    // The charset is declared in each document's <meta charset> anyway.
    std::string full = mime_.ToString();
    const size_t semi = full.find(';');
    response->SetMimeType(semi == std::string::npos ? full : full.substr(0, semi));
    // Cross-origin isolation so the OS's WASM engines (SharedArrayBuffer) run — same headers the
    // Tauri host set. credentialless lets each κ-origin embed shared engines without CORP friction.
    response->SetHeaderByName("Cross-Origin-Opener-Policy", "same-origin", true);
    response->SetHeaderByName("Cross-Origin-Embedder-Policy", "credentialless", true);
    response->SetHeaderByName("Cross-Origin-Resource-Policy", "cross-origin", true);
    // The Playground runtime is PUBLIC editor code the host injects into every real web page; a real page is
    // a DIFFERENT origin than holo://, so its module-script fetch is CORS-mode and needs ACAO to load. Scope
    // this to ONLY the playground graph (its files + holo-live-edit + holo-uor) — never the rest of the
    // substrate, so no cross-origin page can read user data or other modules. Same-origin holo:// is unchanged.
    if (path_.find("/_shared/holo-playground-") != std::string::npos ||
        path_.find("/_shared/holo-live-edit.mjs") != std::string::npos ||
        path_.find("/_shared/holo-uor.mjs") != std::string::npos ||
        // The Holo DevTools dock is ALSO host-injected into every tab (holo-devtools-dock-boot.js), so its
        // module graph is fetched CORS-mode by app origins and needs ACAO. Scope: the whole devtools graph
        // plus its non-devtools deps (object/scene/blake3). uor is already covered above.
        path_.find("/_shared/devtools/") != std::string::npos ||
        path_.find("/_shared/holo-object.mjs") != std::string::npos ||
        path_.find("/_shared/holo-scene.mjs") != std::string::npos ||
        path_.find("/_shared/holo-blake3.mjs") != std::string::npos) {
      response->SetHeaderByName("Access-Control-Allow-Origin", "*", true);
    }
    // The DID Document is PUBLIC identity: any W3C consumer/agent resolves it cross-origin.
    if (did_endpoint_) {
      response->SetHeaderByName("Access-Control-Allow-Origin", "*", true);
    }
    // VALIDATE-BEFORE-SERVE, generalized: every holo:// response that IS Linked Data (not just the DID doc)
    // carries its W3C conformance verdict, so a consumer/agent trusts the meaning. Non-LD responses are unstamped.
    if (status_ == 200) {
      const char* body = synthetic_ ? synth_.data() : reinterpret_cast<const char*>(data_);
      const size_t blen = synthetic_ ? synth_.size() : size_;
      if (const char* ld = HoloLdVerdict(mime_.ToString(), body, blen))
        response->SetHeaderByName("X-Holo-LD", ld, true);
    }
    // κ caching. ONLY the CONTENT route (/.holo/<axis>/<hex> — where the hex literally IS the content
    // hash) is truly IMMUTABLE: cache it forever, re-serve from memory with no re-fetch/re-verify →
    // content-addressed streaming. A per-κ ORIGIN (host = an app's @id κ) is NOT content-immutable: the
    // app's bytes change as the operator develops while the @id stays fixed, so caching it immutable would
    // serve STALE after a reseal — it must revalidate. Everything except the content route → no-cache
    // (revalidate, so a reseal is picked up immediately). Per-byte L5 verification is unaffected.
    if (status_ == 200) {
      const bool immutable = path_.find("/.holo/sha256/") != std::string::npos ||
                             path_.find("/.holo/blake3/") != std::string::npos ||
                             path_.find("/os/cache/sha256/") != std::string::npos;  // κ-addressed cache object
      response->SetHeaderByName(
          "Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache", true);
    }
    response_length = (status_ == 200) ? static_cast<int64_t>(size_) : 0;
  }

  bool Read(void* data_out,
            int bytes_to_read,
            int& bytes_read,
            CefRefPtr<CefResourceReadCallback> /*callback*/) override {
    bytes_read = 0;
    // synthetic responses (the cache manifest) serve from a C++-owned string; everything else from the
    // Rust-owned verified buffer.
    const uint8_t* buf = synthetic_ ? reinterpret_cast<const uint8_t*>(synth_.data()) : data_;
    if (status_ != 200 || !buf || offset_ >= size_) {
      return false;  // completion (or refusal → empty body)
    }
    const size_t remaining = size_ - offset_;
    const int n = static_cast<int>(std::min(static_cast<size_t>(bytes_to_read), remaining));
    std::memcpy(data_out, buf + offset_, static_cast<size_t>(n));
    offset_ += static_cast<size_t>(n);
    bytes_read = n;
    return true;
  }

  void Cancel() override {}

 private:
  HotStore* store_ = nullptr;
  uint8_t* data_ = nullptr;
  size_t size_ = 0;
  size_t offset_ = 0;
  uint16_t status_ = 500;
  CefString mime_;
  std::string path_;       // the resolved request path (for the scoped-CORS decision in GetResponseHeaders)
  std::string synth_;      // a synthesized body (the cache manifest) — C++-owned, not a Rust buffer
  bool synthetic_ = false; // true ⇒ serve from synth_, and the destructor must NOT kr_free
  bool did_endpoint_ = false; // the /.well-known/did.json response (public ACAO + X-Holo-LD header)
  bool ld_valid_ = false;     // validate-before-serve verdict for the DID document

  IMPLEMENT_REFCOUNTING(KappaResourceHandler);
  DISALLOW_COPY_AND_ASSIGN(KappaResourceHandler);
};

}  // namespace

// holo://os/sc/<sub>?<query> → the native streaming companion (Holo Video / Holo Vinyl). Built here but
// invoked from handler.cc's GetResourceHandler (the resource-request path) so range/206 works for <video>.
CefRefPtr<CefResourceHandler> HoloCreateScHandler(const std::string& url) {
  static const std::string kScPfx = "holo://os/sc/";
  if (url.size() < kScPfx.size() || url.compare(0, kScPfx.size(), kScPfx) != 0) return nullptr;
  const std::string rest = url.substr(kScPfx.size());
  const size_t q = rest.find('?');
  const std::string sub = rest.substr(0, q);
  const std::string query = (q == std::string::npos) ? std::string() : rest.substr(q + 1);
  return new HoloScHandler(sub, query);
}

CefRefPtr<CefResourceHandler> KappaSchemeHandlerFactory::Create(
    CefRefPtr<CefBrowser> /*browser*/,
    CefRefPtr<CefFrame> /*frame*/,
    const CefString& /*scheme_name*/,
    CefRefPtr<CefRequest> /*request*/) {
  return new KappaResourceHandler(store_);
}
