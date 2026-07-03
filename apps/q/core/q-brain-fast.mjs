// core/q-brain-fast.mjs — Q's FAST on-device brain, drop-in for createHoloModelBrain.
//
// Same provider shape (load · generate → text-delta async-iterator · chat · info · setSkill), so
// holo-q-contact.mjs's makeQResponder / makeQGroupResponder bind it with ZERO changes: Q rides the exact
// stream→finalize pipeline, it just sources its bytes from THIS engine (core/loader + core/engine — the
// native-ternary κ-object path with the fixed incremental-detok decode) instead of the qwen holo-brain.
//
// Why this exists: the messenger's default brain (qwen2.5-0.5b via holo-brain-engine) is heavy and its
// app-path decode was O(n²). This one loads a native-ternary BitNet κ-object (0.69 GB, verified per-block),
// decodes at ~70 tok/s warm, and streams byte-identical incremental text. It is 100% on-device at decode
// time — only a ONE-TIME tokenizer-header Range fetch touches the source host at load (the weights are the
// local, L5-verified b/<κ>.gz blocks). Bundle the header to make load fully egress-free (follow-up).
//
// URL discipline (the one gotcha): core/loader's MODELS use a PAGE-relative kappaUrl ("./models/<name>"),
// which is wrong from any page other than /apps/q/. loadKappaObject resolves the manifest, blocks AND the
// bundled tokenizer relative to its baseUrl, so we override kappaUrl to an ABSOLUTE mount ("/apps/q/models/
// <name>") — that makes the whole load self-contained from the messenger (or anywhere).

import { ready, loadModel, MODELS } from "./loader.js";
import { createEngine } from "./engine.js";
import { selfFacts, selfPersona, selfIntro } from "./q-self.mjs";   // Q's live, grounded self-knowledge (M0)

// The default fast brain = BitNet-2B (native ternary, llama3 template, coherent — Falcon-E degenerates).
// Override via opts.family / opts.modelName. kappaBase is the absolute mount core/loader's models live under.
const DEFAULTS = { family: "BitNet", kappaBase: "/apps/q/models", maxTokens: 512 };

