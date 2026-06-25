// main.cc — Windows entry for the Hologram CEF host.
//
// Single-executable model: this same binary is the browser process AND its render/GPU subprocesses
// (CefExecuteProcess returns >= 0 in a subprocess). The browser process opens a real Chromium window
// at holo://os/apps/browser/index.html, served by the κ-route verifier. A localhost CDP port lets us
// prove a genuine Chromium loaded the OS without needing to see pixels.
#include <windows.h>

#include <cstdlib>
#include <string>

#include "include/cef_app.h"
#include "include/cef_sandbox_win.h"
#include "include/cef_task.h"
#include "include/base/cef_callback.h"
#include "include/wrapper/cef_closure_task.h"

#include "app.h"
#include "holo_osr.h"

// Renderer sandbox model. CEF 149 NO LONGER links a cef_sandbox.lib — when USE_SANDBOX is on the CMake
// defines CEF_USE_BOOTSTRAP, the host is built as a DLL, and the prebuilt bootstrap.exe (shipped in every
// dist, incl. minimal) loads it, creates the sandbox, and calls our exported RunWinMain with sandbox_info.
// The old linked-lib path is kept only for legacy dists (CEF_USE_SANDBOX without CEF_USE_BOOTSTRAP).
#if defined(CEF_USE_SANDBOX) && !defined(CEF_USE_BOOTSTRAP)
#pragma comment(lib, "cef_sandbox.lib")
#endif

