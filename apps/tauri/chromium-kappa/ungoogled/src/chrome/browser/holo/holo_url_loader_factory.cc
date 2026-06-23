// holo_url_loader_factory.cc — see header. Reuses the `kappa-route` C ABI verbatim; the only logic here
// is the Mojo plumbing that streams the verifier's bytes (standard Chromium URLLoader pattern, mirroring
// the in-tree WebUI/file factories). Compile-verify in the Chromium tree against the pinned milestone.

#include "chrome/browser/holo/holo_url_loader_factory.h"

#include <dlfcn.h>

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/path_service.h"
#include "base/strings/strcat.h"
#include "chrome/browser/holo/holo_closure_anchor.h"  // baked HOLO_CLOSURE_ANCHOR (build.gn writes it)
#include "mojo/public/cpp/system/data_pipe.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace holo {

namespace {
// The request path contract is byte-identical to the proven CEF handler: host (= κ or "os") + path.
//   holo://os/home.html        -> "os/home.html"
//   holo://<κ>/                -> "<κ>/"
//   holo://os/.holo/sha256/<h> -> "os/.holo/sha256/<h>"  (content-address route)
std::string RequestPath(const GURL& url) {
  return base::StrCat({url.host(), url.path()});  // host (= κ or "os") + path (string_views)
}

// The κ verifier ships as a sibling shared library (libkappa_route.so) and is loaded at RUNTIME via
// dlopen — NOT linked into chrome — so its Rust runtime and glibc stay fully decoupled from Chromium's
// hermetic toolchain. The C ABI is reused verbatim, just resolved dynamically. FAIL-CLOSED: if the .so
// or any symbol is missing, the pointers are null and the factory refuses everything.
using KrStoreOpenFn = KStore* (*)(const char*, const char*);
using KrResolveFn = uint16_t (*)(const KStore*, const char*, uint8_t**, size_t*, const char**);
using KrFreeFn = void (*)(uint8_t*, size_t);
struct KappaApi {
  KrStoreOpenFn open = nullptr;
  KrResolveFn resolve = nullptr;
  KrFreeFn free_buf = nullptr;
};

const KappaApi& Api() {
  static const KappaApi api = []() -> KappaApi {
    base::FilePath exe_dir;
    base::PathService::Get(base::DIR_EXE, &exe_dir);
    const std::string so = exe_dir.AppendASCII("libkappa_route.so").AsUTF8Unsafe();
    void* h = dlopen(so.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!h) return {};
    KappaApi a;
    a.open = reinterpret_cast<KrStoreOpenFn>(dlsym(h, "kr_store_open"));
    a.resolve = reinterpret_cast<KrResolveFn>(dlsym(h, "kr_resolve"));
    a.free_buf = reinterpret_cast<KrFreeFn>(dlsym(h, "kr_free"));
    return a;
  }();
  return api;
}

// The dlsym'd verifier entrypoints are indirect calls into a module OUTSIDE Chromium's CFI type universe,
// so -fsanitize=cfi-icall would trap (ud1/SIGILL) on them. Exempt ONLY these thin wrappers from cfi-icall;
// the rest of the file keeps full CFI. Each is fail-closed if its symbol is missing.
__attribute__((no_sanitize("cfi-icall")))
KStore* CallOpen(const char* root, const char* anchor) {
  return Api().open ? Api().open(root, anchor) : nullptr;
}
__attribute__((no_sanitize("cfi-icall")))
uint16_t CallResolve(const KStore* st, const char* path, uint8_t** out, size_t* len, const char** mime) {
  return Api().resolve ? Api().resolve(st, path, out, len, mime) : 0;
}
__attribute__((no_sanitize("cfi-icall")))
void CallFree(uint8_t* ptr, size_t len) {
  if (Api().free_buf) Api().free_buf(ptr, len);
}
}  // namespace

// The OS image (the sealed dist) ships beside the browser; --holo-os-dir overrides for dev. The store is
// opened ONCE with the baked closure anchor: if the served manifest != HOLO_CLOSURE_ANCHOR the store is
// poisoned and refuses everything (the trust root — G1 / SEC-1), identical to the CEF host.
KStore* GetOrOpenStore() {
  // A function-local static pointer: lazy, thread-safe, opened once. (NoDestructor rejects a trivial
  // type like a raw pointer.)
  static KStore* const store = []() -> KStore* {
    base::FilePath dir;
    const auto* cmd = base::CommandLine::ForCurrentProcess();
    if (cmd->HasSwitch("holo-os-dir")) {
      dir = cmd->GetSwitchValuePath("holo-os-dir");
    } else {
      base::FilePath exe_dir;
      base::PathService::Get(base::DIR_EXE, &exe_dir);
      dir = exe_dir.AppendASCII("holo-os");  // packaged image next to the executable
    }
    return CallOpen(dir.AsUTF8Unsafe().c_str(), HOLO_CLOSURE_ANCHOR);
  }();
  return store;
}

