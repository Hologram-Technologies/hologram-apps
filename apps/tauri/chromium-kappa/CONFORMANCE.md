# Conformance — holospaces laws · CC-*/vv discipline · → κ-native Chromium patch points

## Conformance authority (verified against the LIVE repo, github.com/Hologram-Technologies/holospaces)
Fetched + reconciled 2026-06-22 (P0, conformance-first). Corrections to earlier assumptions:
- **The 5 laws are CONFIRMED verbatim** (AGENTS.md "The Five Non-Negotiable Laws") and map 1:1 to the
  L1–L5 rows below: L1 content-not-location, L2 canonical-forms-only ("hold κ-labels, not objects"),
  L3 store-is-memory ("KappaStore is the address space; RAM only cache"), L4 everything-through-substrate
  ("no parallel memory/storage/network/runtime paths"), L5 verify-by-re-derivation. These ARE the binding
  runtime invariants — the table below is valid against them.
- **"SEC-1..8" is NOT the repo's canonical structure** — it is a derived security decomposition kept here
  as an engineering aid. The repo's binding authority is: `docs/` (arc42 / C4 / OPM ISO 19450 / ISO 15288)
  + the 5 laws + the conformance discipline below. Do not present SEC-n as if repo-canonical.
- **Conformance mechanism = the CC-* catalog + `vv/`** (BDD): each capability is a `CC-*` row realizing an
  OPM process; a "live" row has a GREEN witness in `vv/suites/`; unfinished work is a "target" row with an
  **expected-RED suite written BEFORE implementation** in `vv/targets/`, promoted to live on green. HARD
  rules: no stubs / no-ops / placeholders; never claim parity without V&V proof; status lives only in
  catalog rows + V&V + CI + git, never in narrative.
