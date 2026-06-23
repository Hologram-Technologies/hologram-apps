// hot_store.h — a hot-reloadable κ-store. Resolves against the current sealed image; a background watcher
// re-opens the store whenever dist/os-closure.json changes (the operator reseals during dev), so a reseal
// updates the RUNNING browser live instead of poisoning it (stale anchor → 403). Thread-safe: resolves
// take a shared lock; the atomic swap takes an exclusive lock and frees the old store after in-flight
// resolves drain. Per-byte L5 (kr_resolve) is unchanged.
#ifndef HOLO_HOT_STORE_H
#define HOLO_HOT_STORE_H

#include <atomic>
#include <cstdint>
#include <shared_mutex>
#include <string>
#include <thread>

#include "kappa_route.h"

class HotStore {
 public:
  explicit HotStore(std::string root);  // root = dist dir (HOLO_OS_DIR)
  ~HotStore();

  // Resolve under a shared lock so the store can't be swapped/freed mid-call. Same contract as kr_resolve.
  uint16_t resolve(const char* req, uint8_t** out_ptr, size_t* out_len, const char** out_mime);

 private:
  static std::string AnchorOf(const std::string& closure_path);  // sha256 hex of os-closure.json
  void WatchLoop();

  std::string root_;
  std::string closure_path_;       // root_ + "/os-closure.json"
  std::shared_mutex mu_;           // guards store_ (shared = resolve, exclusive = swap)
  KStore* store_ = nullptr;        // current sealed image (raw FFI handle)
  std::string anchor_;             // sha256 of the closure store_ was opened with (watcher-only after ctor)
  std::atomic<bool> stop_{false};
  std::thread watcher_;
};

#endif  // HOLO_HOT_STORE_H
