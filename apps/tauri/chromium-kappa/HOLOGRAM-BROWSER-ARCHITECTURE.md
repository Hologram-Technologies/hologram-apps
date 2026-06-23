# Hologram OS as the browser — fusing the stack into the κ-native Chromium

Self-reflection (read the tree, cited) → architecture. Verdict: **the hard parts exist and are witnessed**
(Q Mixture-of-Specialists, the + ambient hypergraph, PQC identity + display-split, TEE step-up host-gate,
wallet WDK seam, privacy/terms/conscience governance, local-κ telemetry, the κ-route host). The work is
**elevation + binding through ONE browser seam — not rebuilding.** Reuse-first.

## Task 1 — stack map (evidence, real unless noted)
- **κ substrate (host):** `cef-host/src/kappa_scheme.cc:43` dual-axis L5 verify; `app.cc:18-22,38-46` holo
  scheme + `kr_store_open(root,anchor)`; COOP/COEP per-κ origin `kappa_scheme.cc:48-63`. REAL.
- **Q:** `holo-q-mux.js:24-46,131-159` MoS router (real); `holo-q-route.mjs:28-82` classify→faculty→stream;
  `holo-q-app.js:1-118` **cross-frame governed bridge (the existing seam)**; `holo-q.js:275` `installQ`→`window.Q`;
  `holo-spine-boot.mjs:119+` ambient loop. **Gap:** top-frame-only; no per-tab context capture; brain not κ-disk-shareable across tabs.
- **The +:** `holo-plus.mjs:1-56` ingest→map→insight→brief; `holo-map.mjs:37-59` κ-hypergraph (dedup by identity/claim κ);
  `holo-plus-q.mjs:18-87` fuses voice+text doors → one grounding → `Q.addGrounding`. REAL, local.
- **Identity:** `holo-pqc.mjs` Ed25519‖ML-DSA + ML-KEM (real); `holo-identity.mjs:200-251` **display-split**
  (`holo.identity` = κ+label only ‖ `holo.session.wrapped` AES-GCM); apps never see the key. REAL.
- **Wallet:** `holo-wallet-agent.mjs:40-223` WDK tool surface, cap read<sign<spend, default-deny govern;
  `holo-wallet-bridge.js` BroadcastChannel gated seam. No `window.HoloWallet`. REAL (some tools needs-seam/planned, honest).
