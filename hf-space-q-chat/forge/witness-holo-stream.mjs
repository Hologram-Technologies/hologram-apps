// Real-model .holo streaming witness (Phase 1c of GLM-5.2 holo-stream).
// Take a REAL multi-GB GGUF → forgeGgufScan → writeHoloPackageStream a SEALED .holo to disk
// (peak memory = one block, no region in RAM) → reopen with openHoloPackageDisk → bounded-LRU
// sparse decode. Proves the shippable artifact: one sealed, content-addressed file, decoded by
// streaming only the routed experts in bounded memory == the known whole-stack result.
//
//   node --max-old-space-size=2048 witness-holo-stream.mjs [model.gguf] [N] [csv-prompt] [expect-csv] [budgetMB]

import { openSync, readSync, writeSync, closeSync, statSync, unlinkSync } from "node:fs";
import { parseGgufHeader } from "../qvac-ingest.mjs";
import { forgeGgufScan } from "./gguf-forge.mjs";
import { synthesizeGraph } from "./gguf-forge-graph.mjs";
import { forward } from "./gguf-forge-exec.mjs";
import { writeHoloPackageStream, openHoloPackageDisk } from "./gguf-forge-package.mjs";
import { makeDiskStore } from "./gguf-forge-kstore.mjs";

const MODEL = process.argv[2] || ".models/deepseek-v2-lite-q4_k_m.gguf";
const N = +(process.argv[3] || 2);
const PROMPT = (process.argv[4] || "100000,549,6077,280,7239,317,8913,13,429,6077,280,11357,317").split(",").map(Number);
const EXPECT = process.argv[5] ? process.argv[5].split(",").map(Number) : null;
const BUDGET = (+(process.argv[6] || 2048)) * 1024 * 1024;
const HOLO = MODEL.replace(/\.gguf$/, "") + ".holo";

const t0 = Date.now(); const el = () => ((Date.now() - t0) / 1000).toFixed(1);
let peakRss = 0; const mem = () => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; return (r / 1e9).toFixed(2) + "GB"; };
const fail = (m) => { console.error(`\nFAIL — ${m}`); process.exit(1); };
const hexOf = (k) => String(k).split(":").pop();

const fd = openSync(MODEL, "r"); const size = statSync(MODEL).size;
const readRange = async (off, len) => { const b = Buffer.allocUnsafe(len); let g = 0; while (g < len) { const n = readSync(fd, b, g, len - g, off + g); if (n <= 0) break; g += n; } return new Uint8Array(b.buffer, b.byteOffset, len); };
const headerBytes = await readRange(0, Math.min(64 * 1024 * 1024, size));
let hdr; try { hdr = parseGgufHeader(headerBytes); } catch (e) { fail(`header parse: ${e.message}`); }
console.log(`[${el()}s] ${MODEL.split("/").pop()} ${(size / 1e9).toFixed(2)}GB arch=${hdr.meta["general.architecture"]} tensors=${hdr.tensors.length}`);

// (1) disk-backed forge: κ + dir + expertDir, no model in RAM
const scan = await forgeGgufScan(readRange, { headerBytes });
console.log(`[${el()}s] scanned: ${Object.keys(scan.dir).length} κ-blocks, root ${scan.rootKappa.slice(0, 28)}…  RSS ${mem()}`);

// (2) stream a SEALED .holo to disk — one block in flight, no region in RAM
const hfd = openSync(HOLO, "w");
const sink = (b) => { let o = 0; while (o < b.length) o += writeSync(hfd, b, o, b.length - o); };
const res = await writeHoloPackageStream(scan, (loc) => readRange(loc.fileOffset, loc.len), sink);
closeSync(hfd);
const holoSize = statSync(HOLO).size;
console.log(`[${el()}s] sealed ${HOLO.split("/").pop()} ${(holoSize / 1e9).toFixed(2)}GB  packageKappa ${res.packageKappa.slice(0, 28)}…  RSS ${mem()} (peak = one block)`);

// (3) reopen disk-backed and decode bounded
const rfd = openSync(HOLO, "r");
const hReadSync = (off, len) => { const b = Buffer.allocUnsafe(len); let g = 0; while (g < len) { const n = readSync(rfd, b, g, len - g, off + g); if (n <= 0) break; g += n; } return new Uint8Array(b.buffer, b.byteOffset, len); };
const disk = openHoloPackageDisk(rfd, hReadSync);
if (disk.model !== scan.rootKappa) fail(`.holo model κ ${disk.model} != scan root ${scan.rootKappa}`);
const graph = synthesizeGraph(disk.plan);
if (!["dense", "moe", "mla-moe"].includes(graph.family)) fail(`graph family=${graph.family}`);
const isMoE = (graph.stats.n_expert || 0) > 0;
console.log(`[${el()}s] reopened .holo: family=${graph.family} layers=${graph.stats.n_layer} experts=${graph.stats.n_expert || 0}/${graph.stats.n_expert_used || 0}`);

const store = makeDiskStore({ fd: rfd, dir: disk.dir, budgetBytes: BUDGET });
const fastload = (st, k) => { const b = st.get(hexOf(k)); if (b === undefined) throw new Error("κ not found " + k); return b; };
const seq = [...PROMPT], gen = [];
for (let i = 0; i < N; i++) {
  const lg = forward(disk.plan, graph, store, seq, { load: fastload, expertDir: isMoE ? disk.expertDir : undefined });
  let am = 0; for (let j = 1; j < lg.length; j++) if (lg[j] > lg[am]) am = j;
  gen.push(am); seq.push(am);
  console.log(`[${el()}s]   tok ${i + 1}/${N} = ${am}   RSS ${mem()} · LRU ${(store.stats.bytes() / 1e9).toFixed(2)}GB · reads ${store.stats.reads} evict ${store.stats.evicted}`);
}
closeSync(rfd);
try { unlinkSync(HOLO); } catch {}                                  // clean up the big artifact

console.log(`[${el()}s] .holo-streamed gen: ${gen.join(" ")}`);
if (EXPECT && !(gen.length >= EXPECT.length && EXPECT.every((v, i) => v === gen[i]))) fail(`decode ${gen.join(" ")} != expected ${EXPECT.join(" ")}`);
const peakGB = peakRss / 1e9, modelGB = size / 1e9;
console.log(`\nPASS — ${MODEL.split("/").pop()}: forged → sealed .holo → disk-streamed decode${EXPECT ? " (== whole-stack " + EXPECT.join(" ") + ")" : ""}.`);
console.log(`  .holo ${(holoSize / 1e9).toFixed(2)}GB sealed · peak RSS ${peakGB.toFixed(2)}GB on a ${modelGB.toFixed(2)}GB model (${(peakGB / modelGB * 100).toFixed(0)}%)`);
console.log(`  LRU peak ${(store.stats.peak / 1e9).toFixed(2)}GB · ${store.stats.reads} reads · ${store.stats.evicted} evict · ${store.stats.verified} verified · ${store.stats.refused} refused`);
console.log(`  [${el()}s total]`);
process.exit(0);
