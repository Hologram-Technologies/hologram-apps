// mesh_supervisor.cc — see mesh_supervisor.h. Spawns `holo-mesh-node node …` (one always-on process that BOTH
// serves the host's shared dir to peers AND is the host's fetch gateway on 127.0.0.1:9802, which kr_mesh_get
// targets) and respawns it if it ever exits. The shared dir is the SAME one SharedCache()/kr_shared_* use, so
// the node serves exactly what the browser cached and writes peer-fetched blobs back for the host to serve.
#include "mesh_supervisor.h"

#include <windows.h>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

namespace {

// The shared κ dir — identical to handler.cc SharedCache(): HOLO_SHARED_DIR, else %TEMP%\holo-shared-kappa.
std::string MeshSharedDir() {
  if (const char* d = std::getenv("HOLO_SHARED_DIR"))
    if (d[0]) return std::string(d);
  const char* t = std::getenv("TEMP");
  if (!t) t = std::getenv("TMP");
  return std::string(t ? t : ".") + "\\holo-shared-kappa";
}

// holo-mesh-node.exe staged next to the host exe.
std::string MeshExePath() {
  char buf[MAX_PATH] = {0};
  GetModuleFileNameA(nullptr, buf, MAX_PATH);
  std::string p(buf);
  const size_t slash = p.find_last_of("\\/");
  const std::string dir = (slash == std::string::npos) ? std::string(".") : p.substr(0, slash);
  return dir + "\\holo-mesh-node.exe";
}

}  // namespace

void StartMeshSupervisor() {
  std::thread([] {
    const std::string exe = MeshExePath();
    // No sidecar present (e.g. a dev build that didn't stage it) → the mesh stays dormant. The browser is
    // unaffected: kr_mesh_get just gets connection-refused and falls through to the origin. Never fatal.
    if (GetFileAttributesA(exe.c_str()) == INVALID_FILE_ATTRIBUTES) return;
    const std::string dir = MeshSharedDir();
    const std::string cmd = "\"" + exe + "\" node 127.0.0.1:9802 0.0.0.0:9811 \"" + dir + "\"";
    for (;;) {
      STARTUPINFOA si{};
      si.cb = sizeof(si);
      PROCESS_INFORMATION pi{};
      std::string mut = cmd;  // CreateProcessA may write to the command buffer
      if (CreateProcessA(nullptr, mut.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si,
                         &pi)) {
        WaitForSingleObject(pi.hProcess, INFINITE);  // supervise: respawn when it exits
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
      }
      std::this_thread::sleep_for(std::chrono::seconds(3));  // backoff before restart
    }
  }).detach();
}
