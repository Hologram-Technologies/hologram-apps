# Security Policy

Hologram apps are content-addressed: each app is sealed by its
`holospace.lock.json`, and every byte is re-derived against its κ before use —
by the OS Service Worker at runtime and by the native host at install (Law L5).
A byte that does not re-derive is refused.

## Reporting a vulnerability

**Do not open a public issue.** Report privately via a GitHub security advisory:

- https://github.com/Hologram-Technologies/hologram-apps/security/advisories/new

Include the affected app, a reproduction, and the platform (browser peer or
native host). We aim to acknowledge within a few business days.

## In scope

- An app's served bytes not matching its `holospace.lock.json` seal (integrity).
- An app gaining authority beyond what it was granted, or authority that
  amplifies rather than only attenuates.
- Recovering operator key material, or any secret committed to the tree.
- A native release artifact whose κ does not match its `release.json` manifest.

## Secrets

No secret or key material is ever committed; commits and PRs are scanned with
gitleaks (`.gitleaks.toml`, `.github/workflows/security.yml`). Signing keys for
the native host are provided to CI as repo secrets, never committed. If you
believe a secret was committed, treat it as compromised, rotate it, and report
privately.
