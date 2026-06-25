#!/usr/bin/env python3
# holo_kappa_overlay.py — layer the Hologram κ-native overlay onto an ungoogled-chromium source tree,
# AFTER ungoogled's own steps (downloads -> prune_binaries -> patches -> domain_substitution). It does NOT
# rewrite any verification logic: it stages the prebuilt, witnessed `kappa-route` verifier + the one κ
# URLLoaderFactory, bakes the closure trust root, and applies the minimal unavoidable engine seams.
#
# Run from build-kappa-ungoogled.sh, or standalone:
#   python3 holo_kappa_overlay.py --src build/src --overlay . --os-image /path/to/dist
#
# Idempotent: re-running is a no-op for edits already present. Anchor-based (no fixed line numbers), and
# it FAILS LOUD if an anchor is missing — so a milestone rebase that moved a seam is caught, not silently
# skipped. Chromium has no third-party-scheme extensibility, so the +6 lines below are the only edits to
# existing engine files; everything else is new files. (See KAPPA-INTEGRATION.md for the rationale.)

import argparse, hashlib, shutil, sys
from pathlib import Path

# ── the three minimal seam edits: (file, anchor-after, snippet, idempotency-marker) ────────────────
SCHEME_SNIPPET = '''  // [holo] κ scheme: per-κ tuple origins + secure context + CORS/fetch (mirrors the CEF registration).
  schemes->standard_schemes.push_back("holo");
  schemes->secure_schemes.push_back("holo");
  schemes->cors_enabled_schemes.push_back("holo");
'''
# Chromium 149 factory hooks (verified AT BUILD against the patched tree — corrects an earlier miss):
#  • NAVIGATION → chrome ALREADY declares AND defines the singular
#    ChromeContentBrowserClient::CreateNonNetworkNavigationURLLoaderFactory(scheme, …) and dispatches by
#    scheme (extension, isolated-app, …). The earlier grep for "Register*URLLoaderFactories" MISSED it
#    because it is a Create*, not Register*, method — so adding our own decl+def caused a redeclaration
#    error. Correct integration: INJECT our holo branch at the TOP of that existing definition. Never
#    redeclare it.
#  • SUBRESOURCE → the map-populating RegisterNonNetworkSubresourceURLLoaderFactories (unchanged) —
#    an emplace("holo", …).
SUB_SNIPPET = '  factories->emplace("holo", holo::HoloURLLoaderFactory::Create(holo::GetOrOpenStore()));  // [holo-sub]\n'
# Injected at the top of chrome's existing CreateNonNetworkNavigationURLLoaderFactory body:
NAV_BRANCH = (
    '  if (scheme == "holo")  // [holo-nav]\n'
    '    return holo::HoloURLLoaderFactory::Create(holo::GetOrOpenStore());\n')
INCLUDE_SNIPPET = '#include "chrome/browser/holo/holo_url_loader_factory.h"  // [holo]\n'
# Renderer-side (blink) scheme registration — injected into ChromeContentRendererClient::RenderThreadStarted.
# Browser-side scheme lists allow holo:// to navigate, but blink separately gates fetch()/module imports;
# without this, holo:// pages load but render empty ("URL scheme holo is not supported").
RENDERER_SNIPPET = (
    '  {  // [holo-renderer] make holo:// fetch-API + service-worker capable in blink (like https)\n'
    '    const blink::WebString holo_scheme = blink::WebString::FromUtf8("holo");\n'
    '    blink::WebSecurityPolicy::RegisterURLSchemeAsSupportingFetchAPI(holo_scheme);\n'
    '    blink::WebSecurityPolicy::RegisterURLSchemeAsAllowingServiceWorkers(holo_scheme);\n'
    '  }\n')


def bake_anchor(os_image: Path, src: Path):
    """Write holo_closure_anchor.h = CANONICAL blake3(os-closure.json) — the baked trust root (G1/SEC-1,
    ADR-0115). BLAKE3 is the substrate's kappo; load_store matches it first and accepts the legacy sha256
    value as a fallback. Computed with the OS's own standard-BLAKE3 (holo-blake3.mjs == the `blake3` crate
    == kr_blake3_hex), so the baked anchor is byte-identical to the verifier's. Falls back to sha256 only
    if node is unavailable (still admitted by the verifier's sha fallback)."""
    closure = os_image / "os-closure.json"
    anchor = ""
    if closure.is_file():
        b3 = os_image / "usr" / "lib" / "holo" / "holo-blake3.mjs"
        try:
            import subprocess
            anchor = subprocess.check_output(
                ["node", "-e",
                 "const fs=require('fs');const{pathToFileURL}=require('url');"
                 "import(pathToFileURL(process.argv[1]).href).then(m=>process.stdout.write(m.blake3hex(fs.readFileSync(process.argv[2]))))",
                 str(b3), str(closure)], text=True).strip()
            print(f"[holo] baked closure anchor (blake3): {anchor[:12]}…")
        except Exception as e:
            anchor = hashlib.sha256(closure.read_bytes()).hexdigest()
            print(f"[holo] node/blake3 unavailable ({e}); baked sha256 fallback anchor: {anchor[:12]}… (verifier accepts it)")
    else:
        print(f"[holo] WARNING: {closure} not found — anchor empty (store will not fail-closed on swap).")
    hdr = src / "chrome" / "browser" / "holo" / "holo_closure_anchor.h"
    hdr.write_text(
        "#ifndef CHROME_BROWSER_HOLO_HOLO_CLOSURE_ANCHOR_H_\n"
        "#define CHROME_BROWSER_HOLO_HOLO_CLOSURE_ANCHOR_H_\n"
        f'#define HOLO_CLOSURE_ANCHOR "{anchor}"\n'
        "#endif\n", encoding="ascii")


