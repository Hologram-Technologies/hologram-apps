# hf-space-q-chat — the canonical standalone Q chat (WhatsApp UX, on-device, serverless)

Lives here (inside the `holo-apps` git repo) so it is **durably recoverable** — its git history is in
`holo-apps/.git`, OUTSIDE this dir, so even a full directory wipe is a one-command restore.

## If the working copy is wiped
```
cd <repo>/holo-apps
git restore hf-space-q-chat            # brings back every tracked file (app + engine + forge)
# then restore the git-ignored vendored voice runtime (exact copy, not in git):
cp -r ../holo-os/system/os/usr/lib/holo/voice/vendor/transformers hf-space-q-chat/vendor/
cp -r ../holo-os/system/os/usr/lib/holo/voice/vendor/kokoro       hf-space-q-chat/vendor/
```

## Run it
```
node hf-space-q-chat/_serve.mjs      # → http://localhost:8479/   (ROOT is self-relative — survives moves)
```
Or via the `whatsapp-q` launch config.

## What's here
- Authored (irreplaceable): `index.html`, `core/listen.js`, `core/voice-out.js`, `sw.js`, `icon.svg`,
  `manifest.webmanifest`, `_serve.mjs`.
- Base engine (snapshot from `holo-apps/apps/q`): `core/{engine,loader,kappa,semantic,q-self,holo-q-guards,holo-orb}.js`,
  `qvac-*.{js,mjs}`, `holo-*.mjs`, `pkg/`, `atlas12288.wasm`, `wallpaper.jpg`, plus `forge/*.mjs` deps.
- Vendored voice runtime (git-ignored, re-copyable): `vendor/{transformers,kokoro}`.

## Why it was moved here (2026-07-06)
It used to live at the repo TOP LEVEL (`HOLOGRAM/hf-space-q-chat`), which is not under any git repo — a
`holo build` run wiped the entire directory with no recovery path. Moving it under `holo-apps` (git) fixes
that permanently. It is NOT under `holo-apps/apps/` on purpose, so `make-dist` does not try to seal it as a
holospace. Model weights still stream 100% serverless from HuggingFace; nothing here needs a build.
