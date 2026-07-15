// Static server for the WhatsApp-Q HF Space (proper MIME + COOP/COEP so WebGPU/SharedArrayBuffer work — though
// the app also runs fine WITHOUT isolation: brain + neural voice both have a no-SAB single-thread path).
import http from "node:http"; import { createReadStream, existsSync, statSync } from "node:fs"; import { join, extname, normalize, dirname } from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = dirname(fileURLToPath(import.meta.url));   // serve THIS bundle's own dir — survives moves
const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gguf": "application/octet-stream", ".gz": "application/gzip" };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
  const fp = normalize(join(ROOT, p)); const rootN = normalize(ROOT);
  if (!fp.startsWith(rootN)) { res.writeHead(403).end("no"); return; }
  if (!existsSync(fp) || !statSync(fp).isFile()) { res.writeHead(404).end("not found: " + p); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(fp)] || "application/octet-stream", "Cache-Control": "no-cache", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Access-Control-Allow-Origin": "*" });
  createReadStream(fp).pipe(res);
}).listen(8479, () => console.log("WhatsApp-Q → http://localhost:8479/"));
