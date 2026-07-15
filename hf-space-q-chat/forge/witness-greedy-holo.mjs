// Real-MoE Tier-1 witness: a REAL GGUF taken through the κ SPARSE-STREAMING path —
//   forge → per-expert κ directory → resident multi-source store + sparse loader →
//   greedy decode — must be BIT-IDENTICAL, token-for-token, to the in-memory whole-stack
//   forge decode, while fetching ONLY the experts the router selects. Proves the
//   packaging/streaming layer is faithful on a real MLA+MoE quantized model.
//
//   node witness-greedy-holo.mjs [model.gguf] [N] [csv-prompt-ids]
//
// Scales to 10 GB+ models: streaming forge (no whole-file buffer), per-expert slices
// served as LAZY VIEWS over the whole-stack block (no copies, no materialized .holo —
// the sealed .holo round-trip is separately witnessed by gguf-forge-package.test.mjs +
// the bitnet run), and a verify-once resident store (the default loadByKappa re-hashes
// the 64-expert stacks per matvec → hours; the resident store verifies each block once
// on receipt and the fast loader then just retrieves).

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { parseGgufHeader } from "../qvac-ingest.mjs";
import { forgeGgufStream } from "./gguf-forge.mjs";
import { synthesizeGraph } from "./gguf-forge-graph.mjs";
import { forward } from "./gguf-forge-exec.mjs";
import { buildExpertDirectory, expertKappa, isExpertTensor } from "./gguf-forge-expert-dir.mjs";
import { makeResidentStore } from "./gguf-forge-kstore.mjs";

const MODEL = process.argv[2] || ".models/deepseek-v2-lite-q4_k_m.gguf";
const N = +(process.argv[3] || 4);
const PROMPT = (process.argv[4] || "100000,549,6077,280,7239,317,8913,13,429,6077,280,11357,317").split(",").map(Number);
const t0 = Date.now(); const el = () => ((Date.now() - t0) / 1000).toFixed(1);
const mem = () => (process.memoryUsage().rss / 1e9).toFixed(2) + "GB";
const fail = (m) => { console.error(`\nFAIL — ${m}`); process.exit(1); };
const hexOf = (k) => String(k).split(":").pop();

const fd = openSync(MODEL, "r"); const size = statSync(MODEL).size;
const readRange = async (off, len) => { const b = Buffer.allocUnsafe(len); let g = 0; while (g < len) { const n = readSync(fd, b, g, len - g, off + g); if (n <= 0) break; g += n; } return new Uint8Array(b.buffer, b.byteOffset, len); };
const headerBytes = await readRange(0, Math.min(64 * 1024 * 1024, size));
let hdr; try { hdr = parseGgufHeader(headerBytes); } catch (e) { fail(`header parse: ${e.message}`); }
console.log(`[${el()}s] ${MODEL.split("/").pop()} ${(size / 1e9).toFixed(2)}GB arch=${hdr.meta["general.architecture"]} tensors=${hdr.tensors.length}`);

const f = await forgeGgufStream(readRange, { headerBytes });
console.log(`[${el()}s] forged ${f.blocks.size} κ-blocks, root ${f.rootKappa.slice(0, 28)}…  ${mem()}`);
const graph = synthesizeGraph(f.plan);
if (graph.family !== "dense" && graph.family !== "moe" && graph.family !== "mla-moe") fail(`graph family=${graph.family} (${graph.reason || ""})`);
const isMoE = (graph.stats.n_expert || 0) > 0;
console.log(`[${el()}s] graph family=${graph.family} layers=${graph.stats.n_layer} experts=${graph.stats.n_expert || 0}/${graph.stats.n_expert_used || 0}`);

const expert = isMoE ? buildExpertDirectory(f, { storeBlocks: false }) : null;   // dir only (κ), no byte copies

// reverse map: per-expert κ-hex → {wholeHex, off, len} (lazy slice over the whole stack)
const slice = {};
if (isMoE) for (const t of f.tensors) {
  const td = expert.dir.tensors[t.name]; if (!td) continue;
  const wholeHex = hexOf(t.kappa);
  for (let e = 0; e < td.nExpert; e++) slice[hexOf(td.experts[e].kappa)] = { wholeHex, off: e * td.stride, len: td.stride };
}
// whole-stack source (trunk + whole exps) and lazy sparse source (trunk + per-expert views)
const wholeSrc = { get: (hex) => f.blocks.get(hex) };
const lazySrc = { get: (hex) => { const b = f.blocks.get(hex); if (b) return b; const s = slice[hex]; if (!s) return undefined; const w = f.blocks.get(s.wholeHex); return w.subarray(s.off, s.off + s.len); } };
// fast loader: the resident store verifies each block ONCE on receipt → no per-matvec re-hash
const fastload = (st, k) => { const b = st.get(hexOf(k)); if (b === undefined) throw new Error("κ not found " + k); return b; };