function pickModel(cfg) {
  const want = String(cfg.modelName || cfg.family || "BitNet").toLowerCase();
  const m = MODELS.find((x) => (x.fam || "").toLowerCase() === want || (x.name || "").toLowerCase().includes(want)) || MODELS.find((x) => (x.fam || "").toLowerCase() === "bitnet");
  if (!m) throw new Error("q-brain-fast: no model matches " + want);
  // An ABSOLUTE host URL (the κ-object now lives on HF, not on this machine) is already page-independent —
  // use it verbatim. Only a page-relative "./models/<name>" needs absolute-mounting so it resolves from ANY page.
  if (/^https?:\/\//.test(m.kappaUrl || "")) return { ...m };
  const rel = String(m.kappaUrl || "").replace(/^\.?\//, "").replace(/^models\//, "");   // "./models/bitnet-2b" → "bitnet-2b"
  return { ...m, kappaUrl: String(cfg.kappaBase).replace(/\/+$/, "") + "/" + rel };
}

// Render an [{role,content}] history (system + turns, as makeQResponder builds it) to the model's chat
// template — the multi-turn generalization of core/engine's single-turn frameTurn. Covers the templates
// the engine knows; unknown families fall back to a persona-led last-user Q/A frame.
function frameHistory(M, history) {
  const list = Array.isArray(history) ? history : [];
  // merge ALL system turns into one system block (persona + any injected context, e.g. M1 grounded retrieval) —
  // taking only the first would silently DROP injected context and the model would fall back to a generic refusal.
  const persona = list.filter((x) => x && x.role === "system" && x.content).map((x) => x.content).join("\n\n");
  const turns = list.filter((x) => x && x.role !== "system" && (x.content || "").length);

  if (M.llama3) {
    let s = persona ? `<|start_header_id|>system<|end_header_id|>\n\n${persona}<|eot_id|>` : "";
    for (const t of turns) s += `<|start_header_id|>${t.role === "assistant" ? "assistant" : "user"}<|end_header_id|>\n\n${t.content}<|eot_id|>`;
    return s + `<|start_header_id|>assistant<|end_header_id|>\n\n`;
  }
  if (M.qwen) {
    const noThink = M.qwen3 ? "<think>\n\n</think>\n\n" : "";
    let s = persona ? `<|im_start|>system\n${persona}<|im_end|>\n` : "";
    for (const t of turns) s += `<|im_start|>${t.role === "assistant" ? "assistant" : "user"}\n${t.content}<|im_end|>\n`;
    return s + `<|im_start|>assistant\n` + noThink;
  }
  if (M.olmo) {
    let s = persona ? `<|system|>\n${persona}\n` : "";
    for (const t of turns) s += t.role === "assistant" ? `<|assistant|>\n${t.content}\n` : `<|user|>\n${t.content}\n`;
    return s + `<|assistant|>\n`;
  }
  // word-frame / plain: only the last user turn carries (base models have no multi-turn template)
  const lastUser = [...turns].reverse().find((t) => t.role !== "assistant");
  const q = (lastUser && lastUser.content) || "";
  if (M.userWord) return (persona ? persona + "\n" : "") + "User: " + q + "\nFalcon:";
  return (persona ? persona + "\n" : "") + "Question: " + q + "\nAnswer:";
}

export function createFastQBrain(opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const M = pickModel(cfg);
  let engine = null, loadingP = null;
  let info = { ready: false, model: M.name, device: null, resident: false };

  // encode a history to the running token ids (framed + optional bos), ready for engine.generate
  function idsFor(history) {
    let ids = engine.tokenize(frameHistory(M, history));
    if (M.bos && engine.bosId != null) ids = [engine.bosId, ...ids];
    return ids;
  }

  async function load(onProgress) {
    if (engine) return info;
    if (loadingP) return loadingP;
    loadingP = (async () => {
      if (!(typeof navigator !== "undefined" && navigator.gpu)) throw new Error("no WebGPU on this device");
      await ready();   // wasm tokenizer init (shared instance)
      const loaded = await loadModel(M, {
        onStatus: () => {},
        onProgress: (d, t, w) => { try { onProgress && onProgress({ done: d, total: t, phase: w, model: M.name }); } catch (e) {} },
      });
      if (!loaded || !loaded.gpu) throw new Error("q-brain-fast: model load failed (" + M.name + ")");
      engine = await createEngine(M, loaded);
      // MEASURED from the real engine, not asserted: device/resident reflect an engine that actually uploaded
      // weights to the GPU (dims + gpuBytes are live signals) — so info() can never claim residency it lacks.
      info = { ready: true, model: M.name, device: (engine && engine.dims ? "webgpu" : null), resident: !!(engine && (engine.gpuBytes || engine.dims)) };
      return info;
    })().catch((e) => { loadingP = null; throw e; });
    return loadingP;
  }
  async function ensure(onProgress) { if (!engine) await load(onProgress); return engine; }

  // generate(history, { signal, onProgress }) → async-iterator of TEXT DELTAS (exactly what makeQResponder
  // accumulates + paints via onDelta). engine.generate reports CUMULATIVE text per step; we diff to deltas
  // and pump them through a small queue so this stays a clean generator (and honors the abort signal).
  async function* generate(history, o = {}) {
    await ensure(o.onProgress);
    if (!engine) return;
    const signal = o.signal || null;
    const ids = idsFor(history);
    const cap = o.maxTokens || cfg.maxTokens || M.cap || 256;

    const queue = []; let done = false, wake = null, prev = "";
    const kick = () => { if (wake) { const w = wake; wake = null; w(); } };
    const run = engine.generate(ids, {
      maxNew: cap, signal,
      onToken: ({ text }) => { const d = (text || "").slice(prev.length); if (d) { prev = text; queue.push(d); kick(); } },
    }).then(() => { done = true; kick(); }).catch(() => { done = true; kick(); });

    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (done) break;
      if (signal && signal.aborted) break;
      await new Promise((r) => (wake = r));
    }
    try { await run; } catch (e) {}
  }

  // chat(history, opts) → full string (used by window.HoloQ.generate + light background features)
  async function chat(history, o = {}) {
    await ensure(o.onProgress);
    if (!engine) return "";
    const res = await engine.generate(idsFor(history), { maxNew: o.maxTokens || cfg.maxTokens || M.cap || 256, signal: o.signal || null });
    return ((res && res.text) || "").trim();
  }

  // native-ternary κ-object → no LoRA adapters; skill routing is a no-op (the base is the specialist).
  const setSkill = async () => ({ adapter: false, unsupported: true });
  const setAdapter = async () => ({ adapter: false, unsupported: true });

  // Q's LIVE self-knowledge (M0), derived from THIS instance's real model + engine κ — the grounded truth
  // every surface leads with so Q is honestly self-aware and never confabulates a cloud identity. Available
  // even before load (identity is in M); the κ fills in once the engine is resident.
  const facts = () => selfFacts({ model: M, engine });
  const persona = () => selfPersona({ model: M, engine });
  const intro = () => selfIntro({ model: M, engine });

  return { id: "q-brain-fast-" + (M.fam || M.name), load, generate, chat, setSkill, setAdapter, info: () => info, facts, persona, intro };
}

export default createFastQBrain;
