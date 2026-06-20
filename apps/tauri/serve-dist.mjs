#!/usr/bin/env node
// serve-dist.mjs — preview the native image WITHOUT a Rust toolchain.
//
// This serves `dist/` over HTTP with the EXACT resolution contract the native host implements in
// src-tauri/src/lib.rs (flat read · `os/` root-segment strip · app-relative `_shared`/`pkg` collapse
// · Law-L5 content verification against os-closure.json · cross-origin-isolation headers). So
// `http://127.0.0.1:8400/` boots byte-identically to the holo:// window in the packaged app — a fast
// smoke test for make-dist.mjs and a faithful mirror of the Rust κ-route.
//
//   node make-dist.mjs && node serve-dist.mjs [port=8400]

import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.HOLO_OS_DIR || join(HERE, "dist");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jsonld": "application/ld+json", ".map": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless", "Cross-Origin-Resource-Policy": "cross-origin" };

// path → expected sha256 hex (the closure pin), mirrors lib.rs store().
const closure = (() => {
  try {
    const doc = JSON.parse(readFileSync(join(DIST, "os-closure.json"), "utf8")).closure || {};
    const m = new Map();
    for (const [p, v] of Object.entries(doc)) { const k = typeof v === "string" ? v : (v.kappa || v.did || ""); const hex = String(k).split(":").pop(); if (hex) m.set(p, hex.toLowerCase()); }
    return m;
  } catch { return new Map(); }
})();

// the ONE flat URL key — mirrors lib.rs flat_key().
function flatKey(p) {
  let rel = p.replace(/^\/+/, "");
  if (rel === "os") rel = ""; else if (rel.startsWith("os/")) rel = rel.slice(3);
  let i = rel.indexOf("/_shared/"); if (i >= 0 && rel.startsWith("apps/")) rel = rel.slice(i + 1);
  i = rel.indexOf("/pkg/"); if (i >= 0 && rel.startsWith("apps/")) rel = rel.slice(i + 1);
  return rel;
}

const server = http.createServer((req, res) => {
  let rel = flatKey(decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]));
  if (rel === "" ) rel = "apps/browser/index.html";
  else if (rel.endsWith("/")) rel += "index.html";
  const full = join(DIST, rel);
  if (!full.startsWith(DIST) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, COI); return res.end("not found: " + rel);
  }
  const buf = readFileSync(full);
  const want = closure.get(rel);                              // Law L5 — re-derive + verify if pinned
  if (want && createHash("sha256").update(buf).digest("hex") !== want) {
    res.writeHead(403, COI); return res.end("κ mismatch (tampered): " + rel);
  }
  res.writeHead(200, { ...COI, "content-type": TYPES[extname(rel).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  res.end(buf);
});

const port = parseInt(process.argv[2] || "8400", 10);
server.listen(port, "127.0.0.1", () => {
  console.log(`serve-dist: native image at  http://127.0.0.1:${port}/   (mirrors the holo:// host; ${closure.size} κ pins)`);
});
