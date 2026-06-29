# CMakeLists.txt — the Hologram CEF host.
#
# Builds a real Chromium (CEF tracks chromium.git) that serves Hologram OS over the κ-native `holo://`
# scheme, with verification delegated to the Rust `kappa-route` crate (no engine code; documented CEF
# embedder API only). Modeled on the canonical cefsimple CMakeLists (CEF sample, BSD-licensed).
#
# Build (Windows, from a VS2022 x64 command prompt — or use build.ps1):
#   cargo build --release -p kappa-route            # produces the κ-route verifier DLL
#   cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -S . -B build
#   cmake --build build --target holo_cef_host

cmake_minimum_required(VERSION 3.21)
set(CMAKE_CONFIGURATION_TYPES Debug Release)
project(holo_cef_host)
set_property(GLOBAL PROPERTY USE_FOLDERS ON)

# Renderer sandbox (P4/security). CEF 149 no longer links a cef_sandbox.lib — it uses the BOOTSTRAP model:
# the host builds as a DLL that the prebuilt bootstrap.exe (shipped in EVERY dist, incl. the minimal one we
# vendor) loads, creating the sandbox and passing sandbox_info into our exported RunWinMain. So the sandbox
# needs NO extra dist/lib — only this switch. ON = secure default (DLL + bootstrap launcher, see below);
# build with -DUSE_SANDBOX=OFF for a quick unsandboxed single-exe build when debugging. When ON, the CEF
# cmake defines CEF_USE_SANDBOX + CEF_USE_BOOTSTRAP, which main.cc keys off for the entry point.
set(USE_SANDBOX ON CACHE BOOL "Enable the CEF 149 bootstrap renderer sandbox (DLL + bootstrap.exe loader)")

# Locate the CEF binary distribution (fetched by vendor-cef.ps1).
set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cef")
set(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)

