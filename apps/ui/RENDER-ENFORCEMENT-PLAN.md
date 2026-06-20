# Canonical κ→render path — substrate-wide enforcement plan

Goal: one render path — `render(κ) → display` — is the universal way every object, app, and the
shell itself is mounted, each addressed by a self-verifying content hash (κ = `did:holo:sha256`).
Lean, low-latency, no compiler on the hot path, no duplicate resolution processes.

This doc is the staged route. Each stage is finished only when its witness + the W3C gate are green.
Greenlight stages one at a time.

---

## Architecture truth (why this is staged, not one push)

Two layers already exist and must not be conflated:

- **Resolution layer — already universal.** Every byte the shell and every app load already flows
  through `os/holo-resolver.mjs::resolveByKappa` (re-derive or refuse, Law L5), via the per-app SW
  (`os/holo-sw.js`) and the OS-wide SW (`os/holo-boot-sw.js`). "Resolved from its κ" is already
  enforced substrate-wide.
- **Mount layer — isolation is load-bearing.** Apps run as **sandboxed iframes** (`os/holo-launch.mjs`
  + `holospace.html`, Law L1). They CANNOT be `import()`ed into the shell page and rendered there —
  that would dissolve the security boundary. So "one render() call for every app" is false at the page
  level. The unification is: **inside each isolation boundary (the shell page, and each app page), the
  in-page DOM render of objects goes through one primitive — `holo-render.js`.**

So "enforce render everywhere" = (a) one DOM-render primitive used by the shell and inside every app,
and (b) that primitive rides the existing resolver instead of carrying its own.

---

## Stage 1 — DONE ✓ (renderer rides the one resolver)

- `apps/ui/vendor/runtime/holo-render.js` — the canonical DOM-render primitive: `resolve` (arena L1
  cache) · `module` (parse-once) · `element`/`render` · `bundle`/`unbundle`. Lazy React, never imports
  esbuild.
- Resolution **delegates** to an injectable canonical `resolveByKappa` (`configure({resolver})`); the
  inline path is an explicitly-labelled standalone fallback only — no second resolution policy.
- Composition objects (`registry/bundles/*.json`) addressed by κ of canonical bytes; nest infinitely.
- Witness `apps/ui/holo-render-witness.mjs` — **149/149** (resolve re-derives byte-for-byte, tamper
  refused, L3 dedup, full unbundle to leaf modules, compiler-free, lazy-React, delegates to resolver).
- Live: warm rebind ≈ 0.04 ms, cold ≈ 0.2 ms, forged κ refused.

---

## Stage 2 — shell-as-object (the shell renders its own chrome via the path)

**Intent.** The shell (today: `os/apps/workspace` + `os/holospace.html`, NOT `atlas96`) becomes a
κ-addressed object that renders its own dock / desktop / window-frame chrome through `holo-render`,
with the canonical `resolveByKappa` injected. Decide naming first: keep "workspace/shell" or formally
rename the shell to "ATLAS96" (a rename touches every decider that routes to the shell — see
memory `canonical-shell-os2`; recommend keeping "shell" and treating ATLAS96 as a theme/identity, not
a rename, to avoid a wide router cascade).

**Mechanism.**
1. Promote `holo-render.js` to the canonical bound runtime: `os/usr/lib/holo/holo-render.js` (single
   home, per the no-duplicates runtime invariant). Apps/shell BIND via `holospace.json` `shared`, never
   copy.
2. In the shell boot, `configure({ resolver: (k)=>resolveByKappa(k, sources, store) })` using the real
   `os/holo-resolver.mjs` + `os/holo-sources.mjs` chain — so the shell's own UI resolves through the
   spine.
3. Re-express the shell chrome (dock items, desktop icons, frame) as render specs / bundle objects
   mounted by `holo-render` instead of bespoke DOM glue.
4. Seal the shell as a UOR object (`holo-object.mjs::seal`) → the shell has a κ; `verify` re-derives it.

**Files touched.** `os/usr/lib/holo/holo-render.js` (new bound copy), `os/holospace.html` and/or
`os/apps/workspace/index.html` (boot wiring), the shell chrome module(s), shell `holospace.json`
(`shared` += holo-render).

