# Hologram — native host

> Lives in the **Hologram Apps** repo at `apps/tauri/` (kept out of the lean OS2 repo). It builds its
> image FROM the sibling **Hologram OS2** repo — both are referenced by absolute path (overridable via
> `HOLO_OS2_DIR` / `HOLO_APPS_DIR`), and CI checks both out side by side.

The native tier of Hologram OS2. A [Tauri v2](https://github.com/tauri-apps/tauri) shell that boots
the content-addressed OS straight from `holo://` — **no Chrome, no CORS wall, a real shell +
filesystem underneath**. This is the "spaceship": the thinnest possible window onto the UOR
content-addressable substrate, where an app, a holospace, the live web, a `holo://κ` and an IPFS CID
are all one kind of thing — an object, fetched, re-derived, and verified before it runs.

## What makes it "100% native to the substrate"

The only first-party Rust in this crate is one thing: the **`holo://` URI scheme**
([`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)). It is the native **κ-route**. Every byte the
webview loads is resolved by path from a flat, self-sealed OS image and **re-derived to its content
address (sha256) before it is served** — holospaces **Law L5**. A tampered byte is refused,
fail-closed. So the guarantee a sandboxed browser can't give — *the bytes running on your machine
are exactly the bytes that were sealed* — is enforced in the host itself.

Everything else is canonical Tauri, used verbatim per the spec (no hand-rolled webview, IPC, or
build). The official plugins supply the native powers the browser tier had to fake:

| plugin | gives the OS |
|---|---|
| `deep-link` | `hologram://` · `web+hologram://` · `holo://` — one link boots the host and opens an object |
| `shell` | a real terminal |
| `fs` | the real filesystem (beyond OPFS) |
| `http` | live web with **no CORS** — the dev `/web` proxy disappears |
| `opener` | hand a URL to the system browser when asked ("Open in Chromium ↗") |

## Layout

```
apps/tauri/             # in the Hologram Apps repo
├─ make-dist.mjs        # flatten Hologram OS2's os/ (FHS) → dist/ (flat URL space) and SELF-SEAL it (Law L5)
├─ serve-dist.mjs       # preview dist/ over HTTP with the EXACT contract lib.rs implements (no Rust needed)
├─ bootstrap.ps1 / .sh  # single-link boot: fetch → re-derive κ → refuse on mismatch → run
├─ frontend/index.html  # one-frame splash (the real window loads holo://os/apps/browser/index.html)
└─ src-tauri/
   ├─ Cargo.toml        # the standard src-tauri crate (Tauri core + official plugins)
   ├─ tauri.conf.json   # v2 config — identifier, CSP, deep-link schemes, bundle (embeds dist/)
   ├─ build.rs          # tauri_build::build()
   ├─ capabilities/     # least-privilege permission set for the main window
   └─ src/
      ├─ main.rs        # thin desktop entry → hologram_lib::run()
      └─ lib.rs         # the holo:// κ-route + deep links + plugins + the fullscreen window
```

## The flat image (`dist/`)

The OS lives FHS-shaped (`system/os/usr/lib/holo/…`) but apps speak a flat URL space (`/_shared/…`,
`/apps/<id>/…`, `/home.html`). The dev server bridges the two live via `os/lib/holo-fhs-map.mjs`;
`make-dist.mjs` materializes that bridge **ahead of time** into `dist/`, so the host is a dumb, fast,
content-verifying file reader with no mapping logic to drift. It then **re-derives a κ for every
byte** and writes `dist/os-closure.json` — a self-consistent, tamper-evident manifest of the exact
image shipped. (It also cross-checks each pin against the canonical OS closure and reports drift:
files newer than the OS's last reseal — dev-in-flight, expected, not tamper.) Heavy *data* (model
κ-disks, demo media) is excluded — those are fetched on demand by κ, keeping the image lean (~74 MB,
mostly the Monaco IDE + the QVAC engine).

## Develop

```
npm install
npm run dev          # make-dist + tauri dev  (needs Rust + the Tauri CLI)
```

No Rust toolchain? Preview the exact native image in any browser — `serve-dist.mjs` mirrors the host
byte-for-byte (flat read · `os/` strip · `_shared`/`pkg` collapse · Law-L5 verify · COI headers):

```
node make-dist.mjs && node serve-dist.mjs    # → http://127.0.0.1:8400/
```

## Build a bundle

```
npm run tauri icon icons/icon.png            # one-time: generate the platform icon set
npm run build                                # make-dist + tauri build → src-tauri/target/release/bundle/
```

## Distribute (the single link)

`bootstrap.ps1` / `bootstrap.sh` are the one-click-forever path. They fetch the released host binary,
**re-derive its sha256 κ and refuse to run on a mismatch** (Law L5), then launch it once — the host
registers `hologram://` so every later link is instant. The verify-and-run *is* the install.

```
# Windows
irm https://raw.githubusercontent.com/humuhumu33/hologram-apps/master/apps/tauri/bootstrap.ps1 | iex
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/humuhumu33/hologram-apps/master/apps/tauri/bootstrap.sh | sh
```

(Swap `humuhumu33/hologram-apps` if you publish under a different name — that string appears in
`bootstrap.ps1`, `bootstrap.sh`, and the browser's install popover.) With no release pinned yet, both
scripts fall back to a from-source build.

## Cut a release (signed, κ-pinned, all platforms)

The whole pipeline is one tag push. [`native-release.yml`](../.github/workflows/native-release.yml)
uses the official `tauri-action` to build + bundle on macOS, Linux and Windows, uploads the installers
to a GitHub Release, then `pin-release.mjs` re-derives each artifact's sha256 κ and attaches
`release.json` (the manifest the bootstrap resolves — see `release.json.example` for the shape).

```
git tag native-v0.1.0
git push origin native-v0.1.0          # → builds, releases, and pins κ for win/mac/linux
```

Then make the single link clean: set `$DefaultReleaseUrl` / `DEFAULT_RELEASE_URL` in the bootstrap
scripts to `https://github.com/<owner>/<repo>/releases/latest/download/release.json`. Now
`irm …/bootstrap.ps1 | iex` fetches the manifest, verifies the κ, and installs — no env vars, no Rust.

**Signing is optional.** With no certificates the binaries still install and are κ-verified (integrity
holds — the bytes match what was published), they just show the OS "unknown publisher" prompt. To ship
warning-free, add these repo secrets (the workflow already wires them):

| secret | for |
|---|---|
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | macOS sign + notarize |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the future auto-updater's signature |

Windows Authenticode signing: set `bundle.windows.certificateThumbprint` in `tauri.conf.json` (or sign
the artifact in a workflow step) with your code-signing cert.

> **κ-verification ≠ code-signing.** The bootstrap's sha256 κ check guarantees *the bytes you run are
> exactly the bytes that were published* (Law L5) — that holds with or without a cert. OS code-signing
> additionally removes the "unknown publisher" warning. They are complementary.

See **ADR-0063** (`Hologram OS2/system/docs/adr/0063-holo-native.md`) for the full rationale.