function greedy(store, opts, tag) {
  const seq = [...PROMPT], gen = [];
  for (let i = 0; i < N; i++) {
    const lg = forward(f.plan, graph, store, seq, { ...opts, load: fastload });
    let am = 0; for (let j = 1; j < lg.length; j++) if (lg[j] > lg[am]) am = j;
    gen.push(am); seq.push(am);
    console.log(`[${el()}s]   ${tag} tok ${i + 1}/${N} = ${am}`);
  }
  return gen;
}

// (A) whole-stack reference greedy. For multi-GB models, holding two passes' working
// sets OOMs — pass argv[5]=expected-csv to skip this pass and compare against a known
// whole-stack result (whole-stack==llama is proven separately by witness-greedy-tier2).
const EXPECT = process.argv[5] ? process.argv[5].split(",").map(Number) : null;
let genWhole;
if (EXPECT) { genWhole = EXPECT; console.log(`[${el()}s] reference tokens (argv, whole-stack pass skipped): ${genWhole.join(" ")}`); }
else { genWhole = greedy(makeResidentStore({ sources: [wholeSrc], resident: new Map() }), {}, "whole"); console.log(`[${el()}s] whole-stack gen: ${genWhole.join(" ")}  ${mem()}`); }

// (B) sparse-streamed greedy: per-expert dir + lazy view source, recording fetched κ
const fetched = new Set(), routedByLayer = {};   // expert indices are PER-LAYER (distinct κ per layer)
const recSrc = { get: (hex) => { const b = lazySrc.get(hex); if (b !== undefined) fetched.add(hex); return b; } };
const resident = new Map();
const opts = { onExpertSelect: (key, s) => { const L = key.split(".")[0]; (routedByLayer[L] ??= new Set()); for (const e of s) routedByLayer[L].add(e); } };
if (isMoE) opts.expertDir = expert.dir;
const genHolo = greedy(makeResidentStore({ sources: [recSrc], resident }), opts, "sparse");
console.log(`[${el()}s] sparse gen: ${genHolo.join(" ")}  (resident ${resident.size} blocks)`);

// (C) warm: a second decode reusing residency fetches nothing new
const warm = makeResidentStore({ sources: [recSrc], resident });
const before = resident.size; greedy(warm, opts, "warm ");

// ── assertions ──
if (!(genWhole.length === genHolo.length && genWhole.every((v, i) => v === genHolo[i]))) fail(`parity: whole [${genWhole}] != sparse [${genHolo}]`);
if (warm.stats.fetched !== 0 || resident.size !== before) fail(`warm decode fetched ${warm.stats.fetched} (expected 0)`);

let sparsityMsg = "n/a (dense)";
if (isMoE) {
  const expHex = new Set();
  for (const tn of Object.keys(expert.dir.tensors)) for (let e = 0; e < expert.dir.tensors[tn].nExpert; e++) expHex.add(hexOf(expertKappa(expert.dir, tn, e)));
  const wholeStackHex = new Set(f.tensors.filter((t) => isExpertTensor(t.name)).map((t) => hexOf(t.kappa)));
  // expected = PER-LAYER routed experts × that layer's gate/up/down_exps (indices are per-layer)
  const expected = new Set();
  for (const L in routedByLayer) { const Nl = +L.slice(1); for (const tt of ["gate", "up", "down"]) { const tn = `blk.${Nl}.ffn_${tt}_exps.weight`; if (expert.dir.tensors[tn]) for (const e of routedByLayer[L]) expected.add(hexOf(expertKappa(expert.dir, tn, e))); } }
  const fetchedExperts = new Set([...fetched].filter((h) => expHex.has(h)));
  if (fetchedExperts.size !== expected.size || [...expected].some((h) => !fetchedExperts.has(h))) fail(`sparse fetch != router selection (fetched ${fetchedExperts.size}, expected ${expected.size})`);
  for (const h of wholeStackHex) if (fetched.has(h)) fail("a whole expert stack was fetched (over-fetch)");
  sparsityMsg = `${fetchedExperts.size} expert slices fetched (== per-layer router selection); full ${graph.stats.n_expert}-expert stacks never fetched`;
}

closeSync(fd);
console.log(`\nPASS — real ${MODEL.split("/").pop()}: sparse-streamed decode == whole-stack (${N} tokens), bit-identical.`);
console.log(`  warm: 0 new fetches · sparsity: ${sparsityMsg}`);
console.log(`  [${el()}s total, peak ${mem()}]`);
process.exit(0);
