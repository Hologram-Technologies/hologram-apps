// GLM-5.2 real-config graph validation (Phase 2, adapted to the HF-Xet constraint).
// The real tensor TABLE is past the 9.4 MB tokenizer in a Xet-backed file (not range-fetchable
// without a Xet client), but the real HPARAMS are in the validated header. This reads them and
// generates the tensor manifest our deepseek2/glm-dsa builder requires (exact names from
// gguf-forge-graph.mjs:289-326), then proves synthesizeGraph builds a correct FULL-SCALE
// 79-layer / 256-expert / non-lite mla-moe graph with the DSA indexer inert — and projects the
// sealed .holo + per-token sparse transport for the real model.
//
// HONEST SCOPE: validates our builder against GLM-5.2's real CONFIG at scale, using the tensor
// NAMES our builder expects (which the real GGUF must match). Confirming the real GGUF uses
// exactly these names is the one check that needs the actual download (Phase 3).
//
//   node witness-glm52-graph.mjs [header.bin]

import { readFileSync } from "node:fs";
import { parseGgufHeader } from "../qvac-ingest.mjs";
import { synthesizeGraph } from "./gguf-forge-graph.mjs";

const HDR = process.argv[2] || "C:/tmp/glm52/p1.bin";
const buf = new Uint8Array(readFileSync(HDR));
const hdr = parseGgufHeader(buf);
const m = hdr.meta, A = m["general.architecture"];
const g = (k, d) => m[`${A}.${k}`] ?? d;
const n_layer = g("block_count"), n_embd = g("embedding_length"), n_head = g("attention.head_count");
const n_expert = g("expert_count"), n_used = g("expert_used_count"), n_shared = g("expert_shared_count", 0);
const lead = g("leading_dense_block_count", 0), kv_lora = g("attention.kv_lora_rank");
const q_lora = g("attention.q_lora_rank", 0), key_len = g("attention.key_length"), val_len = g("attention.value_length");
const ff_exp = g("expert_feed_forward_length", g("feed_forward_length", 1408));
const idxFreq = g("attention.indexer.top_k") != null ? 4 : 0;   // ~1 layer in 4 carries indexer (index_topk_freq)
console.log(`GLM-5.2 real hparams: ${A} | ${n_layer} layers | n_embd ${n_embd} | ${n_expert} experts (${n_used} used, ${n_shared} shared) | lead_dense ${lead} | q_lora ${q_lora} (non-lite) | kv_lora ${kv_lora} | key/val ${key_len}/${val_len}\n`);

// generate the manifest the builder requires (gguf-forge-graph.mjs:289-326)
const T = [], add = (name, dims) => T.push({ name, dims, type: 0, typeName: "F32", nbytes: 0, kappa: `sha256:${T.length.toString(16).padStart(64, "0")}` });
add("token_embd.weight", [n_embd, 200000]);
add("output_norm.weight", [n_embd]); add("output.weight", [n_embd, 200000]);
for (let il = 0; il < n_layer; il++) {
  const p = `blk.${il}.`;
  add(p + "attn_norm.weight", [n_embd]);
  if (q_lora > 0) { add(p + "attn_q_a.weight", [n_embd, q_lora]); add(p + "attn_q_a_norm.weight", [q_lora]); add(p + "attn_q_b.weight", [q_lora, n_head * key_len]); }
  else add(p + "attn_q.weight", [n_embd, n_head * key_len]);
  add(p + "attn_kv_a_mqa.weight", [n_embd, kv_lora + (key_len - (key_len - g("rope.dimension_count", 64)))]);
  add(p + "attn_kv_a_norm.weight", [kv_lora]);
  add(p + "attn_kv_b.weight", [kv_lora, n_head * (key_len + val_len)]);
  add(p + "attn_output.weight", [n_head * val_len, n_embd]);
  add(p + "ffn_norm.weight", [n_embd]);
  if (il >= lead) {                                  // MoE layer
    add(p + "ffn_gate_inp.weight", [n_embd, n_expert]);
    add(p + "ffn_gate_exps.weight", [n_embd, ff_exp, n_expert]);
    add(p + "ffn_up_exps.weight", [n_embd, ff_exp, n_expert]);
    add(p + "ffn_down_exps.weight", [ff_exp, n_embd, n_expert]);
    add(p + "exp_probs_b", [n_expert]);
    if (n_shared > 0) { add(p + "ffn_gate_shexp.weight", [n_embd, ff_exp * n_shared]); add(p + "ffn_up_shexp.weight", [n_embd, ff_exp * n_shared]); add(p + "ffn_down_shexp.weight", [ff_exp * n_shared, n_embd]); }
    if (idxFreq && il % idxFreq === 0) { add(p + "indexer.attn_q_b.weight", [q_lora, 32 * 128]); add(p + "indexer.attn_k.weight", [n_embd, 128]); add(p + "indexer.k_norm.weight", [128]); add(p + "indexer.proj.weight", [n_embd, 128]); }
  } else { add(p + "ffn_gate.weight", [n_embd, ff_exp * 8]); add(p + "ffn_up.weight", [n_embd, ff_exp * 8]); add(p + "ffn_down.weight", [ff_exp * 8, n_embd]); }
}

