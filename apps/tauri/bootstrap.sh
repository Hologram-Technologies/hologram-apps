#!/usr/bin/env sh
# bootstrap.sh — boot Hologram natively from a single link (macOS / Linux).
#
#   curl -fsSL https://hologram.os/native/bootstrap.sh | sh
#
# The link is content-addressed end to end. It resolves the release manifest (release.json), fetches
# the artifact for this OS (.dmg / .AppImage), RE-DERIVES its sha256 κ and REFUSES a mismatch
# (Law L5), installs/launches it; the host registers hologram:// so every later link is one click.
# The verify-run IS the install. With no pinned release it builds from source.
set -eu

# Baked-in default so the published one-liner stays clean. Points at this repo's release manifest;
# change the owner/repo here if you publish under a different name.
DEFAULT_RELEASE_URL="https://github.com/humuhumu33/hologram-apps/releases/latest/download/release.json"
RELEASE_URL="${HOLO_RELEASE_URL:-$DEFAULT_RELEASE_URL}"   # …/releases/latest/download/release.json
URL="${HOLO_NATIVE_URL:-}"
KAPPA="${HOLO_NATIVE_KAPPA:-}"
printf '\033[36mHologram - native boot\033[0m\n'

case "$(uname -s)" in Darwin) OS=mac ;; *) OS=nix ;; esac

build_from_source() {
  printf -- '-> building from source (Rust + Node + Tauri CLI)...\n'
  for t in cargo node npm; do command -v "$t" >/dev/null 2>&1 || { echo "missing prerequisite: $t" >&2; exit 1; }; done
  here="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)"; cd "$here"
  npm install; npm run build
  printf '\033[32mOK built. Bundle under src-tauri/target/release/bundle/.\033[0m\n'
}
sha256_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }
jget() { sed -n "s/.*\"$2\"[^\"]*\"\\([^\"]*\\)\".*/\\1/p"; }   # tiny JSON string-field extractor

# Resolve artifact + κ from the manifest (the per-OS block), unless an explicit pair was passed.
if [ -z "${1:-}" ] && { [ -z "$URL" ] || [ -z "$KAPPA" ]; } && [ -n "$RELEASE_URL" ]; then
  printf -- '-> resolving manifest %s\n' "$RELEASE_URL"
  manifest="$(curl -fsSL "$RELEASE_URL")"
  # isolate this OS's block ("mac":{…} or "nix":{…}) then pull its url + kappa.
  block="$(printf '%s' "$manifest" | tr -d '\n' | sed -n "s/.*\"$OS\"[[:space:]]*:[[:space:]]*{\\([^}]*\\)}.*/\\1/p")"
  URL="$(printf '%s' "$block" | jget x url)"
  KAPPA="$(printf '%s' "$block" | jget x kappa)"
fi

if [ "${1:-}" = "--from-source" ] || [ -z "$URL" ] || [ -z "$KAPPA" ]; then
  [ -z "$URL" ] || [ -z "$KAPPA" ] && printf '\033[33m(no pinned release - building locally)\033[0m\n'
  build_from_source; exit 0
fi

# ── fetch -> verify κ -> install/run ──────────────────────────────────────────────────────────────
tmp="${TMPDIR:-/tmp}/hologram.dl"
printf -- '-> fetching %s\n' "$URL"
curl -fsSL "$URL" -o "$tmp"
got="$(sha256_of "$tmp")"; want="$(printf '%s' "$KAPPA" | tr 'A-Z' 'a-z' | sed 's/^did:holo:sha256://')"
if [ "$got" != "$want" ]; then
  rm -f "$tmp"
  printf '\033[31mkappa MISMATCH - refusing to install.\n  expected %s\n  got      %s\033[0m\n' "$want" "$got" >&2
  exit 1                                                                              # Law L5: fail closed
fi
printf '\033[32mOK kappa verified  did:holo:sha256:%s\033[0m\n' "$got"

if [ "$OS" = "mac" ]; then
  printf -- '-> installing (mounting .dmg -> /Applications)...\n'
  vol="$(hdiutil attach -nobrowse -quiet "$tmp" | tail -1 | awk '{print $3}')"
  app="$(/bin/ls -d "$vol"/*.app 2>/dev/null | head -1)"
  [ -n "$app" ] && cp -R "$app" /Applications/ 2>/dev/null || sudo cp -R "$app" /Applications/
  hdiutil detach -quiet "$vol" || true
  open -a "$(basename "$app" .app)" || open "hologram://open"
else
  printf -- '-> launching (portable AppImage)...\n'
  chmod +x "$tmp"; exec "$tmp"
fi
printf '\033[32mDone. Hologram is now one click - paste a hologram:// link or use "Open in Hologram".\033[0m\n'