// static
mojo::PendingRemote<network::mojom::URLLoaderFactory> HoloURLLoaderFactory::Create(
    KStore* store) {
  mojo::PendingRemote<network::mojom::URLLoaderFactory> remote;
  // SelfDeletingURLLoaderFactory owns its lifetime; deletes when the last receiver disconnects.
  new HoloURLLoaderFactory(remote.InitWithNewPipeAndPassReceiver(), store);
  return remote;
}

HoloURLLoaderFactory::HoloURLLoaderFactory(
    mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
    KStore* store)
    : network::SelfDeletingURLLoaderFactory(std::move(receiver)), store_(store) {}

HoloURLLoaderFactory::~HoloURLLoaderFactory() = default;

void HoloURLLoaderFactory::CreateLoaderAndStart(
    mojo::PendingReceiver<network::mojom::URLLoader> /*loader*/,
    int32_t /*request_id*/,
    uint32_t /*options*/,
    const network::ResourceRequest& request,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client_remote,
    const net::MutableNetworkTrafficAnnotationTag& /*traffic_annotation*/) {
  mojo::Remote<network::mojom::URLLoaderClient> client(std::move(client_remote));

  const std::string path = RequestPath(request.url);
  uint8_t* data = nullptr;
  size_t len = 0;
  const char* mime = nullptr;
  // THE κ GATE: dual-axis re-derivation in the verifier. 200 = verified hit; else L5 refuse.
  // No verifier loaded ⇒ refuse (fail closed).
  const uint16_t status = CallResolve(store_, path.c_str(), &data, &len, &mime);

  if (status != 200) {
    // 403 tamper/unpinned, 404 absent, 400 bad input → a content-blind network error (fail closed).
    client->OnComplete(network::URLLoaderCompletionStatus(net::ERR_FILE_NOT_FOUND));
    return;
  }

  auto head = network::mojom::URLResponseHead::New();
  head->mime_type = mime ? std::string(mime) : std::string("application/octet-stream");
  head->content_length = static_cast<int64_t>(len);
  head->headers = net::HttpResponseHeaders::TryToCreate("HTTP/1.1 200 OK");
  // Same isolation posture the CEF host serves: every holo:// origin is crossOriginIsolated.
  head->headers->SetHeader("Cross-Origin-Opener-Policy", "same-origin");
  head->headers->SetHeader("Cross-Origin-Embedder-Policy", "credentialless");
  head->headers->SetHeader("Cross-Origin-Resource-Policy", "cross-origin");
  head->headers->SetHeader("Content-Type", head->mime_type);

  mojo::ScopedDataPipeProducerHandle producer;
  mojo::ScopedDataPipeConsumerHandle consumer;
  if (mojo::CreateDataPipe(len ? len : 1, producer, consumer) != MOJO_RESULT_OK) {
    CallFree(data, len);
    client->OnComplete(network::URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
    return;
  }
  client->OnReceiveResponse(std::move(head), std::move(consumer), std::nullopt);

  // Copy the verified bytes into the pipe, then return them to the verifier's allocator.
  std::string body(reinterpret_cast<const char*>(data), len);
  CallFree(data, len);
  auto writer = std::make_unique<mojo::DataPipeProducer>(std::move(producer));
  mojo::DataPipeProducer* raw = writer.get();
  raw->Write(std::make_unique<mojo::StringDataSource>(
                 body, mojo::StringDataSource::AsyncWritingMode::
                           STRING_STAYS_VALID_UNTIL_COMPLETION),
             base::BindOnce(
                 [](std::unique_ptr<mojo::DataPipeProducer>, std::string,
                    mojo::Remote<network::mojom::URLLoaderClient> client,
                    MojoResult result) {
                   client->OnComplete(network::URLLoaderCompletionStatus(
                       result == MOJO_RESULT_OK ? net::OK : net::ERR_FAILED));
                 },
                 std::move(writer), std::move(body), std::move(client)));
}

}  // namespace holo
