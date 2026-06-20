#!/usr/bin/env node
// pin-release.mjs — turn a GitHub Release of the native host into a content-addressed install manifest.
//
// After `tauri build` uploads the per-platform installers to a release, this downloads each one,
// RE-DERIVES its sha256 κ (the OS object identity), and writes `release.json` — a tiny manifest the
// bootstrap reads to fetch → verify → run the right artifact for the user's OS (Law L5). It then
// attaches `release.json` to the release, so `…/releases/latest/download/release.json` is the stable
// pin the single-link installer resolves.
//
//   node pin-release.mjs <tag>          # needs the `gh` CLI authenticated (CI provides it)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag) { console.error("usage: node pin-release.mjs <tag>"); process.exit(1); }
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const repo = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
const assets = JSON.parse(gh(["release", "view", tag, "--json", "assets"])).assets.map((a) => a.name);
console.log(`pin-release: ${tag} on ${repo} — ${assets.length} assets`);

// the ONE "run me" artifact per OS: the per-user installer (win), the disk image (mac), the portable
// binary (linux). Prefer the most effortless format; fall back to the next.
const pick = (...res) => { for (const re of res) { const m = assets.filter((n) => re.test(n)).sort(); if (m.length) return m[0]; } return null; };
const selected = {
  win: pick(/-setup\.exe$/i, /\.msi$/i),
  mac: pick(/\.dmg$/i, /\.app\.tar\.gz$/i),
  nix: pick(/\.AppImage$/i, /\.deb$/i),
};

// download the selected artifacts and re-derive each κ.
mkdirSync("_artifacts", { recursive: true });
const names = [...new Set(Object.values(selected).filter(Boolean))];
for (const n of names) gh(["release", "download", tag, "--pattern", n, "--dir", "_artifacts", "--clobber"]);

const platforms = {};
for (const [os, name] of Object.entries(selected)) {
  if (!name) { console.warn(`pin-release: no artifact for ${os}`); continue; }
  const buf = readFileSync(join("_artifacts", name));
  platforms[os] = {
    asset: name,
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    kappa: "did:holo:sha256:" + createHash("sha256").update(buf).digest("hex"),
    sri: "sha256-" + createHash("sha256").update(buf).digest("base64"),
    bytes: buf.length,
  };
  console.log(`  ${os.padEnd(3)} ${name}  ${platforms[os].kappa}`);
}

const manifest = { name: "hologram-native", tag, repo, note: "Content-addressed install manifest (Law L5). The bootstrap fetches the OS artifact, re-derives its κ, and refuses a mismatch.", platforms };
writeFileSync("release.json", JSON.stringify(manifest, null, 2));
gh(["release", "upload", tag, "release.json", "--clobber"]);
console.log("pin-release: release.json attached →", `https://github.com/${repo}/releases/download/${tag}/release.json`);
