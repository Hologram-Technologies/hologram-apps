#!/usr/bin/env python3
# apply_branding.py — rebrand Chromium → "Hologram OS" with the H mark, by DATA substitution only (no
# code). Mirrors how ungoogled itself customises strings/resources: edit the BRANDING string files and
# swap the product logo/icon assets. Nothing here touches browser logic — it is name + pixels.
#
#   python3 apply_branding.py --src build/src --branding .
#
# Idempotent. The maps below are the canonical Chromium branding seams; values are the only first-party
# change. Logos are swapped only if a replacement asset is present under branding/assets/.

import argparse, shutil, sys
from pathlib import Path

# Chromium reads product name/strings from chrome/app/theme/{chromium|google_chrome}/BRANDING.
# We rewrite the chromium (open-source) BRANDING — the one ungoogled builds with.
BRANDING_KV = {
    "COMPANY_FULLNAME": "Hologram",
    "COMPANY_SHORTNAME": "Hologram",
    "PRODUCT_FULLNAME": "Hologram OS",
    "PRODUCT_SHORTNAME": "Hologram OS",
    "PRODUCT_INSTALLER_FULLNAME": "Hologram OS Installer",
    "PRODUCT_INSTALLER_SHORTNAME": "Hologram OS Installer",
}

# Logo/icon assets: src-relative target -> branding/assets/ source filename. Only swapped if present.
ASSET_MAP = {
    "chrome/app/theme/chromium/product_logo.svg": "h_mark.svg",
    "chrome/app/theme/chromium/product_logo_256.png": "h_mark_256.png",
    "chrome/app/theme/chromium/win/chromium.ico": "hologram.ico",
}


def rewrite_branding(src: Path):
    f = src / "chrome" / "app" / "theme" / "chromium" / "BRANDING"
    if not f.is_file():
        print(f"[holo] BRANDING not found at {f} — skipping strings"); return
    out = []
    for line in f.read_text(encoding="utf-8").splitlines():
        k = line.split("=", 1)[0].strip() if "=" in line else ""
        out.append(f"{k}={BRANDING_KV[k]}" if k in BRANDING_KV else line)
    f.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("[holo] rebranded chrome/app/theme/chromium/BRANDING → Hologram OS")


def swap_assets(src: Path, branding: Path):
    assets = branding / "assets"
    for rel, name in ASSET_MAP.items():
        srcfile = assets / name
        if srcfile.is_file():
            shutil.copy2(srcfile, src / rel)
            print(f"[holo] logo: {rel} ← {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--branding", default=Path(__file__).parent, type=Path)
    a = ap.parse_args()
    if not (a.src / "chrome").is_dir():
        sys.exit(f"not a chromium tree: {a.src}")
    rewrite_branding(a.src)
    swap_assets(a.src, a.branding)
    print("[holo] branding applied (drop H-mark assets under branding/assets/ to swap logos).")


if __name__ == "__main__":
    main()