- **TEE/step-up:** `holo-stepup.mjs:43-181` challenge = action κ, VALUE/REVEAL always, AUTHORITY windowed;
  `holo-stepup-gate.mjs:28-52` **host-side enforce()**, host computes the action κ (app can't forge);
  `holo-webauthn.mjs` TEE PRF. REAL + witnessed.
- **Governance:** `holo-terms.js:132-178` MyTerms gate, `effective = declared ∩ granted` (fail-closed);
  `holo-privacy.js:246-444` disclosure broker (cross-origin), VP records re-derive (L5);
  `holo-conscience.js:94-223` constitution + output court; `holo-gov.js:34-95` host broker, **un-forgeable
  recipient stamping**, `q.remote`/CDP routing. Gates run BEFORE mount. REAL. **Gap:** web-nav gate not wired.
- **Telemetry:** `holo-telemetry-tap.mjs:26,44-163` local-only, content-addressed spans, **default-deny egress**
  (SEC-7), observeIngest/observeRefusal. REAL.

## Task 2 — the ONE seam
A **browser-process Hologram Service** (holds: κ-store [done], sealed operator session, Q mux + one shared
κ-disk brain, governance state, the local telemetry tap) + a **per-tab privileged bridge**, ELEVATING the
existing `holo-q-app ↔ holo-gov` postMessage + `holo-wallet-bridge` BroadcastChannel + `holo-stepup-gate`
host pattern from "shell mediates iframes" to "browser process mediates tabs."

Origin-tiered exposure (SEC-2/SEC-5): **holo://<κ>** → full governed API attenuated by the tab's κ identity +
granted caps; **https:// web** → nothing by default (governance applies *to* it, not the reverse); **κ
extensions** → attenuated by declared∩granted perms. The host computes every action κ from its **trusted
view** (`holo-stepup-gate.mjs:47`), so tabs/web/extensions cannot forge intent or consent.

Seam (every arrow fail-closed, L5/SEC-1):
```
intent (omnibox · voice · new-tab · "+")
   → Q mux (holo-q-mux faculty)                      [Task 3]
   → proposed action / surface
   → GOVERNANCE gate  (terms.effective ∩ · privacy.gate · conscience.evaluate)   [Task 5]
   → TEE/IDENTITY gate (stepup-gate.enforce; action κ; key never leaves)          [Task 4]
   → κ-VERIFY (kr_resolve dual-axis, per-κ origin, closure anchor)                [substrate]
   → render / κ-stream / act
telemetry → local κ tap (default-deny egress)                                     [Task 5]
```

## Task 3 — Q as the spine
- Omnibox + new-tab = intent input: `classifyIntent` (`holo-q.js:36`, pure) resolves navigate/open-κ/ask/build
  without a model; voice via `holo-q-mobile.mjs`/`holo-voice.js`. Route real work through `holo-q-mux`.
- **Per-tab private context** (the small new binding): a read-only grounding provider per tab (mirror
  `holo-q-app.appContext`) feeding the **one** browser Q; the + ingest→`holo-map` hypergraph→`holo-insight`
  scoped per tab, **local only**.
- Shared brain: one κ-disk brain in the service (fixes the per-tab cold-load gap), bridge-called.
- Autonomous/self-evolving: `holo-spine` ambient loop + `holo-brief` proactive; learns from the local
  hypergraph; **every outward/irreversible Q act passes conscience + step-up**; never phones home.

## Task 4 — security native
Move `holo-stepup-gate.enforce()` into the service as the **browser-level gate** for VALUE (send/sign/swap),
REVEAL (mnemonic), AUTHORITY (delegation), and permission grants — across web + holo + AI. One human-gated
seam (wallet + identity + perms converge on one `enforce()`); operator unlocks once (TEE-PRF), key stays
non-extractable host-side; tabs read only the sealed session presentation (κ+label). SEC-2 via
`holo-delegate` attenuation; SEC-4 κ identity; SEC-5 per-κ origin.

## Task 5 — governance everywhere
Bind `terms.gate`/`privacy.gate`/`conscience.evaluate` at the browser policy boundary so EVERY surface is
judged: holo apps (before mount — already), **web navigations (NEW: at `OnBeforeBrowse` + the κ/web
URLLoaderFactory → the same gate stack)**, extensions (declared ∩ granted perms), AI (Q outward actions →
conscience). Telemetry → `holo-telemetry-tap` local κ, egress default-deny (SEC-7). The user's standing
policy shapes the entire web/holo/AI experience; verdicts are re-derivable VCs (auditable, never downgraded).

## Task 6 — personal real-time internet + κ-streaming
κ-address streaming = the κ factory's by-κ, per-block-L5 path, extended: Q composes a **surface manifest**
(a holospace def) from intent + private context + device tier (reuse `holo-q.create` + device-tier + the
proven serverless κ-LLM/weight-streaming), streamed by κ and rendered adaptively. Web content can be
re-rendered/transformed by Q behind the governance gate. "Personal internet": same intent → a κ-surface
assembled live for *this* user, privately (context never leaves the device).

## Task 7 — abstraction + phased plan (reuse-first, witness-gated)
Surface = one bar: type/speak intent → Q navigates web / opens a holo app by κ / composes a surface / answers
/ acts. κ-verify, governance, step-up, streaming are hidden; only consent cards + biometrics surface on need.
- **P1 Service + bridge:** browser-process Hologram Service; governed bridge API on holo:// origins (deny web
  by default). Witness: holo tab reaches Q/governance through the bridge; web tab refused.
- **P2 Q spine:** omnibox/new-tab intent → `holo-q-mux`; per-tab context provider; shared brain. Witness: intent → faculty → action.
- **P3 Step-up gate:** `stepup-gate.enforce` in the service; wallet/identity via the one seam. Witness: VALUE act → biometric; key never leaves.
- **P4 Governance layer:** terms/privacy/conscience at OnBeforeBrowse + factory + ext perms; telemetry local-κ. Witness: a web nav consults the gate; no egress.
- **P5 κ-streaming surfaces:** Q composes + κ-streams a surface from intent+context+device, per-block L5. Witness: a composed surface renders adaptively.
Each phase extends `CONFORMANCE.md` and conforms to L1–L5 / SEC-1..8.

## Honest boundary
- Does NOT exist yet: the browser-level Q fiber, top-level per-tab context capture, shared-brain-across-tabs,
  the web-navigation governance gate (today governance gates κ-mounts only). These are the net-new bindings.
- Most novel/unproven: Q-composed κ-streaming surfaces and fully autonomous Q.
- Runtime boundary: the production host is the full chromium.git build (out-of-band, build farm); the bridge +
  Q + governance can be prototyped on the CEF host for holo:// today. The bridge's web-vs-holo trust boundary
  is the critical security design risk — get SEC-2/SEC-5 attenuation right or a web origin could reach Q/wallet.
