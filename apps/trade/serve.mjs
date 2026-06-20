// serve.mjs — tiny static server for the Holo Trade app (preview/verify only).
// Correct MIME for ESM (.mjs → text/javascript) and the sealed .uor.json descriptors.
// /_shared/* falls back to the OS-canonical shared libs (os/usr/lib/holo) — mirroring the OS
// runtime's rule that _shared is served by the OS — so app-local copies aren't required.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)));
const OS_SHARED = "C:/Users/pavel/Desktop/Hologram OS2/system/os/usr/lib/holo";
const PORT = +(process.argv[2] || 8724);
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".jsonld": "application/ld+json", ".uor": "application/json",
  ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json", ".txt": "text/plain",
};
async function tryRead(...paths) { for (const p of paths) { try { return await readFile(p); } catch {} } return null; }

http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  if (p.endsWith("/")) p += "index.html";
  const candidates = [join(ROOT, p)];
  const m = p.match(/^\/_shared\/(.+)$/);                 // OS-canonical fallback for shared libs
  if (m) candidates.push(join(OS_SHARED, m[1]));
  const data = await tryRead(...candidates);
  if (!data) { res.writeHead(404); return res.end("404 " + p); }
  const ext = p.endsWith(".uor.json") ? ".json" : extname(p);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "access-control-allow-origin": "*" });
  res.end(data);
}).listen(PORT, () => console.log(`Holo Trade on http://localhost:${PORT}`));