def stage_files(overlay: Path, src: Path):
    """Copy the new src tree (chrome/browser/holo/*) and the prebuilt verifier (//holo/{lib,include})."""
    # new browser unit
    dst = src / "chrome" / "browser" / "holo"
    dst.mkdir(parents=True, exist_ok=True)
    for f in (overlay / "src" / "chrome" / "browser" / "holo").glob("*"):
        shutil.copy2(f, dst / f.name)
    # the prebuilt verifier (lib + header), staged at //holo/ as BUILD.gn expects
    for sub in ("lib", "include"):
        s = overlay.parent / "holo" / sub
        d = src / "holo" / sub
        d.mkdir(parents=True, exist_ok=True)
        for f in s.glob("*"):
            shutil.copy2(f, d / f.name)
    print("[holo] staged chrome/browser/holo + //holo/{lib,include}")


def insert_after_anchor(path: Path, anchor: str, snippet: str, marker: str, after_brace=False):
    """Insert `snippet` right after the line containing `anchor` (or its next '{' if after_brace).
    No-op if `marker` already present. Raises if the anchor is absent (fail loud on rebase drift)."""
    text = path.read_text(encoding="utf-8")
    if marker in text:
        print(f"[holo] {path.name}: already wired (marker present)")
        return
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if anchor in line:
            j = i
            if after_brace:
                while j < len(lines) and "{" not in lines[j]:
                    j += 1
                if j >= len(lines):
                    raise RuntimeError(f"{path}: '{{' not found after anchor {anchor!r}")
            lines.insert(j + 1, snippet)
            path.write_text("".join(lines), encoding="utf-8")
            print(f"[holo] {path.name}: wired at anchor {anchor!r}")
            return
    raise RuntimeError(f"{path}: ANCHOR NOT FOUND {anchor!r} — milestone moved this seam; update the anchor.")


def insert_after_terminator(path: Path, anchor: str, terminator: str, snippet: str, marker: str):
    """For a multi-line declaration: find `anchor`, then the next line containing `terminator`
    (e.g. ') override;'), and insert `snippet` after it. Idempotent; fails loud if anchor absent."""
    text = path.read_text(encoding="utf-8")
    if marker in text:
        print(f"[holo] {path.name}: already wired ({marker})"); return
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if anchor in line:
            j = i
            while j < len(lines) and terminator not in lines[j]:
                j += 1
            if j >= len(lines):
                raise RuntimeError(f"{path}: terminator {terminator!r} not found after {anchor!r}")
            lines.insert(j + 1, snippet)
            path.write_text("".join(lines), encoding="utf-8")
            print(f"[holo] {path.name}: declared at {anchor!r}")
            return
    raise RuntimeError(f"{path}: ANCHOR NOT FOUND {anchor!r} — update the anchor for this milestone.")


# A DEFINITION of `name_anchor` is the line containing it where the qualifier `qual` (e.g.
# "ChromeContentBrowserClient::") is on THAT line (inlined: `void ChromeContentBrowserClient::Name(`)
# OR on the previous non-empty line (split: `void ChromeContentBrowserClient::` \n `    Name(`). A bare
# `Name(` whose neighbourhood lacks the qualifier is a CALL site and is skipped. Returns (i, start) where
# i = the name line and start = the def's first line, or None.
def _find_def(lines, name_anchor, qual):
    for i, line in enumerate(lines):
        if name_anchor not in line:
            continue
        if qual in line:
            return i, i                                  # inlined definition
        k = i - 1
        while k > 0 and not lines[k].strip():
            k -= 1
        if k >= 0 and lines[k].rstrip().endswith(qual):
            return i, k                                  # split definition (start at qualifier line)
    return None