**Cascade cost.** Editing the shell → `seal` (shell-canonical witness) + relock workspace + os-closure
reconcile + apps-witness. Adding a bound runtime file → `holo-runtime-witness` (#runtime row) must see
exactly one canonical copy. Re-seal PM only if a Merkle-linked source changed (it shouldn't).

**Witness / gate.** Extend `holo-render-witness` to assert the shell object re-derives to its κ and the
shell boot injects the canonical resolver. Gate rows: `#runtime` (one canonical copy), `#shell-canonical`
(shell seals), existing app-lock gate.

**Risk.** Medium. Shell edits are the highest-blast-radius change in the repo. Mitigation: render chrome
behind a feature flag first, diff the rendered DOM against current, flip only when identical.

**Rollback.** Revert the boot wiring; the bound runtime file is inert until imported.

---

## Stage 3 — per-app adoption (every native app renders in-page via holo-render)

**Intent.** Each of the ~34 native apps drops its own ad-hoc dynamic-import / mount glue and uses
`holo-render` for in-page object rendering (the Forge `fromK`, the UI gallery, any app that imports a
module by κ or mounts components).

**Mechanism (per app, idempotent).**
1. Add `holo-render` to the app's `holospace.json` `shared`; bind (don't copy).
2. Replace the app's bespoke "fetch bytes by κ → import → mount" with `HoloRender.render(el, κ)` /
   `HoloRender.module(κ)`.
3. `relock-app` (regenerate `holospace.lock.json`) → `apps-witness` → index.

**Order (lowest-risk first).** `ui` (already the registry home) → `forge` (retire its `fromK`, point at
holo-render; re-pin if the TS panel's compiler κ is part of a sealed witness) → leaf apps with simple
component rendering → complex apps (code, workspace IDE, q) last.

**Files touched.** Each app's `index.html` / engine JS + its `holospace.json` + regenerated
`holospace.lock.json`; `os/apps/index.jsonld`.

**Cascade cost.** Per app: relock + apps-witness + index. Editing `forge` also re-pins its witness
(memory: editing holo-forge.mjs → re-pin PIN.compiler + relock-forge). Batch relock at the end.

**Witness / gate.** A new `render-adoption-witness` greps every app entry for the legacy mount patterns
(`new WebAssembly.Instance` for UI mount, hand-rolled `import(blobURL)` render, per-app κ re-hash) and
asserts they route through `holo-render` (carrier + inherit, like the UX-adoption witness). Gate row
`#render-adoption`. Existing `app-locks` gate must stay green (relock everything touched).

**Risk.** Medium, spread thin. Each app is independently revertible; the witness catches regressions.

**Rollback.** Per-app revert + relock that app.

---

## Stage 4 — remove duplicate resolution processes

**Intent.** Collapse the parallel resolve/import mechanisms onto the one spine.

**Targets (from the inventory).**
- `os/holo-sw.js` + `os/holo-boot-sw.js`: already call `resolveByKappa`; remove any inline re-derive /
  source logic that duplicates `holo-resolver.mjs` so the SW is a thin shell over the core. (Low risk —
  mostly deletion of dead duplication.)
- `os/tools/gen-imports.mjs`: compile-time `_shared/X → /.holo/sha256/<κ>` rewriting. Keep for now —
  it is the build-time pin that makes the SW route work; only retire if the importmap-at-runtime path
  fully replaces it (defer; it is NOT a render duplicate, it is the resolution surface generator).
- `apps/tauri/dist/usr/lib/holo/holo-forge/holo-kstore.mjs` (browser IndexedDB κ-store): wire as the
  **L2 persistence** under `holo-render`'s ARENA (L1), not a parallel store. ARENA → kstore → resolver.
- Keep distinct (NOT duplicates): `ipfs-sw.js` (IPFS gateway), `holo-resolve.mjs` (open-data semantic
  resolver), `holo-prov.mjs` (provenance), `kstore.mjs`/`kdisk.mjs` (Node offline tools),
  `qvac-kstore.mjs` (model-weight block reader; may call resolver).

**Mechanism.** Make `holo-render.resolve` the single page-side entry; its source order = ARENA(L1) →
kstore(L2) → injected `resolveByKappa`(multi-source). Delete the duplicated re-derive bodies in the SWs.

**Cascade cost.** SW edits → boot-witness + offline/sovereign witnesses. kstore wiring → forge re-pin +
relock-forge.

**Witness / gate.** `holo-resolver-witness` (exists) must still pass; add a "single re-derive site"
witness asserting `reDerive` is defined once (in `holo-resolver.mjs`) and every other module imports it.
Gate rows: `#runtime`, boot/offline witnesses.

**Risk.** Low–medium; mostly deletion guarded by existing resolver/boot witnesses.

**Rollback.** Revert per file; the core resolver is untouched throughout.

---

## Invariants enforced after all stages

- One `reDerive` / `resolveByKappa` in the substrate (`os/holo-resolver.mjs`); everything imports it.
- One DOM-render primitive (`holo-render.js`), bound once at `os/usr/lib/holo`, used by the shell and
  inside every app.
- The shell and every app + bundle is a κ-sealed object that `verify`s by re-derivation.
- No compiler on any display path. Compilation is one-time provenance, addressed by κ thereafter.
- Apps stay sandboxed iframes (isolation preserved); unification is within each boundary.

## Sequencing & gate discipline

Stage 2 → review → Stage 3 (app by app) → review → Stage 4. Never relock/seal more than one logical
change before running the gate. Each stage ships its own witness + gate row; the prior rows stay green.
