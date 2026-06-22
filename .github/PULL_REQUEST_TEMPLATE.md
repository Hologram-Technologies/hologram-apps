<!-- Each app is sealed by its holospace.lock.json and verified by κ at load
     (Law L5). A PR is mergeable only when seals match the bytes and no secret is
     added. See CONTRIBUTING.md. -->

## What this changes

<!-- One paragraph. Name the app(s) under apps/<id>/ or apps/tauri. -->

## Checklist

- [ ] Commits follow **Conventional Commits**
- [ ] Every changed app's **`holospace.lock.json` matches its bytes** (re-sealed)
- [ ] No secret or key material added (gitleaks must pass)
- [ ] No location-as-identity introduced; the app opens/loads by κ
- [ ] Authority is only attenuated — the app requests no capability beyond what it needs
- [ ] (native host) builds for the affected platform(s); release stays κ-verified

## Verification

<!-- Re-seal output, witness counts, or browser/native proof where relevant. -->
