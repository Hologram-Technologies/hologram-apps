// range-serve.mjs — minimal static server WITH HTTP Range support, rooted at the forge dir, so the GPU
// harnesses (/gpu/*.html) and the sealed model (/.models/*.holo) are served from one origin and weight
// bodies are truly range-fetchable (Python's http.server ignores Range). CORS-open, dev-only.
//   node range-serve.mjs [root] [port]
import http from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(process.argv[2] || ".");
const PORT = +(process.argv[3] || 8792);
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".f32": "application/octet-stream", ".holo": "application/octet-stream", ".bin": "application/octet-stream", ".wav": "audio/wav" };

http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const st = await stat(fp), size = st.size, type = MIME[extname(fp)] || "application/octet-stream";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", type);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = +m[1], end = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": size });
      createReadStream(fp).pipe(res);
    }
  } catch (e) { res.writeHead(404).end(String(e)); }
}).listen(PORT, () => console.log(`range server on http://127.0.0.1:${PORT}  root=${ROOT}`));
