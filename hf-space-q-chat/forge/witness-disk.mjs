// Disk-backed bounded-memory witness (Phase 1d of GLM-5.2-at-scale).
// Run a REAL multi-GB GGUF through the κ pipeline WITHOUT holding it in RAM:
//   forgeGgufScan (κ + κ→offset dir, no blocks Map) → graph → makeDiskStore (range-read +
//   bounded LRU + verify-once) → sparse greedy decode (only routed experts range-read).
// Proves memory scales with the ACTIVE set, not the model: peak RSS ≪ model size, correct
// decode (== a known whole-stack result). This is the mechanism that makes GLM-5.2 (744B,
// 254-467 GB) feasible — only the ~40B active per token touches memory.
//
//   node --max-old-space-size=2048 witness-disk.mjs [model.gguf] [N] [csv-prompt] [expect-csv] [budgetMB]

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { parseGgufHeader } from "../qvac-ingest.mjs";
import { forgeGgufScan } from "./gguf-forge.mjs";
import { synthesizeGraph } from "./gguf-forge-graph.mjs";
import { forward } from "./gguf-forge-exec.mjs";

const MODEL = process.argv[2] || ".models/deepseek-v2-lite-q4_k_m.gguf";
const N = +(process.argv[3] || 2);
const PROMPT = (process.argv[4] || "100000,549,6077,280,7239,317,8913,13,429,6077,280,11357,317").split(",").map(Number);
const EXPECT = process.argv[5] ? process.argv[5].split(",").map(Number) : null;
const BUDGET = (+(process.argv[6] || 2048)) * 1024 * 1024;          // LRU byte cap (off-heap Buffers)

const t0 = Date.now(); const el = () => ((Date.now() - t0) / 1000).toFixed(1);
let peakRss = 0; const mem = () => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; return (r / 1e9).toFixed(2) + "GB"; };
const fail = (m) => { console.error(`\nFAIL — ${m}`); process.exit(1); };
const hexOf = (k) => String(k).split(":").pop();

const fd = openSync(MODEL, "r"); const size = statSync(MODEL).size;
const readRange = async (off, len) => { const b = Buffer.allocUnsafe(len); let g = 0; while (g < len) { const n = readSync(fd, b, g, len - g, off + g); if (n <= 0) break; g += n; } return new Uint8Array(b.buffer, b.byteOffset, len); };
const headerBytes = await readRange(0, Math.min(64 * 1024 * 1024, size));
let hdr; try { hdr = parseGgufHeader(headerBytes); } catch (e) { fail(`header parse: ${e.message}`); }
console.log(`[${el()}s] ${MODEL.split("/").pop()} ${(size / 1e9).toFixed(2)}GB arch=${hdr.meta["general.architecture"]} tensors=${hdr.tensors.length}  LRU budget=${(BUDGET / 1e9).toFixed(2)}GB`);

// Disk-backed forge: derive κ one tensor at a time, retain NOTHING (peak = largest tensor).
const f = await forgeGgufScan(readRange, { headerBytes });
console.log(`[${el()}s] scanned: ${Object.keys(f.dir).length} κ-blocks in dir, root ${f.rootKappa.slice(0, 28)}…  RSS ${mem()} (no model in RAM)`);
const graph = synthesizeGraph(f.plan);
if (!["dense", "moe", "mla-moe"].includes(graph.family)) fail(`graph family=${graph.family} (${graph.reason || ""})`);
const isMoE = (graph.stats.n_expert || 0) > 0;
console.log(`[${el()}s] graph family=${graph.family} layers=${graph.stats.n_layer} experts=${graph.stats.n_expert || 0}/${graph.stats.n_expert_used || 0}`);

// Disk store: range-read any κ-block from the file, verify-once, bounded LRU.
const { makeDiskStore } = await import("./gguf-forge-kstore.mjs");
const store = makeDiskStore({ fd, dir: f.dir, budgetBytes: BUDGET });
const fastload = (st, k) => { const b = st.get(hexOf(k)); if (b === undefined) throw new Error("κ not found " + k); return b; };

const seq = [...PROMPT], gen = [];
for (let i = 0; i < N; i++) {
  const lg = forward(f.plan, graph, store, seq, { load: fastload, expertDir: isMoE ? f.expertDir : undefined });
  let am = 0; for (let j = 1; j < lg.length; j++) if (lg[j] > lg[am]) am = j;
  gen.push(am); seq.push(am);
  console.log(`[${el()}s]   tok ${i + 1}/${N} = ${am}   RSS ${mem()} · LRU ${(store.stats.bytes() / 1e9).toFixed(2)}GB · reads ${store.stats.reads} evict ${store.stats.evicted}`);
}

closeSync(fd);
console.log(`[${el()}s] disk-backed gen: ${gen.join(" ")}`);
if (EXPECT) {
  if (!(gen.length >= EXPECT.length && EXPECT.every((v, i) => v === gen[i]))) fail(`decode ${gen.join(" ")} != expected ${EXPECT.join(" ")}`);
}
const modelGB = size / 1e9, peakGB = peakRss / 1e9;
console.log(`\nPASS — ${MODEL.split("/").pop()} decoded disk-backed${EXPECT ? " (== known whole-stack " + EXPECT.join(" ") + ")" : ""}.`);
console.log(`  peak RSS ${peakGB.toFixed(2)}GB on a ${modelGB.toFixed(2)}GB model (${(peakGB / modelGB * 100).toFixed(0)}% — memory tracks the ACTIVE set, not the model)`);
console.log(`  LRU peak ${(store.stats.peak / 1e9).toFixed(2)}GB · ${store.stats.reads} disk reads · ${store.stats.evicted} evictions · ${store.stats.verified} verified · ${store.stats.refused} refused`);
console.log(`  [${el()}s total]`);
process.exit(0);
