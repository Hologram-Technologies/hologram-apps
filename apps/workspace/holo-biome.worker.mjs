// holo-biome.worker.mjs — a REAL WASM language server (Biome, Rust→WebAssembly) running OFF the main
// thread, with no server (ADR-0056 escalation). Drives the vendored @biomejs/wasm-web Workspace exactly
// as Biome's own js-api does (registerProjectFolder → openFile → pullDiagnostics → formatFile → closeFile),
// answering the same {id,method,…}→{id,result} transport the Holo Lang worker uses. Diagnostics + format
// for JS / TS / JSON, content-addressed + serverless. The wasm is fetched relative to the glue (init()).
import init, { Workspace } from "./vendor/biome/biome_wasm.js";

let ws = null, booting = null;
async function ensure() {
  if (ws) return;
  if (!booting) booting = (async () => { await init(); ws = new Workspace(); ws.registerProjectFolder({ setAsCurrentWorkspace: true }); })();
  await booting;
}
function markup(m) { try { return Array.isArray(m) ? m.map((n) => (n && n.content) || "").join("") : ((m && m.content) || ""); } catch { return ""; } }

self.onmessage = async (e) => {
  const { id, method, text, path } = e.data;
  let result = null, error = null;
  try {
    await ensure();
    const bp = { path: path || "file.ts", was_written: false, kind: ["Handleable"] };
    ws.openFile({ content: text, version: 0, path: bp });
    try {
      if (method === "diagnostics") {
        const { diagnostics } = ws.pullDiagnostics({ path: bp, categories: ["Syntax", "Lint"], max_diagnostics: 1000, only: [], skip: [] });
        result = (diagnostics || []).map((d) => ({
          severity: d.severity, category: d.category || "",
          message: (d.description || markup(d.message) || "").trim(),
          start: (d.location && d.location.span && d.location.span[0]) || 0,
          end: (d.location && d.location.span && d.location.span[1]) || 0,
        }));
      } else if (method === "format") {
        const { diagnostics } = ws.pullDiagnostics({ path: bp, categories: ["Syntax"], max_diagnostics: 1000, only: [], skip: [] });
        const fatal = (diagnostics || []).some((x) => x.severity === "error" || x.severity === "fatal");
        result = fatal ? null : (ws.formatFile({ path: bp }) || {}).code;
        if (result == null && !fatal) result = text;            // nothing to change
      } else if (method === "ping") { result = "ok"; }
    } finally { try { ws.closeFile({ path: bp }); } catch {} }
  } catch (err) { error = String((err && err.message) || err); }
  self.postMessage({ id, result, error });
};
