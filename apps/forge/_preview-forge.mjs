// _preview-forge.mjs — minimal static server to preview the Holo Forge TypeScript panel.
// Mounts:  /            -> apps/forge   (the Forge app)
//          /ui/*        -> apps/ui      (the content-addressed component registry + vendor bytes)
//          /_shared/*   -> os/_shared   (holo-theme.js, holo-mobile.css)
// The TS panel (esbuild-wasm 0.24.2 + the shared React runtime) compiles button/badge/card
// natively in-browser from their verbatim source and renders them, then renders the same
// components straight from their module κ. Run: node _preview-forge.mjs  (then open :8765)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const FORGE = "C:/Users/pavel/Desktop/Hologram Apps/apps/forge";
const UI = "C:/Users/pavel/Desktop/Hologram Apps/apps/ui";
const SHARED = "C:/Users/pavel/Desktop/hologram-os/os/_shared";
const PORT = 8765;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".tsx": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".map": "application/json",
};

function resolve(urlPath) {
  const p = decodeURIComponent(urlPath.split("?")[0]);
  if (p === "/" || p === "") return join(FORGE, "index.html");
  if (p.startsWith("/ui/")) return join(UI, normalize(p.slice(4)));
  if (p.startsWith("/_shared/")) return join(SHARED, normalize(p.slice(9)));
  return join(FORGE, normalize(p.replace(/^\//, "")));
}

createServer(async (req, res) => {
  let file = resolve(req.url);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 " + req.url);
  }
}).listen(PORT, () => console.log(`Holo Forge preview → http://localhost:${PORT}/  (TS panel ready)`));