# The CEF DLL wrapper (built from source in the dist) and a logical target for prebuilt libcef.
add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)
ADD_LOGICAL_TARGET("libcef_lib" "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

SET_CEF_TARGET_OUT_DIR()

# The Rust κ-route verifier: cdylib import lib + DLL, built for the MSVC ABI (to match libcef.lib).
# build.ps1 runs `cargo build --release -p kappa-route --target x86_64-pc-windows-msvc` from src-tauri.
set(KR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../src-tauri/target/x86_64-pc-windows-msvc/release")

set(HOLO_SRCS
  src/main.cc
  src/app.cc
  src/handler.cc
  src/holo_media.cc   # κ Universal Media Resolver backend (ffmpeg H.264→VP9/Opus transcode)
  src/holo_sc.cc      # native /sc/* streaming backend (yt-dlp resolve + ffmpeg copy-mux for the dock media apps)
  src/kappa_scheme.cc
  src/holo_osr.cc    # off-screen browser PRODUCER: page → κ tiles → lens (P4 projection; OnPaint + CDP input)
  src/hot_store.cc   # live-anchor hot-reload: watches os-closure.json, hot-swaps the sealed store on reseal
  src/broker_server.cc   # self-contained loopback HTTP server serving the step-up WebAuthn broker
  src/holo_hello.cc      # native platform-authenticator (Windows Hello) login ceremony via webauthn.dll (no iframe)
  src/holo_winicon.cc    # force the Hologram H as the native window + taskbar icon (de-brand the Chromium product logo)
  src/mesh_supervisor.cc # auto-spawn + supervise the always-on mesh node (planetary content network, zero input)
  holo.rc   # embeds the Hologram mark as the exe/window icon (taskbar, Alt-Tab, title bar)
)

if(USE_SANDBOX)
  # Bootstrap sandbox: build the host as a DLL (holo_cef_host.dll). The staged bootstrap.exe (renamed to
  # holo_cef_host.exe below) loads it and calls the exported RunWinMain. The export is __declspec(dllexport)
  # via CEF_BOOTSTRAP_EXPORT (cef_sandbox_win.h) under extern "C", so no .def file is needed. SET_LIBRARY_*
  # applies the shared-target linker flags (incl. the /DELAYLOAD:libcef.dll the bootstrap model requires).
  add_library(holo_cef_host SHARED ${HOLO_SRCS})
  SET_LIBRARY_TARGET_PROPERTIES(holo_cef_host)
else()
  add_executable(holo_cef_host WIN32 ${HOLO_SRCS})
  SET_EXECUTABLE_TARGET_PROPERTIES(holo_cef_host)
endif()
add_dependencies(holo_cef_host libcef_dll_wrapper)
target_include_directories(holo_cef_host PRIVATE "${CEF_ROOT}" "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(holo_cef_host
  libcef_lib
  libcef_dll_wrapper
  ${CEF_STANDARD_LIBS}
  "${KR_DIR}/kappa_route.dll.lib"
  ws2_32   # Winsock — the loopback step-up broker server (src/broker_server.cc)
  d3d11    # GPU zero-copy OSR: OnAcceleratedPaint shared texture → staging readback → blake3 κ tiles (holo_osr.cc)
)
# Emit a linked PDB even in Release so crash dumps symbolize to function+line (this host has had intermittent
# GPU/subprocess crashes; symbols make future dumps diagnosable). /OPT:REF dead-strips as usual, but /OPT:NOICF
# is deliberate: identical-COMDAT folding merges distinct functions and MISATTRIBUTES crash frames.
target_compile_options(holo_cef_host PRIVATE /Zi)
target_link_options(holo_cef_host PRIVATE /DEBUG /OPT:REF /OPT:NOICF)

# Stage the runtime next to the exe: CEF binaries + resources, then the κ-route DLL.
COPY_FILES(holo_cef_host "${CEF_BINARY_FILES}"   "${CEF_BINARY_DIR}"   "${CEF_TARGET_OUT_DIR}")
COPY_FILES(holo_cef_host "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")
# Sandbox launcher: stage the prebuilt windowed bootstrap.exe AS holo_cef_host.exe next to holo_cef_host.dll.
# This loader creates the sandbox, loads the same-basename DLL, and calls its exported RunWinMain. The
# matching basename is REQUIRED — bootstrap derives the DLL name from its own exe name.
if(USE_SANDBOX)
  add_custom_command(TARGET holo_cef_host POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${CEF_BINARY_DIR}/bootstrap.exe" "${CEF_TARGET_OUT_DIR}/holo_cef_host.exe"
    COMMENT "Staging bootstrap.exe as holo_cef_host.exe (sandbox launcher)")
  # De-brand the staged launcher: transplant the Hologram icon + "Hologram" VERSIONINFO (compiled into the
  # DLL from holo.rc) onto the bootstrap exe, replacing CEF's defaults while preserving its manifest. $<TARGET_FILE>
  # is the DLL. Non-fatal (the script always exits 0) — the launcher works regardless of its icon.
  add_custom_command(TARGET holo_cef_host POST_BUILD
    COMMAND powershell -ExecutionPolicy Bypass -NoProfile -File
      "${CMAKE_CURRENT_SOURCE_DIR}/tools/patch-exe-resources.ps1"
      -SrcPe "$<TARGET_FILE:holo_cef_host>" -DstPe "${CEF_TARGET_OUT_DIR}/holo_cef_host.exe"
    COMMENT "De-branding holo_cef_host.exe icon + version (transplant from DLL)")
endif()
# De-brand: rebrand "Chromium" → "Hologram" in the STAGED resource paks, AFTER COPY_FILES restages them.
# The source paks under third_party/cef/Resources are already patched (so this is normally a no-op), but this
# re-asserts the rebrand if CEF is ever re-vendored fresh. Equal-length replace = offset-safe, no repacking.
# Non-fatal: if node isn't on PATH the build still succeeds (the patched source paks were already staged).
add_custom_command(TARGET holo_cef_host POST_BUILD
  COMMAND cmd /c "node \"${CMAKE_CURRENT_SOURCE_DIR}/tools/debrand-paks.mjs\" \"${CEF_TARGET_OUT_DIR}\" || exit 0"
  COMMENT "De-branding resource paks (Chromium -> Hologram)")
add_custom_command(TARGET holo_cef_host POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${KR_DIR}/kappa_route.dll" "${CEF_TARGET_OUT_DIR}")

# Stage the mesh sidecar next to the host exe so the supervisor finds it (the planetary network auto-starts).
# Best-effort: only if it has been built — the host runs fine without it (origin floor), so this never blocks.
set(HOLO_MESH_EXE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../holo-mesh-node/target/x86_64-pc-windows-msvc/release/holo-mesh-node.exe")
if(EXISTS "${HOLO_MESH_EXE}")
  add_custom_command(TARGET holo_cef_host POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${HOLO_MESH_EXE}" "${CEF_TARGET_OUT_DIR}")
endif()
