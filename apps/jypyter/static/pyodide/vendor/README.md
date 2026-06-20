# jypyter pyodide console — vendored libraries (KAPPA-1 / Law L5)

These files were vendored locally to close a Law L5 hole: the two hand-authored
pyodide console pages used to load executable code cross-origin (cdn.jsdelivr.net,
unpkg.com), which bypasses the κ-verifying delivery worker — the byte runs with
zero re-derivation. Now they are served same-origin, re-derived, and pinned in
`apps/jypyter/holospace.lock.json`.

Exact pinned versions (download once, never hand-edit; re-fetch from the CDN at the
same version if you need to refresh):

- `jquery.min.js`            — jQuery 3.7.1            (cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js)
- `jquery.terminal.min.js`   — jquery.terminal 2.35.2 (.../jquery.terminal@2.35.2/js/jquery.terminal.min.js)
- `unix_formatting.min.js`   — jquery.terminal 2.35.2 (.../jquery.terminal@2.35.2/js/unix_formatting.min.js)
- `jquery.terminal.min.css`  — jquery.terminal 2.35.2 (.../jquery.terminal@2.35.2/css/jquery.terminal.min.css)
- `xterm.js`                 — @xterm/xterm 5.4.0      (unpkg.com/@xterm/xterm@5.4.0/lib/xterm.js)
- `xterm.css`                — @xterm/xterm 5.4.0      (unpkg.com/@xterm/xterm@5.4.0/css/xterm.css)
- `addon-fit.js`             — @xterm/addon-fit 0.9.0  (unpkg.com/@xterm/addon-fit@0.9.0/lib/addon-fit.js)
- `idb-keyval.js`            — idb-keyval 5.0.2        (unpkg.com/idb-keyval@5.0.2/dist/esm/index.js)

Consumed by `../console.html` (jQuery terminal) and `../console-v2.html` (xterm),
via relative `./vendor/…` `<script src>` / `<link href>` / dynamic `import()`.

## Honest caveat — jupyter is NOT fully self-contained after this fix

This fix only covers the two **hand-authored** console pages. The jupyterlite
**minified extension bundles** (under `../../../extensions/` and `../../../build/`)
are third-party webpack build output and still contain embedded external references
— e.g. map tiles (openstreetmap, mapbox, cartocdn), maki icons, and other CDN URLs.
Those are not executable `<script src>` / `import` code-loads, so the KAPPA-1
extern witness (first-party scope) reports **green** for jypyter — but the app can
still reach out to those origins at runtime from inside its bundles.

Fixing the bundles requires an **upstream jupyterlite rebuild**, not a hand edit.
Do not claim jypyter is fully offline / fully κ-verified until that rebuild lands.
