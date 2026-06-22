# Contributing to Hologram apps

Each app under `apps/<id>/` is a content-addressed holospace, sealed by its
`holospace.lock.json`. The OS verifies every byte by re-derivation against the
seal (Law L5), so a change to an app's bytes must be accompanied by an updated
lock — otherwise the app fails closed at load.

## The laws (non-negotiable)

- **Content, not location** — identity is content; no host/path/URL as identity.
- **Verify by re-derivation** — every served byte re-derives to its κ, or is refused.
- **Authority only attenuates** — an app is a least-privilege guest; it never
  grants itself capability it was not given.

## Workflow

1. Change the app under `apps/<id>/`.
2. Re-seal it so `holospace.lock.json` matches the new bytes (the OS repo's
   relock tooling; the lock and the bytes must agree).
3. Commit using **Conventional Commits** (`feat:`, `fix:`, `chore:`, …).
4. Open a PR and fill in the template. Do not commit secrets — gitleaks runs on
   every PR.

## Native host

The native host lives in `apps/tauri/`. Releases are cut by tag (`native-v*`)
via `.github/workflows/native-release.yml`; each artifact's κ is re-derived and
attached as `release.json`. Signing keys are CI secrets, never committed.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — report privately, never in a public issue.
