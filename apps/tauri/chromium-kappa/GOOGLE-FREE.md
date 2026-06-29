# Google-free guarantees (ungoogled-chromium base)

Source: https://github.com/ungoogled-software/ungoogled-chromium

The Hologram browser is **Google-free by construction** because it builds on ungoogled-chromium, not by
our own de-Googling. ungoogled removes Google at the *source* level — not via runtime settings that can be
flipped — and our overlay only adds the κ substrate + branding. This file records what that buys, how it is
enforced, and the one honest trade-off.

## How ungoogled removes Google (their mechanism, used verbatim)
- **Domain substitution** (`domain_substitution.py` + `domain_substitution.list` / `domain_regex.list`):
  every Google web domain baked into the source is rewritten to the unreachable sink `qjz9zk`, so even a
  missed code path *cannot* reach Google — the address does not resolve.
- **Binary pruning** (`prune_binaries.py` + `pruning.list`): the prebuilt proprietary blobs Google ships in
  the tree are stripped; the build is from inspectable source.
- **Patch set** (`patches.py apply … patches`): removes/neutralises Safe Browsing pings, the Google account
  & sync integration, field trials / variations, UMA/metrics, the promo + "first run to Google" flows, etc.
- **Flags**: many `chrome://flags` + command-line switches default to the private choice.

## What our overlay asserts on top (holo-flags.gn — additive, regression-proof)
These restate the Google-free knobs as GN args so a milestone rebase can never silently re-enable them:
`use_official_google_api_keys=false`, `safe_browsing_mode=0`, `enable_hangout_services_extension=false`,
`enable_mdns=false`, `enable_reporting=false`, `enable_remoting=false`, empty `google_api_key` /
`google_default_client_id` / `google_default_client_secret`. Plus `is_official_build=true` (release) and
`proprietary_codecs=true` / `ffmpeg_branding="Chrome"` so open media still works.

## Serverless + private + κ-rooted (the Hologram half)
- **No phone-home for content**: `holo://` bytes are served by the in-process κ verifier (`kr_resolve`) from
  the local sealed image — no network, no CDN, no origin server. Content is content-addressed, not located.
- **Governance replaces Google's**: where stock Chrome consults Google Safe Browsing, Hologram's own sealed
  constitution judges navigations at the door (P4, `holo-conscience`) — local, self-verifying, no lookup.
- **Identity is self-sovereign**: no Google sign-in; the operator is a κ-rooted local identity (P3 step-up).

## The one honest trade-off: DRM (Widevine) — DELIBERATELY ENABLED
`enable_widevine=true`. **Reversed from ungoogled's default by an explicit product call** (2026-06-23): a
browser that promises "any media type across the web just works" must play DRM-locked streaming
(Netflix / Disney+ / Spotify-web premium / EME-gated news players), so EME is on.

Widevine is a Google-distributed *proprietary* CDM, so this is a real, conscious trade against strict
Google-freedom. We bound it as tightly as possible:
- **The de-Googled binary stays blob-free.** `enable_widevine=true` compiles EME *support* only. The CDM
  library (`libwidevinecdm.so`) is **not** bundled into `chrome` and **not** auto-downloaded by Google's
  component updater (which ungoogled disables). It is **provisioned at runtime into the user profile**
  (`<profile>/WidevineCdm/<ver>/_platform_specific/<arch>/`) from an existing on-disk component — so the
  shipped, inspectable binary contains no Google proprietary blob; the CDM is a separable, user-visible
  artifact in the profile that can be removed to return to a strictly-Google-free state.
- **No other Google surface is reintroduced.** Widevine support does not re-enable Safe Browsing, accounts,
  sync, variations, or reporting — those remain off (see the belt above). The reach is exactly EME, nothing
  more.

To revert to strictly Google-free: set `enable_widevine=false` in `holo-flags.gn` and delete the profile's
`WidevineCdm/` — DRM streaming then won't play, which is inherent to "Google-free," not a Hologram limitation.

## Verifying a build is Google-free
- `chrome://version` shows "Hologram OS" and no "Google Chrome" branding (branding/apply_branding.py).
- grep the running profile + network log during normal browsing: no requests to `*.google.com` /
  `*.gstatic.com` / `clients*.google.com` / Safe Browsing / variations endpoints.
- `chrome://flags` and `about:` pages reflect the ungoogled feature set.
- Build is reproducible: same `UC_TAG` + same OS image → byte-identical `chrome` + the same baked
  `HOLO_CLOSURE_ANCHOR`.