const plan = { format: "gguf-forge/1", arch: A, ggufVersion: hdr.version, meta: m, tensors: T };
const gr = synthesizeGraph(plan);
const ok = (c, msg) => console.log(`  ${c ? "ok " : "XX "} ${msg}`);
console.log(`synthesizeGraph → family: ${gr.family}`);
ok(gr.family === "mla-moe", `family mla-moe`);
ok(gr.stats.n_layer === n_layer, `${gr.stats.n_layer} layers`);
ok(gr.stats.n_expert === n_expert && gr.stats.n_expert_used === n_used, `${gr.stats.n_expert} experts / ${gr.stats.n_expert_used} used`);
ok(gr.stats.lite === false, `non-lite MLA (q_a/q_b)`);
ok(gr.stats.n_dense_lead === lead, `leading_dense ${gr.stats.n_dense_lead}`);
ok(gr.stats.n_shared === n_shared, `${gr.stats.n_shared} shared expert`);
ok(gr.stats.gating === "sigmoid", `gating ${gr.stats.gating}`);
const idxRefd = Object.keys(gr.weights).some((n) => n.includes("indexer"));
ok(!idxRefd, `DSA indexer tensors present but NOT referenced (dense path)`);
const mlaOps = gr.ops.filter((o) => o.op === "mla_attn"), moeOps = gr.ops.filter((o) => o.op === "ffn_moe");
ok(mlaOps.length === n_layer && mlaOps.every((o) => o.w.q_a && o.w.q_b), `${mlaOps.length} non-lite mla_attn ops`);
ok(moeOps.length === n_layer - lead, `${moeOps.length} ffn_moe ops (layers ${lead}..${n_layer - 1})`);

// sparse-transport projection for the real model
const moeLayers = n_layer - lead, expBlocksTotal = moeLayers * n_expert * 3, perToken = moeLayers * n_used * 3;
console.log(`\nGLM-5.2 .holo projection (real config):`);
console.log(`  MoE layers ${moeLayers} · per-expert κ-blocks ${expBlocksTotal.toLocaleString()} (${n_expert}×3×${moeLayers})`);
console.log(`  per-token expert fetch: ${perToken.toLocaleString()} slices (${n_used}×3×${moeLayers}) = ${(perToken / expBlocksTotal * 100).toFixed(1)}% of experts`);
console.log(`  → streams ~${(perToken / expBlocksTotal * 100).toFixed(1)}% of the 256-expert weight per token; the other ${(100 - perToken / expBlocksTotal * 100).toFixed(1)}% never touches memory`);
