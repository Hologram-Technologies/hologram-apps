// Greedy-token parity witness: Holo GGUF Tier-A executor vs llama.cpp (forge-ref.exe
// --gen) on identical prompt token ids. Tokenizer is sidestepped (raw ids fed to
// both), so this isolates the forward pass. Works for dense AND MoE models.
//   node witness-greedy.mjs <model.gguf> <N> [csv-prompt-ids]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { forgeGguf } from "./gguf-forge.mjs";
import { synthesizeGraph } from "./gguf-forge-graph.mjs";
import { forward } from "./gguf-forge-exec.mjs";
import { sha256hex } from "../../../../holo-os/system/os/usr/lib/holo/holo-uor.mjs";

const MODEL = process.argv[2] || ".models/qwen2.5-0.5b-instruct-q4_k_m.gguf";
const N = +(process.argv[3] || 6);
const PROMPT = (process.argv[4] || "785,6722,374,264").split(",").map(Number);
const EXE = "C:/Users/pavel/Desktop/qvac-fabric-llm.cpp-master/qvac-fabric-llm.cpp-master/forge-ref.exe";
const MINGW = "C:/Users/pavel/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin";
const env = { ...process.env, PATH: MINGW + ";" + process.env.PATH };
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

const buf = new Uint8Array(readFileSync(MODEL));
console.log(`[${el()}s] read ${(buf.length / 1e6).toFixed(0)} MB`);
const f = forgeGguf(buf);
console.log(`[${el()}s] forged ${f.tensors.length} tensors → ${f.blocks.size} κ-blocks, root ${f.rootKappa.slice(0, 32)}…`);
const graph = synthesizeGraph(f.plan);
console.log(`[${el()}s] graph: family=${graph.family} ${graph.reason || ""} layers=${graph.stats.n_layer} experts=${graph.stats.n_expert || 0}/${graph.stats.n_expert_used || 0} normW=${graph.stats.normW}`);
if (graph.family !== "dense" && graph.family !== "moe") { console.error("unsupported graph:", graph.reason); process.exit(1); }

const store = { get: (hex) => f.blocks.get(hex) };
const verified = new Set();
const load = (st, k) => { const hex = String(k).split(":").pop(); const b = st.get(hex); if (!b) throw new Error("κ not found " + k); if (!verified.has(hex)) { if (sha256hex(b) !== hex) throw new Error("L5 refuse " + k); verified.add(hex); } return b; };

// Holo GGUF greedy generation (re-forward growing sequence; KV rebuilt each step).
let seq = [...PROMPT]; const gen = [];
for (let i = 0; i < N; i++) {
  const lg = forward(f.plan, graph, store, seq, { load });
  let am = 0; for (let j = 1; j < lg.length; j++) if (lg[j] > lg[am]) am = j;
  gen.push(am); seq.push(am);
  console.log(`[${el()}s] token ${i + 1}/${N} = ${am}`);
}
console.log(`HOLO gen: ${gen.join(" ")}`);

// llama.cpp reference
const out = execFileSync(EXE, [MODEL, "--gen", String(N), ...PROMPT.map(String)], { env, encoding: "utf8", maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] });
const ref = ((out.match(/gen:([\s\d]*)/) || [])[1] || "").trim().split(/\s+/).filter(Boolean).map(Number);
console.log(`REF  gen: ${ref.join(" ")}`);

const match = gen.length === ref.length && gen.every((v, i) => v === ref[i]);
console.log(`\n${match ? "PASS" : "FAIL"} — greedy ${match ? "token-for-token parity" : "MISMATCH"} (Holo GGUF == llama.cpp) over ${N} tokens, prompt [${PROMPT.join(",")}]`);
process.exit(match ? 0 : 1);