// Shared body for every entry-point flavor. |sandbox_info| is bootstrap-provided (sandboxed DLL),
// CefScopedSandboxInfo-provided (legacy linked sandbox), or nullptr (unsandboxed exe).
static int RunMain(HINSTANCE hInstance, LPTSTR /*lpCmdLine*/, int /*nCmdShow*/, void* sandbox_info) {
  CefMainArgs main_args(hInstance);
  CefRefPtr<SimpleApp> app(new SimpleApp);

  // Subprocess? Run it and exit.
  const int exit_code = CefExecuteProcess(main_args, app, sandbox_info);
  if (exit_code >= 0) {
    return exit_code;
  }

  CefSettings settings;
  // Disable the sandbox ONLY in a genuinely unsandboxed build. On Windows the CEF cmake signals "sandboxed"
  // with CEF_USE_BOOTSTRAP (the bootstrap model); CEF_USE_SANDBOX is the Linux/Mac signal. Gate on BOTH so a
  // Windows bootstrap build keeps no_sandbox=false (sandbox ON). Keying on CEF_USE_SANDBOX alone left this
  // true on Windows → every process ran "Not Sandboxed" despite the bootstrap loader.
#if !defined(CEF_USE_SANDBOX) && !defined(CEF_USE_BOOTSTRAP)
  settings.no_sandbox = true;
#endif
  // localhost-only CDP — for the boot proof. Default 9333; override with HOLO_DEBUG_PORT so a
  // second/relaunch instance can use a fresh port when an orphaned socket still holds the default.
  settings.remote_debugging_port = 9333;
  if (const char* dp = std::getenv("HOLO_DEBUG_PORT")) { const int v = std::atoi(dp); if (v > 0 && v < 65536) settings.remote_debugging_port = v; }
  settings.windowless_rendering_enabled = true;  // enable off-screen (Alloy) producers for κ projection (P4)
  // Keep a CLEAN, standard Chrome product token. user_agent_product REPLACES the product token; any
  // extra token wedged between Chrome/<ver> and Safari/537.36 (e.g. a Hologram brand) breaks UA-gating
  // sites — web.whatsapp.com refuses to render ("update your browser") unless the UA looks like real
  // Chrome. Chrome reports a reduced version (149.0.0.0). Hologram branding lives off the UA.
  CefString(&settings.user_agent_product).FromASCII("Chrome/149.0.0.0");

  // Chrome style (the real Chrome UI) needs a persistent cache dir; place it next to the executable.
  wchar_t exe[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, exe, MAX_PATH);
  std::wstring dir(exe);
  const size_t slash = dir.find_last_of(L"\\/");
  if (slash != std::wstring::npos) {
    dir = dir.substr(0, slash);
  }
  // Per-instance profile so multiple ISOLATED hosts (parallel tests) run side by side without the CEF
  // singleton conflict (one user-data-dir = one live instance; a 2nd hands off to the 1st and exits). Default
  // = <exe>\cache (production); a test sets HOLO_CACHE_DIR=<unique dir> for its own profile. Pairs with the
  // HOLO_DEBUG_PORT override above — together they make each test fully independent.
  std::wstring cacheDir = dir + L"\\cache";
  if (const char* cd = std::getenv("HOLO_CACHE_DIR")) {
    if (cd[0]) {
      const int n = MultiByteToWideChar(CP_UTF8, 0, cd, -1, nullptr, 0);
      if (n > 1) { std::wstring w(n - 1, L'\0'); MultiByteToWideChar(CP_UTF8, 0, cd, -1, &w[0], n); cacheDir = w; }
    }
  }
  CefString(&settings.root_cache_path).FromWString(cacheDir);

  CefInitialize(main_args, settings, app, sandbox_info);
  // Latency bench mode: open an off-screen producer on HOLO_OSR_BENCH=<url>, measure on the real engine, and
  // quit when done (the bench drives the exit). Runs alongside boot; logs "HOLO-OSR-BENCH:" to stderr.
  if (const char* bench_url = std::getenv("HOLO_OSR_BENCH")) {
    if (bench_url[0]) holo::BenchOsr(bench_url);
  }
  // Live end-to-end: open the lens page + an off-screen producer on HOLO_PROJECT_URL; the whole BLAKE3
  // projection chain runs in one open (verify the lens canvas via CDP :9333). DEFER it: opening the lens at
  // process start races the κ store still opening (cold-boot ERR_INVALID_RESPONSE → "lens never surfaced"). A
  // short defer lets the store finish opening first; the LensClient load-retry grace recovers any residual race.
  // (Production mounts the lens as a shell NODE after login — store long ready, no race; this matches that.)
  if (const char* project_url = std::getenv("HOLO_PROJECT_URL")) {
    if (project_url[0]) {
      std::string u = project_url;
      CefPostDelayedTask(TID_UI, base::BindOnce([](std::string url) { holo::ProjectBench(url); }, u), 2500);
    }
  }
  // Cross-device: this node is a REMOTE LENS — no producer; composite the scene another node (HOLO_OSR_SHARE=1)
  // publishes to the shared manifest channel + shared-κ tile transport. Deferred like the bench so the store is up.
  if (const char* rl = std::getenv("HOLO_REMOTE_LENS")) {
    if (rl[0] == '1') CefPostDelayedTask(TID_UI, base::BindOnce([]() { holo::ProjectRemote(); }), 2500);
  }
  CefRunMessageLoop();
  CefShutdown();
  return 0;
}

#if defined(CEF_USE_BOOTSTRAP)
// CEF 149 sandbox: this module is a DLL loaded by bootstrap.exe (staged as holo_cef_host.exe). The
// bootstrap process creates the sandbox and hands us |sandbox_info|; |version_info| is unused because we
// link the matching libcef.lib at build time. RunWinMain is exported (CEF_BOOTSTRAP_EXPORT → dllexport,
// extern "C") so bootstrap.exe resolves it by name.
CEF_BOOTSTRAP_EXPORT int RunWinMain(HINSTANCE hInstance,
                                    LPTSTR lpCmdLine,
                                    int nCmdShow,
                                    void* sandbox_info,
                                    cef_version_info_t* /*version_info*/) {
  return RunMain(hInstance, lpCmdLine, nCmdShow, sandbox_info);
}
#else
// Unsandboxed (USE_SANDBOX=OFF) or legacy linked-sandbox build: a normal windowed executable.
int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, LPTSTR lpCmdLine, int nCmdShow) {
  void* sandbox_info = nullptr;
#if defined(CEF_USE_SANDBOX)
  CefScopedSandboxInfo scoped_sandbox;
  sandbox_info = scoped_sandbox.sandbox_info();
#endif
  return RunMain(hInstance, lpCmdLine, nCmdShow, sandbox_info);
}
#endif