def insert_def_before(path: Path, name_anchor: str, qual: str, snippet: str, marker: str):
    """Insert a complete function `snippet` just before the DEFINITION of `name_anchor` (either shape).
    Idempotent; fails loud if no definition site is found."""
    text = path.read_text(encoding="utf-8")
    if marker in text:
        print(f"[holo] {path.name}: already wired ({marker})"); return
    lines = text.splitlines(keepends=True)
    found = _find_def(lines, name_anchor, qual)
    if not found:
        raise RuntimeError(f"{path}: definition site for {name_anchor!r} not found — update the anchor.")
    _, start = found
    lines.insert(start, snippet)
    path.write_text("".join(lines), encoding="utf-8")
    print(f"[holo] {path.name}: defined before {name_anchor!r}")


def insert_after_def_brace(path: Path, name_anchor: str, qual: str, snippet: str, marker: str):
    """Insert `snippet` after the opening '{' of the DEFINITION of `name_anchor` (either shape), so a
    preceding CALL site is never matched. Idempotent; fails loud if no definition site is found."""
    text = path.read_text(encoding="utf-8")
    if marker in text:
        print(f"[holo] {path.name}: already wired ({marker})"); return
    lines = text.splitlines(keepends=True)
    found = _find_def(lines, name_anchor, qual)
    if not found:
        raise RuntimeError(f"{path}: definition site for {name_anchor!r} not found — update the anchor.")
    i, _ = found
    j = i
    while j < len(lines) and "{" not in lines[j]:
        j += 1
    if j >= len(lines):
        raise RuntimeError(f"{path}: '{{' not found after def {name_anchor!r}")
    lines.insert(j + 1, snippet)
    path.write_text("".join(lines), encoding="utf-8")
    print(f"[holo] {path.name}: wired in def {name_anchor!r}")


def apply_seams(src: Path):
    # §1 register holo:// in the scheme lists
    insert_after_anchor(
        src / "chrome" / "common" / "chrome_content_client.cc",
        "AddAdditionalSchemes", SCHEME_SNIPPET, '"holo"', after_brace=True)
    # §3 register the κ factory (149 API): navigation via the singular Create… override (new decl+def),
    # subresources via the unchanged Register…Subresource map. Plus the factory include.
    cbc = src / "chrome" / "browser" / "chrome_content_browser_client.cc"
    cbc_h = src / "chrome" / "browser" / "chrome_content_browser_client.h"
    insert_after_anchor(cbc, "#include \"chrome/browser/browser_process.h\"",
                        INCLUDE_SNIPPET, "holo/holo_url_loader_factory.h")
    # navigation: chrome ALREADY defines CreateNonNetworkNavigationURLLoaderFactory — inject the holo
    # branch at the top of that existing definition (do NOT redeclare it; that caused a redeclaration error).
    insert_after_def_brace(cbc, "CreateNonNetworkNavigationURLLoaderFactory",
                           "ChromeContentBrowserClient::", NAV_BRANCH, "[holo-nav]")
    # subresources: emplace into the DEFINITION's body of the existing map-populating override
    insert_after_def_brace(cbc, "RegisterNonNetworkSubresourceURLLoaderFactories",
                           "ChromeContentBrowserClient::", SUB_SNIPPET, "[holo-sub]")
    # §3b RENDERER: register holo:// with blink as fetch-API + service-worker capable. Without this the
    # browser-side scheme lists let holo:// NAVIGATE, but blink refuses subresource fetch()/module imports
    # ("URL scheme holo is not supported"), so pages render empty. Inject into RenderThreadStarted().
    insert_after_def_brace(src / "chrome" / "renderer" / "chrome_content_renderer_client.cc",
                           "RenderThreadStarted", "ChromeContentRendererClient::", RENDERER_SNIPPET,
                           "[holo-renderer]")
    # §4 add the holo unit to the MAIN chrome_browser target's deps — NOT the first deps=[ in the file
    # (verified: chrome/browser/BUILD.gn has earlier targets before static_library("browser"); anchoring on
    # the bare first 'deps = [' would land in the wrong target).
    insert_after_terminator(
        src / "chrome" / "browser" / "BUILD.gn",
        'static_library("browser")', "deps = [",
        '    "//chrome/browser/holo:holo",  # [holo]\n', "chrome/browser/holo:holo")


def main():
    ap = argparse.ArgumentParser(description="Apply the Hologram κ overlay to an ungoogled-chromium tree.")
    ap.add_argument("--src", required=True, type=Path, help="the chromium source root (e.g. build/src)")
    ap.add_argument("--overlay", default=Path(__file__).parent, type=Path, help="this ungoogled/ dir")
    ap.add_argument("--os-image", required=True, type=Path, help="the sealed dist (os-closure.json lives here)")
    a = ap.parse_args()
    if not (a.src / "chrome" / "common" / "chrome_content_client.cc").is_file():
        sys.exit(f"not a chromium tree: {a.src}")
    stage_files(a.overlay, a.src)
    bake_anchor(a.os_image, a.src)
    apply_seams(a.src)
    print("[holo] overlay applied. Append holo-flags.gn to out/Default/args.gn, then gn gen + ninja.")


if __name__ == "__main__":
    main()
