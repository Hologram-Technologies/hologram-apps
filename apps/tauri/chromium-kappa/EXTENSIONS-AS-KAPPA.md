# Extensions as κ-addressable objects (design)

Goal: in the full chromium.git build, **every** Chrome extension — Web Store or sideloaded — is a
content-addressed, self-verifying κ object: identified by its κ, installed by κ, and re-derived (L5) on
every resource load. This layers on the full build (BUILD-RUNBOOK / KAPPA-INTEGRATION); it is out-of-band
(needs that build to exist). It reuses the existing `kappa-route` verifier and κ-store — no new crypto.

## The key fact we build on
Chromium ALREADY content-verifies extensions: `extensions/browser/content_verifier/` (`ContentHash`,
`content_verifier.cc`) checks each extension file at load against `_metadata/computed_hashes.json`
(per-file hash-tree leaves) rooted in `_metadata/verified_contents.json` (signed root hashes); on mismatch
the extension is disabled. So extensions are *already* a hash-verified subsystem — we make the hashes **κ**.

## κ model for an extension
An extension bundle (manifest.json + all files) → a content κ via the same κ algebra used for holospaces:
each file's κ (sha256 ⊕ blake3) + a root κ over the canonical file set. The extension's **identity is its
κ**; the κ-store holds the bundle content-addressed (free dedup across versions/users — SEC-3). A κ
**extension registry** (a `dcat`-style catalog, like the apps catalog) maps `ext κ → {name, version, perms}`.

## Install / load by κ
`install(κ)`:
1. resolve κ → the verified bundle from the κ-store (origin/mesh/local), re-deriving every chunk (L5);
2. materialize it to an extension dir (or serve via a custom loader) and hand it to Chromium's extension
   system (the same path `--load-extension` / the Web Store installer feed into).
Result: "install extension X" = "install κ<hex>". Any .crx / Web Store extension is first **ingested** →
assigned its κ → registered → installed by κ, so *all* extensions become κ objects uniformly.

## L5 verification — two integration options
**Option A (minimal patch, reuse Chrome's enforcer) — recommended first.**
At install, derive `_metadata/computed_hashes.json` (leaf hashes) + `_metadata/verified_contents.json`
(root, signed by a Hologram key) **from the κ manifest** (κ's sha256 axis == Chrome's hash format). Chrome's
existing `ContentHash`/`content_verifier` then enforces them on every load — extension disabled on any
tamper. Tiny patch: trust the Hologram signing key for verified_contents, and generate those files from κ
at ingest. Enforcement is upstream Chromium, unchanged.

**Option B (deeper κ-native) — the full substrate gate.**
Source expected hashes directly from `kappa-route` (patch `ContentHash` to read the κ manifest) and/or route
`chrome-extension://<id>/…` through a κ `URLLoaderFactory` (the same `RegisterNonNetwork…` seam as `holo://`,
applied to the extensions scheme) so each resource re-derives to its κ — **dual-axis (sha256 ⊕ blake3)** and
tied to the **closure anchor**, not just sha256. Stronger than Chrome's default (no network hash fetch; the κ
is the baked root) but more patch surface.

Recommendation: ship A (works with the unmodified enforcer, smallest fork), then move to B for dual-axis +
anchored guarantees once A is proven.

## "All extensions" + Web Store
The full `//chrome` build keeps the complete extension API surface + Web Store. Web Store installs are
intercepted at the install boundary → ingested to a κ → verified-contents regenerated from κ → installed by
κ. So Web Store compatibility is preserved AND every install is a κ object. (The id Chromium shows can stay
the key-derived id for compatibility; the κ is the canonical Hologram reference + the verification root.)

## Patch surface (on top of KAPPA-INTEGRATION)
1. `chrome/browser/extensions/…` install hook — ingest bundle → κ, register in the κ extension registry,
   (Option A) emit κ-derived `computed_hashes.json` + signed `verified_contents.json`.
2. Trust the Hologram verified-contents signing key (a key-pin patch in the content-verifier).
3. (Option B) `extensions/browser/content_verifier/content_hash.cc` — source expected hashes from
   `kr_resolve`; optionally a κ `ExtensionURLLoaderFactory`.
4. A κ extension registry (catalog) + an `install(κ)` entry point (UI: install/enable by κ).
Everything else — the extension runtime, APIs, Web Store — is upstream, unchanged. Reuses `kappa-route`.

## Honest scope
- Out-of-band: requires the full Chromium build (BUILD-RUNBOOK) first; this is an added patch layer + a
  maintained part of the fork.
- Option A is small and reuses Chrome's own enforcement (recommended MVP). Option B is the fully κ-faithful
  end state (dual-axis + closure anchor) at higher patch/maintenance cost.
- The κ algebra + verifier are reused verbatim from the substrate (`kappa-route`); no new crypto is written.

Sources: [chromium content_hash.h](https://chromium.googlesource.com/chromium/src/+/8ed923199807d58dff353246227099a5d803eef2/extensions/browser/content_verifier/content_hash.h),
[verified_contents.json (test data)](https://chromium.googlesource.com/chromium/src/+/66.0.3359.158/extensions/test/data/content_hash_fetcher/missing_verified_contents/verified_contents.json).
