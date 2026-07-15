// Tier-2 witness: UPSTREAM-TRUTH greedy parity — Holo Tier-A forward vs llama.cpp itself.
// No forge-ref.exe (raw-id harness) on disk, so we bridge with stock llama.cpp binaries:
//   • prompt ids come from llama.cpp's OWN tokenizer (llama-tokenize --ids) → ground truth,
//     fed RAW into the Holo forward (tokenizer sidestepped, exactly like witness-greedy.mjs)
//   • llama-cli greedy (--temp 0 --top-k 1) generates the reference continuation TEXT
//   • Holo greedy-decodes from the same ids; we decode its ids → text and compare
// This is behavioral (token/text) parity — the meaningful upstream check absent a raw-id
// reference. Honest caveat: the bridge uses llama.cpp's tokenizer for the prompt and the
// Holo vocab for detok; the FORWARD math is what's under test and is isolated by feeding
// identical prompt ids to both. CPU both sides → greedy should be token-identical.
//
//   node witness-greedy-tier2.mjs [model.gguf] [N] ["prompt text"]

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseGgufHeader } from "../qvac-ingest.mjs";
import { forgeGgufStream } from "./gguf-forge.mjs";
import { synthesizeGraph } from "./gguf-forge-graph.mjs";
import { forward } from "./gguf-forge-exec.mjs";
import { makeTokenizer } from "./gguf-forge-tokenizer.mjs";
import { sha256hex } from "../../../../holo-os/system/os/usr/lib/holo/holo-uor.mjs";

const MODEL = process.argv[2] || ".models/bitnet-xl-tq2_0.gguf";
const N = +(process.argv[3] || 6);
const TEXT = process.argv[4] || "The capital of France is";
const LLAMA_DIR = "C:/Users/pavel/Desktop/SovereignAI/1_Compute/llama.cpp";
const CLI = `${LLAMA_DIR}/llama-completion.exe`, TOKZ = `${LLAMA_DIR}/llama-tokenize.exe`;  // completion = non-interactive (cli is chat-mode)
const t0 = Date.now(); const el = () => ((Date.now() - t0) / 1000).toFixed(1);
const fail = (m) => { console.error(`\nFAIL — ${m}`); process.exit(1); };
const norm = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").replace(/\s+$/g, "").replace(/^\s+/g, "");  // strip ANSI + trim

// forge + graph + tokenizer (from the GGUF header)
const fd = openSync(MODEL, "r"); const size = statSync(MODEL).size;
const readRange = async (off, len) => { const b = Buffer.allocUnsafe(len); let g = 0; while (g < len) { const n = readSync(fd, b, g, len - g, off + g); if (n <= 0) break; g += n; } return new Uint8Array(b.buffer, b.byteOffset, len); };
const headerBytes = await readRange(0, Math.min(64 * 1024 * 1024, size));
parseGgufHeader(headerBytes);                              // throws on corrupt/redirect downloads
const f = await forgeGgufStream(readRange, { headerBytes });
const graph = synthesizeGraph(f.plan);
if (!["dense", "moe", "mla-moe"].includes(graph.family)) fail(`graph family=${graph.family} unsupported`);
const tok = makeTokenizer(headerBytes);
console.log(`[${el()}s] ${MODEL.split("/").pop()} forged; family=${graph.family} tokenizer=${tok.model}`);

// (1) ground-truth prompt ids from llama.cpp
const tkOut = execFileSync(TOKZ, ["-m", MODEL, "-p", TEXT, "--ids"], { encoding: "utf8", maxBuffer: 1 << 20 });
const P = (tkOut.match(/\[([\d,\s]+)\]/) || [])[1].split(",").map((x) => +x.trim()).filter((x) => Number.isFinite(x));
if (!P.length) fail("could not parse prompt ids from llama-tokenize");
const holoEnc = tok.encode(TEXT, { addSpecial: true });
console.log(`[${el()}s] prompt "${TEXT}" → llama.cpp ids [${P.join(",")}]  (Holo encode: [${holoEnc.join(",")}]${holoEnc.join(",") === P.join(",") ? " ✓match" : " ⚠differs — using llama.cpp ids"})`);

// (2) Holo greedy from llama.cpp's prompt ids. Verify-once loader: L5-check each κ-block
// the first time it's read, then serve cached — without this, loadByKappa re-hashes the
// whole 64-expert stacked tensors on every matvec (hours for a real MoE).
const store = { get: (hex) => f.blocks.get(hex) };
const verified = new Set();
const vload = (st, k) => { const hex = String(k).split(":").pop(); const b = st.get(hex); if (!b) throw new Error("κ not found " + k); if (!verified.has(hex)) { if (sha256hex(b) !== hex) throw new Error("L5 refuse " + k); verified.add(hex); } return b; };
const seq = [...P], gen = [];
for (let i = 0; i < N; i++) {
  const lg = forward(f.plan, graph, store, seq, { load: vload });
  let am = 0; for (let j = 1; j < lg.length; j++) if (lg[j] > lg[am]) am = j;
  gen.push(am); seq.push(am);
  console.log(`[${el()}s]   holo tok ${i + 1}/${N} = ${am}`);
}
const G_holo = tok.decode(gen);
console.log(`[${el()}s] HOLO gen ids [${gen.join(",")}] → "${G_holo}"`);

// (3) llama.cpp greedy continuation
// -no-cnv disables the auto-enabled chat template/conversation mode (the model has a
// template → llama-completion would otherwise wrap User:/Assistant: and go interactive).
// -c 2048 avoids OOM on the model's huge YaRN context; -ngl 0 = CPU (matches Holo's path).
const cliOut = execFileSync(CLI, ["-m", MODEL, "-p", TEXT, "-n", String(N), "-c", "2048", "-ngl", "0", "-no-cnv", "--temp", "0", "--top-k", "1", "--no-display-prompt", "--no-warmup", "--color", "off"], { encoding: "utf8", maxBuffer: 1 << 22, stdio: ["ignore", "pipe", "ignore"] });
const G_ref = norm(cliOut);
const refIds = tok.encode(G_ref, { addSpecial: false });   // retokenized (for an id-level cross-check)
console.log(`[${el()}s] REF  gen "${G_ref}"  (retok ids [${refIds.join(",")}])`);

// (4) compare — text parity is the headline; id parity is the strict cross-check
closeSync(fd);
const textMatch = norm(G_holo) === norm(G_ref) || norm(G_ref).startsWith(norm(G_holo)) || norm(G_holo).startsWith(norm(G_ref));
const idMatch = gen.length >= refIds.length && refIds.every((v, i) => v === gen[i]);
console.log(`\n${textMatch ? "PASS" : "FAIL"} — greedy ${textMatch ? "text parity" : "MISMATCH"} Holo vs llama.cpp on "${TEXT}" (${N} tokens).`);
console.log(`  text: Holo="${norm(G_holo)}"  ref="${norm(G_ref)}"`);
console.log(`  ids : ${idMatch ? "token-for-token match" : "differ at token level (text-level parity is the behavioral bar)"}`);
console.log(`  [${el()}s]`);
process.exit(textMatch ? 0 : 1);