- **External ground truth (not self-reference):** validate against imported external artifacts — **σ-axis
  KAT vectors, TCK substrate tests, native hologram outputs**. CONCRETE GAP for this browser: kappa-route
  currently passes its OWN witnesses; to conform it must be witnessed against the substrate's σ-axis KAT
  vectors + TCK (the blake3 σ-axis and sha256 axis re-derivation must match the substrate's KATs), as a
  `CC-*` row with a `vv/` suite — not self-tests. This is the top conformance to-do for criterion F.
- **V1–V8 are DOCUMENTATION validators** (arc42 structure · Structurizr · CommonMark/GFM · GitHub-markup ·
  OPL syntax · OPD↔OPL coherence · ISO 15288 superset), run by `scripts/validate.sh`. They gate spec
  quality, NOT runtime security — do not conflate them with the laws.

Base engine: **ungoogled-chromium** (Google-free; see GOOGLE-FREE.md). The κ overlay (`ungoogled/`) adds the
seams below; content-blind egress + the de-Google posture are inherited from ungoogled's domain-substitution
+ pruning + patch set. The build runs ungoogled's own pipeline verbatim, then the overlay (BUILD-RUNBOOK.md).

How the full-Chromium κ-native build satisfies each binding rule. "Mechanism" reuses the existing
`kappa-route` verifier (proven); "Where" is the patch point in the chromium fork (see KAPPA-INTEGRATION.md
/ EXTENSIONS-AS-KAPPA.md). Status: **REUSED** = already implemented+witnessed in kappa-route; **PATCH** =
minimal fork hook that calls it; **CONFIG** = upstream feature configured.

| Rule | Requirement | Mechanism | Where | Status |
|---|---|---|---|---|
| **L1** content-not-location | identity is κ, never path/host | `holo://<κ>` host = the holospace κ; resolve by κ, not location | `kappa-route::resolve_rel`; scheme reg (KAPPA-INTEG §1) | REUSED + PATCH |
| **L2** canonical forms only | κ over canonical bytes | sha256⊕blake3 of canonical file bytes; sealed by `make-dist` | `kappa-route` (sha256_hex/blake3_hex); dist seal | REUSED |
| **L3** store-is-memory | resolution = page fault; RAM = bounded cache | by-κ cache of verified bytes; κ-store/OPFS tier | `kappa-route::KStore.cache` | REUSED |
| **L4** everything through substrate | no parallel unverified path | every `holo://` nav+subresource+worker through the κ factory; every extension file through content_verifier | `RegisterNonNetwork{Navigation,Subresource}URLLoaderFactories`; `content_verifier` | PATCH |
| **L5** verify by re-derivation | refuse any byte not re-deriving to its κ | `kr_resolve` re-derives both axes before render; extension `ContentHash` re-derives each file | κ `URLLoaderFactory`; `content_hash.cc` (EXT §B) | REUSED + PATCH |
| **SEC-1** integrity | tamper fails verification | mismatch → `net::ERR_*`/refuse; manifest tamper → poisoned store refuses ALL (closure anchor) | factory + `kr_store_open(root,anchor)` | REUSED + PATCH |
| **SEC-2** authority, attenuation-only | object-capabilities, no escalation | Chromium extension permissions = capability grants (declared ∩ user-granted), attenuating; holospace capability sets per holo-apps | upstream extension perms (CONFIG) + holo-apps capability gate | CONFIG |
| **SEC-3** dedup | identical content → one κ | by-κ index keyed on sha256; identical extension bundles share one κ entry | `kappa-route::byhex`; κ ext registry | REUSED |
| **SEC-4** unforgeable identity | self-sovereign, deterministic from content/key | extension identity = its κ (content-derived, unforgeable); operator identity = existing PQC κ | κ ext registry; `holo-pqc` (existing) | REUSED |
| **SEC-5** κ is the capability to perceive | unknown κ unreachable; per-frame isolation | unknown κ → 404; `holo://<κ>` distinct tuple origins → Chromium process/storage/SW isolation | `resolve_rel` (None→404); standard-scheme origins | REUSED + CONFIG |
| **SEC-6** verify on the κ's own axis | verified-vs-claimed on the declared axis | dual-axis: `/.holo/sha256\|blake3/<hex>` re-derives on the requested axis | `kappa-route::resolve_rel` content route | REUSED |
| **SEC-7** egress content-blind | egress forwards opaque bytes, never perceives | κ factory serves LOCAL verified bytes only (no egress); web egress = Chromium's network stack (opaque passthrough); no κ inspection of web traffic | architectural (factory is local-only) | CONFIG |
| **SEC-8** resource bounds | DoS resistance; bounded allocations | `kr_resolve` allocation bounded by pinned byte count; extension bundle size cap at ingest; Chromium's own resource limits | `kappa-route`; ingest cap (EXT) | REUSED + PATCH |
| **holo-apps**: addressing | apps/holospaces addressed by `@id` κ | catalog `dcat:dataset` `@id` → dir; extensions registered the same way (κ registry) | `kappa-route::apps`; κ ext registry | REUSED + PATCH |
| **holo-apps**: sealing | sealed closure + anchor | `make-dist` dual-axis seal + baked `CLOSURE_KAPPA` | dist seal; anchor in factory init | REUSED |
| **holo-apps**: verification | verify before mount/run | L5 in the factory + content_verifier before any byte renders/executes | (= L5 row) | REUSED + PATCH |

## Reading
- **REUSED rows are done** (in `kappa-route`, witnessed: dual-axis verify, fail-closed, by-κ cache, content-route, closure anchor, per-κ origins). The fork only *calls* them.
- **PATCH rows** are the minimal fork hooks (scheme reg + 2 URLLoaderFactory registrations + the content_verifier hook + the ext-ingest install hook) — no new crypto.
- **CONFIG rows** are upstream Chromium features (extension permissions, origin isolation, network stack) used as-is.
- This keeps "no handwriting / feature-complete upstream" true: the verifier is reused, the browser+extensions are upstream, the fork is a thin κ seam.

## Build-host note
The actual build is build-machine/CI work (see BUILD-RUNBOOK). Readiness checked 2026-06-22 on the dev box:
git✓, python✓, but **no pinned VS2022+SDK** (only VS18 Insiders, which Chromium rejects) and **~122 GB free**
(below the ~120–150 GB need alongside the existing tree). Provision a dedicated build host: pinned VS2022 +
Windows SDK per `build/vs_toolchain.py`, ~200 GB free, 16–32 GB RAM. The link artifact (`holo/lib/kappa_route.lib`
+ `holo/include/kappa_route.h`) is staged and ready for the GN target.
