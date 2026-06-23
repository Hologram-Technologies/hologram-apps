#!/usr/bin/env bash
# build-kappa-ungoogled.sh — produce the Google-free, κ-substrate-native Hologram browser by overlaying
# the Hologram κ integration onto ungoogled-chromium, using ungoogled's OWN build mechanism verbatim
# (utils/downloads.py -> prune_binaries.py -> patches.py -> domain_substitution.py -> flags.gn -> ninja).
#
# This runs on a BUILD MACHINE / CI (≈120–150 GB disk, 16–32 GB RAM, hours), not in an editor session.
# ungoogled-chromium is the Google-free base: domain_substitution rewrites every Google domain to the
# unreachable qjz9zk sink, prune_binaries strips proprietary blobs, and its patch set removes
# account/sync/telemetry. We add ONLY the κ scheme + URLLoaderFactory (reusing the witnessed verifier)
# and the Hologram branding. No browser/UX code is written — the whole browser is upstream.
set -euo pipefail

# ── pin: ungoogled-chromium 149.0.7827.155-1 == Chromium 149.0.7827.155, parity with the CEF host
#    (149.0.7827.156). Verified present at this tag: utils/{downloads,prune_binaries,patches,
#    domain_substitution}.py, flags.gn, downloads.ini, pruning.list, domain_{substitution,regex}.list.
#    Windows: the packaging repo tag is 149.0.7827.155-1.1 (ungoogled-chromium-windows). Bump together. ─
UC_TAG="${UC_TAG:-149.0.7827.155-1}"           # ungoogled-chromium release tag = {chromium_ver}-{revision}
HERE="$(cd "$(dirname "$0")" && pwd)"          # chromium-kappa/ungoogled
PKG="$(cd "$HERE/.." && pwd)"                  # chromium-kappa (holds holo/lib + holo/include)
TAURI="$(cd "$PKG/.." && pwd)"                 # holo-apps/apps/tauri (holds src-tauri/kappa-route)
OS_IMAGE="${OS_IMAGE:-$TAURI/dist}"            # the sealed Hologram OS image (make-dist.mjs output)
WORK="${WORK:-$PWD/uc-build}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 8)}"

echo "== Hologram × ungoogled-chromium  (tag $UC_TAG, jobs $JOBS) =="
echo "   OS image: $OS_IMAGE"

# 0) preflight — fail early with a clear message, not mid-build.
for t in git python3 gn ninja; do command -v "$t" >/dev/null || echo "WARN: '$t' not on PATH (needed for the build)"; done
[ -d "$OS_IMAGE" ] || { echo "FATAL: OS image not found at $OS_IMAGE (run make-dist.mjs first)"; exit 1; }
[ -f "$OS_IMAGE/os-closure.json" ] || echo "WARN: $OS_IMAGE/os-closure.json missing → trust anchor will be empty"

# 0b) build the κ verifier FROM SOURCE for the HOST triple so the link target is reproducible and
#     cross-platform (cargo resolves the crate's deps; no committed blob, no in-tree rust vendoring).
#     cargo emits kappa_route.lib (Windows/MSVC) or libkappa_route.a (Linux/macOS); BUILD.gn links the
#     right one per-OS. Falls back to the committed prebuilt only if cargo is unavailable.
if command -v cargo >/dev/null; then
  # Chromium-on-Windows is the MSVC ABI, so force that triple under a Windows shell; elsewhere the host
  # default (linux-gnu / apple-darwin) is correct. Needs `rustup target add x86_64-pc-windows-msvc` on Win.
  TRIPLE=""
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) TRIPLE="x86_64-pc-windows-msvc";; esac
  ( cd "$TAURI/src-tauri" && cargo build --release -p kappa-route ${TRIPLE:+--target "$TRIPLE"} )
  REL="$TAURI/src-tauri/target/${TRIPLE:+$TRIPLE/}release"
  for n in kappa_route.lib libkappa_route.a; do
    if [ -f "$REL/$n" ]; then cp "$REL/$n" "$PKG/holo/lib/$n"; echo "[holo] verifier built from source → holo/lib/$n"; fi
  done
  cp "$HERE/../../cef-host/include/kappa_route.h" "$PKG/holo/include/kappa_route.h" 2>/dev/null || true
else
  echo "[holo] cargo not found — using the committed prebuilt in holo/lib/"
fi

mkdir -p "$WORK" && cd "$WORK"

# 1) ungoogled-chromium itself (the patch set + utils + downloads.ini for this exact Chromium).
[ -d ungoogled-chromium ] || git clone --depth 1 --branch "$UC_TAG" \
  https://github.com/ungoogled-software/ungoogled-chromium.git
cd ungoogled-chromium

# 2) ungoogled's documented steps — get source, prune, patch, de-Google (docs/building.md, verbatim).
mkdir -p build/download_cache
./utils/downloads.py retrieve -c build/download_cache -i downloads.ini
./utils/downloads.py unpack  -c build/download_cache -i downloads.ini -- build/src
./utils/prune_binaries.py    build/src pruning.list
./utils/patches.py apply     build/src patches
./utils/domain_substitution.py apply -r domain_regex.list -f domain_substitution.list \
  -c build/domsubcache.tar.gz build/src

# 3) the Hologram κ overlay — stage the verifier, bake the trust root, apply the +6-line seams.
python3 "$HERE/holo_kappa_overlay.py" --src build/src --overlay "$HERE" --os-image "$OS_IMAGE"

# 4) branding → "Hologram OS" + the H mark (string + resource substitution; no code).
python3 "$HERE/branding/apply_branding.py" --src build/src --branding "$HERE/branding" || \
  echo "[holo] branding step skipped (optional)"

# 5) flags: ungoogled's flags.gn + the Hologram κ / Google-free belt.
mkdir -p build/src/out/Default
cat flags.gn "$HERE/holo-flags.gn" > build/src/out/Default/args.gn

# 6) configure + build the full browser (complete //chrome: omnibox, tabstrip, app menu, extensions).
# The de-Google pruning strips prebuilt binaries (including buildtools/linux64/gn), so depot_tools' gn
# wrapper can't find a prebuilt gn. Build gn FROM SOURCE — ungoogled's documented path. ninja comes from
# depot_tools (on PATH).
cd build/src
if [ ! -x out/Default/gn ]; then
  python3 tools/gn/bootstrap/bootstrap.py --skip-generate-buildfiles -j"$JOBS" -o out/Default/
fi
./out/Default/gn gen out/Default --fail-on-unused-args
ninja -C out/Default chrome chromedriver

# 7) package: ship the sealed OS image beside the executable (GetOrOpenStore() reads ./holo-os).
cp -r "$OS_IMAGE" out/Default/holo-os
echo "== done → out/Default/chrome  (Google-free, κ-native; OS image at out/Default/holo-os) =="
echo "   verify: chrome --holo-os-dir=out/Default/holo-os  then open holo://os/"
