// holo-forge-esbuild.mjs — the BROWSER binding that wires the R1 rung (HOLO-ANIMATE-GITHUB, P1). The
// deterministic bundler (holo-forge-bundle.mjs) keeps esbuild INJECTED; in Node the witness injects the
// native `esbuild`, and in a CEF holospace tab THIS module injects the vendored `esbuild-wasm`. Same API
// surface, same κ-transform, no divergence.
//
// L5 ON THE TOOL ITSELF: the build re-derives only if the BUILDER is fixed too. So the vendored toolchain
// is content-addressed (esbuild-wasm.pin.json), and this module REFUSES to initialize esbuild-wasm unless
// its bytes hash to the pinned κ — a swapped/tampered compiler can never silently change a bundle κ. This
// is the recipe side of "content-address BOTH the recipe and the result": κ(sources)⊕κ(esbuild)⊕κ(flags).
//
// PURE + injected: the script-load and the wasm-fetch are the shell's ingest boundary (passed in); the
// verify + initialize core is isomorphic and witnessable. No Node-only imports at module top.

import { sha256hex } from "./holo-uor.mjs";   // the sha256 axis the vendored pin is written in (bridge alias)

// the pinned toolchain (mirrors vendor/esbuild-wasm/esbuild-wasm.pin.json — kept here so verify needs no fetch)
export const ESBUILD_PIN = {
  tool: "esbuild-wasm",
  version: "0.21.5",
  files: {
    "browser.min.js": "did:holo:sha256:6525467654c98b3cc9edcda44dd2fd6859bb9e00cd771cce85a431c5d2057ef3",
    "esbuild.wasm": "did:holo:sha256:711d62484385c29d64ddcdc4c0beb3fb7903635a41bafffeb652938ee8480587",
  },
  sizes: { "browser.min.js": 50593, "esbuild.wasm": 11655844 },
};

const kOf = (bytes) => "did:holo:sha256:" + sha256hex(bytes);

// verifyToolchain(bytesByName, { sha256? }) → { ok, checked, mismatches } — assert each vendored file hashes
// to its pinned κ. FAIL-CLOSED: any mismatch (or a missing file) → ok:false, and the loader must refuse.
// `sha256` may be injected (WebCrypto in the browser); defaults to the pure sha256hex (Node + witness).
export function verifyToolchain(bytesByName, { sha256 = null } = {}) {
  const hash = typeof sha256 === "function" ? sha256 : (b) => "did:holo:sha256:" + sha256hex(b);
  const checked = [], mismatches = [];
  for (const [name, want] of Object.entries(ESBUILD_PIN.files)) {
    const bytes = bytesByName && bytesByName[name];
    if (bytes == null) { mismatches.push({ name, reason: "missing" }); continue; }
    const got = hash(bytes);
    checked.push(name);
    if (got !== want) mismatches.push({ name, want, got });
  }
  return { ok: mismatches.length === 0 && checked.length === Object.keys(ESBUILD_PIN.files).length, checked, mismatches };
}

// loadBrowserEsbuild({ toolchainBytes, loadScript, initialize, sha256? }) → the esbuild API, or throws.
//   toolchainBytes: { "browser.min.js": Uint8Array, "esbuild.wasm": Uint8Array } — fetched by the shell (ingest boundary)
//   loadScript(jsBytes) → the esbuild-wasm module/global (the shell decides how: <script> inject or import)
//   initialize(api, wasmBytes) → await api.initialize({ wasmModule|wasmURL }) — the shell owns the WASM handoff
// The GATE: verifyToolchain must pass before we touch the compiler. Then it's the same `esbuild` object the
// witness feeds makeBundler — R1 realizes identically in the tab and in Node.
export async function loadBrowserEsbuild({ toolchainBytes, loadScript, initialize, sha256 = null } = {}) {
  const v = verifyToolchain(toolchainBytes, { sha256 });
  if (!v.ok) throw new Error("esbuild-wasm toolchain failed κ-verify (L5) — refusing to build: " + JSON.stringify(v.mismatches));
  if (typeof loadScript !== "function") throw new Error("loadBrowserEsbuild needs an injected loadScript (the shell's script boundary)");
  const api = await loadScript(toolchainBytes["browser.min.js"]);
  if (!api || typeof api.build !== "function") throw new Error("esbuild-wasm did not expose a build() API");
  if (typeof initialize === "function") await initialize(api, toolchainBytes["esbuild.wasm"]);
  return api;
}

export function describeEsbuildBinding() {
  return {
    is: "the browser binding for R1 — injects the vendored, κ-pinned esbuild-wasm into holo-forge-bundle's deterministic κ-transform",
    l5: "the compiler itself is content-addressed (esbuild-wasm.pin.json); a tampered/swapped esbuild is refused before any build — the recipe κ is honest",
    parity: "same API as the native esbuild the witness uses → R1 bundles are byte-identical in the tab and in Node (Law L5)",
  };
}

export default { ESBUILD_PIN, verifyToolchain, loadBrowserEsbuild, describeEsbuildBinding };
