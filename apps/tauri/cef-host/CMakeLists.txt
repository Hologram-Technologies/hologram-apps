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

# The minimal CEF distribution ships no cef_sandbox.lib, so the skeleton builds unsandboxed.
# Production MUST switch to the standard dist and re-enable the sandbox (P4/security).
set(USE_SANDBOX OFF CACHE BOOL "" FORCE)

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
  src/mesh_supervisor.cc # auto-spawn + supervise the always-on mesh node (planetary content network, zero input)
  holo.rc   # embeds the Hologram mark as the exe/window icon (taskbar, Alt-Tab, title bar)
)

add_executable(holo_cef_host WIN32 ${HOLO_SRCS})
SET_EXECUTABLE_TARGET_PROPERTIES(holo_cef_host)
add_dependencies(holo_cef_host libcef_dll_wrapper)
target_include_directories(holo_cef_host PRIVATE "${CEF_ROOT}" "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(holo_cef_host
  libcef_lib
  libcef_dll_wrapper
  ${CEF_STANDARD_LIBS}
  "${KR_DIR}/kappa_route.dll.lib"
  ws2_32   # Winsock — the loopback step-up broker server (src/broker_server.cc)
)
# Emit a linked PDB even in Release so crash dumps symbolize to function+line (this host has had intermittent
# GPU/subprocess crashes; symbols make future dumps diagnosable). /OPT:REF dead-strips as usual, but /OPT:NOICF
# is deliberate: identical-COMDAT folding merges distinct functions and MISATTRIBUTES crash frames.
target_compile_options(holo_cef_host PRIVATE /Zi)
target_link_options(holo_cef_host PRIVATE /DEBUG /OPT:REF /OPT:NOICF)

# Stage the runtime next to the exe: CEF binaries + resources, then the κ-route DLL.
COPY_FILES(holo_cef_host "${CEF_BINARY_FILES}"   "${CEF_BINARY_DIR}"   "${CEF_TARGET_OUT_DIR}")
COPY_FILES(holo_cef_host "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")
add_custom_command(TARGET holo_cef_host POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${KR_DIR}/kappa_route.dll" "${CEF_TARGET_OUT_DIR}")

# Stage the mesh sidecar next to the host exe so the supervisor finds it (the planetary network auto-starts).
# Best-effort: only if it has been built — the host runs fine without it (origin floor), so this never blocks.
set(HOLO_MESH_EXE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../holo-mesh-node/target/x86_64-pc-windows-msvc/release/holo-mesh-node.exe")
if(EXISTS "${HOLO_MESH_EXE}")
  add_custom_command(TARGET holo_cef_host POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${HOLO_MESH_EXE}" "${CEF_TARGET_OUT_DIR}")
endif()
