// core/engine.js — the inference ENGINE adapter (the only module that touches the wasm
// tokenizer + the WebGPU `gpu` object). DOM-free. Wraps a model that core/loader.js has
// already loaded onto the GPU and exposes a clean, UI-agnostic API:
//
//   const engine = await createEngine(modelEntry, { gpu, info, imageKappa });
//   const { text, outIds } = await engine.generate(ids, { onToken, signal });
//   const rec = await engine.buildReceipt({ ... });   // PROV-O, re-derivable (Law L5)
//
// The token loop, framing, memo and receipt logic are lifted byte-for-byte from the
// original index.html think()/run()/sealReceipt — only the DOM writes are replaced by an
// onToken callback and the running/handedOff flags by an AbortSignal, so output (and the
// receipt κ) is identical to the original app.

import { qvac_tokenize, qvac_continue, kappa } from "../pkg/holospaces_web.js";
import { clean, didHolo, kappaTokens, sealReceipt, verifyIntegrity, idBytes, kappaBytes } from "./kappa.js";

const _perf = () => (typeof performance !== "undefined" ? performance.now() : 0);
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The engine is itself a content-addressed object — hash the wasm once (lazy).
let _engineK = null;
export async function engineKappa() {
  if (_engineK) return _engineK;
  try { const b = new Uint8Array(await (await fetch(new URL("../pkg/holospaces_web_bg.wasm", import.meta.url))).arrayBuffer()); _engineK = await kappaBytes(b); }
  catch { _engineK = "did:holo:sha256:(engine unavailable)"; }
  return _engineK;
}

