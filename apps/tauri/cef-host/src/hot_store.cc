// hot_store.cc — see hot_store.h. Watches os-closure.json and hot-swaps the sealed store on reseal.
#include "hot_store.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>

std::string HotStore::AnchorOf(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::stringstream ss;
  ss << f.rdbuf();
  const std::string bytes = ss.str();
  if (bytes.empty()) return "";  // mid-write (atomic rename in flight) — skip this tick
  char hex[65] = {0};
  kr_sha256_hex(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), hex);
  return std::string(hex);
}

HotStore::HotStore(std::string root) : root_(std::move(root)) {
  closure_path_ = root_ + "/os-closure.json";
  anchor_ = AnchorOf(closure_path_);
  // Pass the freshly-computed anchor: it matches the file we're loading by construction (never poisoned),
  // exactly like the launcher's bat does at startup — but now we recompute it on every reseal.
  store_ = kr_store_open(root_.c_str(), anchor_.empty() ? nullptr : anchor_.c_str());
  watcher_ = std::thread([this] { WatchLoop(); });
}

HotStore::~HotStore() {
  stop_ = true;
  if (watcher_.joinable()) watcher_.join();
  if (store_) kr_store_free(store_);
}

uint16_t HotStore::resolve(const char* req, uint8_t** out_ptr, size_t* out_len, const char** out_mime) {
  std::shared_lock<std::shared_mutex> lk(mu_);
  return kr_resolve(store_, req, out_ptr, out_len, out_mime);
}

void HotStore::WatchLoop() {
  namespace fs = std::filesystem;
  std::error_code ec;
  fs::file_time_type last_mt = fs::last_write_time(closure_path_, ec);
  while (!stop_.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    if (stop_.load()) break;
    std::error_code mec;
    const auto mt = fs::last_write_time(closure_path_, mec);  // cheap: only hash if mtime changed
    if (mec || mt == last_mt) continue;
    last_mt = mt;
    const std::string cur = AnchorOf(closure_path_);
    if (cur.empty() || cur == anchor_) continue;             // mid-write or unchanged content
    KStore* ns = kr_store_open(root_.c_str(), cur.c_str());  // anchor==file ⇒ never poisoned
    if (!ns) continue;                                       // open failed → keep the old store
    KStore* old = nullptr;
    {
      std::unique_lock<std::shared_mutex> lk(mu_);           // waits out all in-flight resolves
      old = store_;
      store_ = ns;
      anchor_ = cur;
    }
    if (old) kr_store_free(old);                             // safe: no resolve holds it past the swap
  }
}
