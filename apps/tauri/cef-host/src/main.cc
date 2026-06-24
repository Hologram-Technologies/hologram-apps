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

#include "app.h"
#include "holo_osr.h"

// Enable the multiprocess sandbox by defining CEF_USE_SANDBOX and linking cef_sandbox.lib (standard
// dist). The minimal dist omits it, so the skeleton runs unsandboxed; production MUST enable it (P4).
#if defined(CEF_USE_SANDBOX)
#pragma comment(lib, "cef_sandbox.lib")
#endif

int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, LPTSTR, int) {
  void* sandbox_info = nullptr;
#if defined(CEF_USE_SANDBOX)
  CefScopedSandboxInfo scoped_sandbox;
  sandbox_info = scoped_sandbox.sandbox_info();
#endif

  CefMainArgs main_args(hInstance);
  CefRefPtr<SimpleApp> app(new SimpleApp);

  // Subprocess? Run it and exit.
  const int exit_code = CefExecuteProcess(main_args, app, sandbox_info);
  if (exit_code >= 0) {
    return exit_code;
  }

  CefSettings settings;
#if !defined(CEF_USE_SANDBOX)
  settings.no_sandbox = true;
#endif
  settings.remote_debugging_port = 9333;  // localhost-only CDP — for the boot proof.
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
  CefString(&settings.root_cache_path).FromWString(dir + L"\\cache");

  CefInitialize(main_args, settings, app, sandbox_info);
  // Latency bench mode: open an off-screen producer on HOLO_OSR_BENCH=<url>, measure on the real engine, and
  // quit when done (the bench drives the exit). Runs alongside boot; logs "HOLO-OSR-BENCH:" to stderr.
  if (const char* bench_url = std::getenv("HOLO_OSR_BENCH")) {
    if (bench_url[0]) holo::BenchOsr(bench_url);
  }
  // Live end-to-end: open the lens page + an off-screen producer on HOLO_PROJECT_URL; the whole BLAKE3
  // projection chain runs in one open (verify the lens canvas via CDP :9333).
  if (const char* project_url = std::getenv("HOLO_PROJECT_URL")) {
    if (project_url[0]) holo::ProjectBench(project_url);
  }
  CefRunMessageLoop();
  CefShutdown();
  return 0;
}