export async function createEngine(modelEntry, loaded) {
  const { gpu, info, imageKappa } = loaded;
  const m = modelEntry;
  const engineReady = engineKappa();

  // model κ: the κ-disk's VERIFIED image_kappa when present (a real content address of the
  // weights, every sector re-derived); else the model's declared identity.
  const modelKappa = imageKappa
    ? "did:holo:sha256:" + String(imageKappa).replace(/^(did:holo:)?sha256:/, "")
    : await didHolo({ "@type": "schema:SoftwareSourceCode", name: m.name, size: m.size, fmt: m.fmt || "", family: m.fam || "" });

  const memo = new Map();

  const tokenize = (text) => { try { return JSON.parse(qvac_tokenize(text)).ids || []; } catch { return []; } };
  const detokenize = (ids) => { try { return clean(JSON.parse(qvac_continue(JSON.stringify(ids), 0, 0, 0, ids.length)).text || ""); } catch { return ""; } };
  const fingerprint = (ids) => kappa(idBytes(ids));   // live mind κ (blake3, from wasm)

  // Frame one user turn. Qwen2/3 use ChatML (its <|im_*|> markers are atomic BPE tokens);
  // other instruction models use a plain Q/A frame. (Verbatim from the original run().)
  function frameTurn(prompt, hasHistory) {
    if (m.qwen) {
      const noThink = m.qwen3 ? "<think>\n\n</think>\n\n" : "";   // Qwen3: skip the thinking block for fast direct answers
      return (hasHistory ? "<|im_end|>\n" : "") + `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n` + noThink;
    }
    if (m.llama3)                                                  // LLaMA-3 header template (BitNet b1.58 etc.)
      return (hasHistory ? "<|eot_id|>" : "") + `<|start_header_id|>user<|end_header_id|>\n\n${prompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;
    if (m.olmo)                                                    // OLMo/OLMoE: <|user|>/<|assistant|> role tags (each turn self-delimited; leading bos via m.bos)
      return `<|user|>\n${prompt}\n<|assistant|>\n`;
    if (m.userWord)                                                // word-frame (Falcon-E: its ChatML template stalls EMPIRICALLY; "User:/Falcon:" answers — see q-falcon-templates sweep)
      return (hasHistory ? "\n" : "") + "User: " + prompt + "\nFalcon:";
    return "Question: " + prompt + "\nAnswer:";
  }

  function params() {
    const temp = m.temp || 0;
    return { decode: temp > 0 ? "sampled@t=" + temp : "greedy-argmax", maxTokens: m.cap, repetitionPenalty: m.rep ?? 1.05, template: m.qwen ? "chatml" : m.llama3 ? "llama3" : "qa", thinking: !m.qwen3 };
  }

  // The streaming token loop. `ids` is the whole running conversation (the mind); generation
  // appends to it. onToken({ text, ids, outIds, stats }) fires per step; signal aborts.
  async function generate(ids, { onToken, signal, repPenalty, maxNew } = {}) {
    const rep = repPenalty ?? m.rep ?? 1.3;
    const newCap = maxNew ?? m.cap ?? 80;                       // max NEW tokens this call
    const kvCap = (m.ctx || m.cap || 80) + 8;                   // the engine's KV allocation (loader kvOf)
    const promptLen = ids.length;
    const tStart = _perf();
    let first = true, decodeStart = 0, decodeTok = 0, ttft = 0, tokps = 0, msExec = 0, err = null;
    if (promptLen >= kvCap - 1) err = new Error(`context full: ${promptLen} tokens ≥ ${kvCap} KV positions`);
    while (!err && !(signal && signal.aborted) && ids.length - promptLen < newCap && ids.length < kvCap - 1) {
      const prevLen = ids.length;
      try { ids = await (gpu.decode || gpu.generate)(ids, first ? 1 : 6, rep); }   // batched GPU decode head (4 B/token readback) when the engine has it
      catch (e) { err = e; break; }
      const dn = ids.length - prevLen;
      if (dn > 0) {
        msExec = gpu.timing ? gpu.timing.exec : msExec;
        if (first) { ttft = _perf() - tStart; decodeStart = _perf(); first = false; }   // TTFT = prefill + first token
        else { decodeTok += dn; const dt = _perf() - decodeStart; if (dt > 0) tokps = decodeTok / (dt / 1000); }   // steady decode rate
      }
      const di = ids.slice(promptLen);
      let text = detokenize(di), hitStop = false;
      if (m.stopText) { const ix = text.indexOf(m.stopText); if (ix >= 0) { text = text.slice(0, ix); hitStop = true; } }   // word-framed models stop on the next "User:" turn
      if (onToken) onToken({ text, ids: ids.slice(), outIds: di.slice(), stats: { ttft, tokps, msExec, gpuBytes: gpu.gpuBytes } });
      if (hitStop) break;
      if (ids.length <= prevLen) break;    // EOS / no progress
      // degeneration guard: a long run of one repeated character (the repetition collapse of
      // small/experimental quants) will never recover — stop instead of burning the budget.
      if (text.length > 80 && /(.)\1{63}$/.test(text)) { err = new Error("degenerate repetition — stopped"); break; }
      await _sleep(25);
    }
    const outIds = ids.slice(promptLen);
    let text = detokenize(outIds);
    if (m.stopText) { const ix = text.indexOf(m.stopText); if (ix >= 0) text = text.slice(0, ix); }
    return { text, outIds, ids, stats: { ttft, tokps, msExec }, error: err };
  }

  // DIFFUSION decode (Dream-class): iterative bidirectional unmasking over a fixed `steps` budget,
  // wall-clock fixed by steps not output length. Greedy ⇒ deterministic ⇒ κ-re-derivable (Law L5).
  // `ids` is the framed prompt; we diffuse `genLen` masked positions after it. Returns the same shape
  // as generate() so callers (and the brain seam) are agnostic. onToken fires ONCE with the final fill
  // (diffusion has no left-to-right token stream — the whole block resolves together).
  // Two modes: APPEND (genLen masks at the suffix — generation) or FILL (ids ALREADY contain mask ids
  // anywhere → infill/surgical edit, conditioning on BOTH sides; diffusion's structural edge over AR).
  // `causal` flips the parity gate (causal block=1 must equal the sequential engine — validates the pass).
  async function diffuse(ids, { genLen, steps, fill, causal, signal, onToken } = {}) {
    if (!gpu || !gpu.diffuse) throw new Error("this model has no diffusion engine (load a diffusion κ-object)");
    const gl = fill ? 0 : (genLen ?? Math.min(m.cap || 64, (m.ctx || 192) - ids.length - 1));
    const S = steps ?? m.steps ?? 12;
    const tStart = _perf();
    const seq = await gpu.diffuse(ids, gl, { steps: S, fill: !!fill, causal: !!causal, signal });
    // append → output is the generated suffix; fill → the whole sequence is the answer (a span edited in place)
    const outIds = fill ? seq.slice() : seq.slice(ids.length);
    let text = detokenize(outIds);
    if (m.stopText && !fill) { const ix = text.indexOf(m.stopText); if (ix >= 0) text = text.slice(0, ix); }
    const stats = { ttft: _perf() - tStart, tokps: 0, msExec: gpu.timing ? gpu.timing.exec : 0, steps: S, fill: !!fill, diff: gpu.diffStats ? gpu.diffStats() : null };
    if (onToken) onToken({ text, ids: seq.slice(), outIds: outIds.slice(), stats });
    return { text, outIds, ids: seq, stats, error: null };
  }

  // κ-memo: identical (context ⊕ prompt ⊕ model ⊕ params) → replay in O(1), no decode.
  const memoKey = async (ctxIds, turnIds, p) => didHolo({ ctx: await kappaTokens(ctxIds.concat(turnIds)), model: modelKappa, params: p || params() });

  async function buildReceipt({ promptText, ctxIds, turnIds, outIds, fromMemo, evaluateText, paramsPatch, extraUsed }) {
    return sealReceipt({
      promptText, ctxIds, turnIds, outIds, text: detokenize(outIds), params: { ...params(), ...(paramsPatch || {}) }, fromMemo,
      modelKappa, engineKappa: await engineReady, evaluateText, extraUsed,
    });
  }

  // Re-derivation (greedy only): re-run the exact inference and reproduce κ(output) byte-for-byte.
  async function reDerive(rec) {
    if (!gpu) return { ok: false, reason: "load the model to re-derive" };
    if (/sampled/.test(rec.params.decode)) return { ok: false, reason: "sampled decode — only the κ-binding is verifiable, not re-derivation" };
    try {
      let seq = rec.ctxIds.concat(rec.turnIds); const start = seq.length;
      gpu.reset();
      seq = await (gpu.decode || gpu.generate)(seq, rec.outIds.length, rec.params.repetitionPenalty);   // same head as the live path — replay must match byte-for-byte
      const got = await kappaTokens(seq.slice(start)), want = rec.body["prov:generated"]["holo:outputTokens"];
      return { ok: got === want, got, want };
    } finally { try { gpu.reset(); } catch {} }
  }

  return {
    model: m, dims: gpu.dims, modelKappa, bosId: info?.bos ?? null, get gpuBytes() { return gpu.gpuBytes; },
    tokenize, detokenize, fingerprint, frameTurn, params,
    generate,
    memoKey, memoGet: (k) => memo.get(k), memoHas: (k) => memo.has(k), memoSet: (k, v) => memo.set(k, v),
    buildReceipt, verify: verifyIntegrity, reDerive,
    stats: () => gpu.timing, reset: () => { try { gpu.reset(); } catch {} }, destroy: () => { try { gpu.destroy(); } catch {} },
  };
}
