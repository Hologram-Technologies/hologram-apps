// holo-code-providers.mjs — the inference brain, behind one interface so Holo Code is brain-agnostic.
// Claude Code asks a remote server to think; Holo Code asks a LOCAL provider. Two are shipped:
//
//   • local      — a deterministic, no-LLM agent that turns your request into REAL substrate tool
//                   calls (read/grep/edit/…) and narrates grounded results. It is honest: it never
//                   pretends to be a language model. It exists so the agent loop is fully interactive
//                   and witnessable today, with zero model download.
//   • holo-q     — the verifiable on-device LLM (Holo Q / QVAC WebGPU, ADR-0052). Wired here as a
//                   lazy adapter and activated by "Connect Holo Q"; dormant until the model κ-disk is
//                   present. This is the "eventually integrate with Holo Q" seam — surfaced, not faked.
//
// A provider implements:  async *stream(messages, { tools, signal }) → events
//   event ∈ { type:"thinking", text } | { type:"text", text } | { type:"tool_use", name, input }
//          | { type:"end" }
// The loop is stateless across calls: history carries prior tool_use/tool_result, exactly like the spec.

// ── intent parsing for the local agent — a small, legible grammar over the tool catalog ─────────
const lastUser = (messages) => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return String(messages[i].content || ""); return ""; };
const lastIsToolResult = (messages) => messages.length && messages[messages.length - 1].role === "tool";

function parseIntent(text) {
  const t = text.trim();
  let m;
  if ((m = /^(?:read|show|cat|open)\s+(.+)$/i.exec(t))) return { name: "read_file", input: { path: m[1].trim() } };
  if ((m = /^(?:ls|list|dir)(?:\s+(.+))?$/i.exec(t))) return { name: "list_dir", input: { path: (m[1] || "/home/user").trim() } };
  if ((m = /^(?:grep|search)\s+(.+)$/i.exec(t))) return { name: "grep", input: { pattern: m[1].trim() } };
  if ((m = /^(?:glob|find\s+files?)\s+(.+)$/i.exec(t))) return { name: "glob", input: { pattern: m[1].trim() } };
  if ((m = /^verify\s+(.+)$/i.exec(t))) return { name: "verify", input: { path: m[1].trim() } };
  if ((m = /^share\s+(.+)$/i.exec(t))) return { name: "share", input: { path: m[1].trim() } };
  // write <path> :: <content>   (|| separates content; newline-friendly)
  if ((m = /^(?:write|create)\s+(\S+)\s*(?:::|=|:)\s*([\s\S]+)$/i.exec(t))) return { name: "write_file", input: { path: m[1].trim(), content: m[2] } };
  if ((m = /^(?:write|create)\s+(\S+)\s*$/i.exec(t))) return { name: "write_file", input: { path: m[1].trim(), content: "// " + m[1].trim() + " — created by holo code\n" } };
  // in <path> replace <old> with <new>
  if ((m = /^(?:edit|in)\s+(\S+)\s+replace\s+([\s\S]+?)\s+with\s+([\s\S]+)$/i.exec(t))) return { name: "edit_file", input: { path: m[1].trim(), old: m[2], new: m[3] } };
  if ((m = /^build\s+([\s\S]+)$/i.exec(t))) return { name: "build", input: { source: m[1] } };
  if ((m = /^run\s+(.+)$/i.exec(t))) return { name: "run", input: { ref: m[1].trim() } };
  if ((m = /^(?:spawn|delegate|agent)\s+(.+)$/i.exec(t))) return { name: "spawn_agent", input: { goal: m[1].trim() } };
  return null;
}

const HELP = [
  "I'm the local agent — a deterministic brain that runs real tools over your content-addressed workspace. No model download, nothing leaves this machine.",
  "",
  "Try:",
  "  read src/greet.js            · list                      · grep greet",
  "  glob **/*.js                 · verify src/greet.js       · share README.md",
  "  write notes.md :: hello      · in src/greet.js replace world with holo",
  "  spawn refactor the greeter   · build … · run …",
  "",
  "For natural-language reasoning, click “Connect Holo Q” to wire the on-device verifiable LLM (ADR-0052).",
].join("\n");

// summarize a tool result into a short grounded closing line (the assistant's reply after a tool runs).
function summarize(toolName, result) {
  if (!result) return "done.";
  if (result.ok === false) return "That didn't work: " + (result.text || "tool error") + ".";
  switch (toolName) {
    case "read_file": return `Read ${result.meta?.bytes != null ? result.meta.bytes + " bytes from " : ""}the file. It's open in the viewer, addressed by its κ (verifiable, Law L5).`;
    case "list_dir": return `Listed ${result.meta?.count ?? 0} entr${(result.meta?.count === 1) ? "y" : "ies"}.`;
    case "grep": return `Found ${result.meta?.count ?? 0} match${(result.meta?.count === 1) ? "" : "es"}.`;
    case "glob": return `Matched ${result.meta?.count ?? 0} file${(result.meta?.count === 1) ? "" : "s"}.`;
    case "write_file": return `Wrote the file. Its new content address: ${result.kappa || "(derived)"}.`;
    case "edit_file": return `Applied the edit — see the diff in the viewer. New κ: ${result.kappa || "(derived)"}.`;
    case "verify": return result.text;
    case "share": return result.text;
    case "spawn_agent": return result.text;
    default: return result.text || "done.";
  }
}

// ── the local provider ──────────────────────────────────────────────────────────────────────
export const localProvider = {
  id: "local", label: "Local Agent", kind: "deterministic",
  available() { return true; },
  async *stream(messages, _opts = {}) {
    if (lastIsToolResult(messages)) {
      const tr = messages[messages.length - 1];
      yield { type: "text", text: summarize(tr.tool, tr.result) };
      yield { type: "end" };
      return;
    }
    const text = lastUser(messages);
    const intent = parseIntent(text);
    if (!intent) {
      yield { type: "thinking", text: "no tool intent matched — answering directly" };
      const reply = /^(help|\?|what can you do|hello|hi)\b/i.test(text.trim()) || !text.trim()
        ? HELP
        : "I parse explicit tool requests in v1 (the deterministic brain). " + HELP;
      yield { type: "text", text: reply };
      yield { type: "end" };
      return;
    }
    yield { type: "thinking", text: `plan: ${intent.name}(${Object.keys(intent.input).join(", ")})` };
    yield { type: "tool_use", name: intent.name, input: intent.input };
    // the loop runs the tool, appends a tool_result, and calls stream() again → the summarize branch.
  },
};

// the default system persona — shapes the desktop-Claude-style coding-agent behaviour. The agent
// passes its own; this is the fallback.
export const DEFAULT_PERSONA = [
  "You are Holo Code, a concise, capable coding agent running entirely on the user's machine.",
  "You complete software tasks by USING TOOLS over the user's content-addressed workspace: read a file before you edit it, prefer small precise string edits, search with grep/glob, and verify your work.",
  "Call one tool at a time and wait for its <tool_response> before the next step. Never invent file contents — read them. When the task is done, give a short, direct answer with no tool call.",
  "You have SELF-EVOLVING SKILLS: call list_skills to see what you've learned; read_skill to load a matching skill's instructions before a task; and save_skill to capture a reusable procedure after you complete non-trivial work (or improve an existing skill). Each skill is sealed and chained — your knowledge compounds verifiably across sessions.",
].join(" ");

// ── the Holo Q provider — the REAL verifiable on-device LLM brain (QVAC WebGPU, ADR-0052) ───────
// It delegates to Holo Q's own core engine (loader → createEngine) and tool wire-format
// (toolSystemPrompt/parseToolCalls) — composing the shipped engine, not re-implementing it. The
// result is the desktop-Claude experience, sovereign: the model reasons, emits tool calls in the
// Qwen2.5 function-calling convention, and (through this provider's uniform event stream) the agent
// runs each tool conscience-gated over the substrate and feeds the result back until the model
// answers. Greedy decode is deterministic, so the turn re-derives — an inference receipt (Law L5).
export const holoQProvider = {
  id: "holo-q", label: "Holo Q", kind: "verifiable-llm",
  _engine: null, _model: null, _q: null, _status: "disconnected",
  _ids: [], _committed: 0,                          // the running KV token context + messages consumed into it
  available() { try { return !!navigator.gpu; } catch { return false; } },
  // CAPABILITY GATE — a multi-GB coder needs real GPU headroom; loading it blind on a weak device OOMs the
  // tab. WebGPU doesn't expose VRAM, so probe the adapter's buffer limits + deviceMemory (coarse RAM proxy)
  // and require a conservative margin. Heuristic + honest: undefined deviceMemory → permissive (let it try).
  async _capable(gb) {
    try {
      const a = await navigator.gpu.requestAdapter(); if (!a) return { ok: false, why: "no GPU adapter" };
      const maxBuf = (a.limits && a.limits.maxStorageBufferBindingSize) || 0;
      if (maxBuf < 134217728) return { ok: false, why: "GPU max-buffer < 128MB" };
      const dm = (typeof navigator !== "undefined" && navigator.deviceMemory) || 0;   // GB, coarse
      if (dm && dm < gb + 2) return { ok: false, why: "~" + dm + "GB memory < ~" + Math.ceil(gb + 2) + "GB needed" };
      return { ok: true };
    } catch (e) { return { ok: false, why: "GPU probe failed" }; }
  },
  status() { return this._status; },
  modelName() { return this._model ? this._model.name : ""; },
  engine() { return this._engine; },
  // the catalog of loadable on-device models (for the picker). Lazy — only pulls Holo Q's loader on demand.
  async models() { const { loader } = await this._core(); const def = loader.defaultModelIndex(); return loader.MODELS.map((m, i) => ({ i, name: m.name, size: m.size, def: i === def })); },
  // drop the running context (a new session / clear) — the next turn prefills fresh.
  resetContext() { try { this._engine && this._engine.reset(); } catch {} this._ids = []; this._committed = 0; },

  // lazy-load Holo Q's core modules (only when connecting — the local-only app never touches Holo Q).
  async _core() {
    if (this._q) return this._q;
    const [loader, engine, tools] = await Promise.all([
      import("../q/core/loader.js"), import("../q/core/engine.js"), import("../q/core/tools.js"),
    ]);
    this._q = { loader, engine, tools };
    return this._q;
  },

  // connect() loads a content-addressed model κ-object onto the GPU (verified by re-derivation off the
  // substrate) and builds the engine. Heavy (multi-GB) — only on explicit "Connect Holo Q".
  async connect({ onStatus = () => {}, onProgress = () => {}, modelIndex } = {}) {
    if (this._engine) return { ok: true, status: "connected", model: this._model.name };
    if (!this.available()) { this._status = "unavailable"; return { ok: false, status: "unavailable", reason: "WebGPU isn't available here — Holo Q runs the model on your GPU. The local agent stays in charge." }; }
    try {
      this._status = "connecting";
      const { loader, engine } = await this._core();
      // the code agent prefers a CODING brain (catalog `code:true` → Qwen2.5-Coder-7B) over the
      // smallest-model default; agentic tool use needs the ~7B capability floor.
      const coderIdx = loader.MODELS.findIndex((m) => m.code && !m.disabled);
      const idx = (modelIndex != null) ? modelIndex : (coderIdx >= 0 ? coderIdx : loader.defaultModelIndex());
      // capability gate (skip when the user explicitly picked a model): don't try to load a coder this GPU
      // can't hold — decline gracefully so the deterministic local agent stays in charge instead of OOMing.
      if (modelIndex == null) {
        const sizeGB = parseFloat(loader.MODELS[idx].size) || 4;
        const cap = await this._capable(sizeGB);
        if (!cap.ok) { this._status = "unavailable"; return { ok: false, status: "unavailable", reason: "This device can't run " + loader.MODELS[idx].name + " (" + loader.MODELS[idx].size + ") on the GPU — " + cap.why + ". The local agent stays in charge; on a stronger machine Holo Q connects automatically." }; }
      }
      // Holo Q's model URLs are "./models/…" (document-relative — they assume the Holo Q app IS the
      // document). We run its loader from the Holo Code app, so root those paths at the Holo Q app
      // (apps/q) via import.meta.url, else they resolve under apps/code and 404. (info.source is an
      // absolute HF URL for the tokenizer header — untouched.)
      const root = (u) => (u && /^\.\//.test(u)) ? new URL("../q/" + u.slice(2), import.meta.url).href : u;
      const m = { ...loader.MODELS[idx] };
      for (const k of ["kappaUrl", "kdiskUrl", "dataUrl", "framesUrl", "url"]) if (m[k]) m[k] = root(m[k]);
      onStatus(`loading ${m.name} (${m.size}) — verified off the substrate…`);
      const loaded = await loader.loadModel(m, { onStatus, onProgress });
      if (!loaded || !loaded.gpu) { this._status = "error"; return { ok: false, status: "error", reason: "could not load " + m.name + " (see status)" }; }
      this._engine = await engine.createEngine(m, loaded);
      this._model = m; this._status = "connected"; this._ids = []; this._committed = 0;
      // publish this coder as the OS's canonical `code` faculty so other surfaces share it (best-effort,
      // never blocks the connect): the shell's Q.mux when reachable, else the shared mux module.
      try {
        const reach = (typeof window !== "undefined" && window.Q && window.Q.mux) ? window.Q.mux : await import("/_shared/q/holo-q-mux.js").catch(() => null);
        if (reach) this.bindToMux(reach);
      } catch (e) {}
      return { ok: true, status: "connected", model: m.name, modelKappa: this._engine.modelKappa };
    } catch (e) { this._status = "error"; return { ok: false, status: "error", reason: "Holo Q load failed: " + (e && e.message || e) }; }
  },

  // Frame messages[from..] as Qwen2.5 ChatML, ending with an open assistant turn. `withSystem` prefixes
  // the persona + tool schemas (once per session). `fullContent`: render assistant turns WITH their text
  // (a from-scratch prefill), else CLOSE-ONLY `<|im_end|>` — the turn's tokens are already on the GPU from
  // our own generate, the Qwen convention runToolLoop uses to continue after a tool_call.
  _frame(messages, from, withSystem, fullContent, toolDefs, persona, toolSystemPrompt) {
    let s = withSystem ? `<|im_start|>system\n${persona}\n\n${toolSystemPrompt(toolDefs)}<|im_end|>\n` : "";
    for (let i = from; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "user") s += `<|im_start|>user\n${m.content}<|im_end|>\n`;
      else if (m.role === "assistant") s += fullContent ? `<|im_start|>assistant\n${m.content || ""}<|im_end|>\n` : `<|im_end|>\n`;
      else if (m.role === "tool") s += `<|im_start|>user\n<tool_response>\n${String(m.result && m.result.text || "").slice(0, 2400)}\n</tool_response><|im_end|>\n`;
    }
    return s + `<|im_start|>assistant\n`;
  },
  // the full from-scratch prompt (system + whole history with assistant content) — the first generation
  // of a session, and the GPU-free target the witness verifies.
  _buildPrompt(messages, toolDefs, persona, toolSystemPrompt) { return this._frame(messages, 0, true, true, toolDefs, persona, toolSystemPrompt); },

  async *stream(messages, { toolDefs = [], persona = DEFAULT_PERSONA, signal } = {}) {
    if (!this._engine) { yield { type: "text", text: "Holo Q isn't connected — click “Connect Holo Q” to load the on-device model. The local agent handles tool-driven work meanwhile." }; yield { type: "end" }; return; }
    const { tools } = await this._core();

    // KV REUSE (the runToolLoop pattern): `_ids` holds the exact tokens already prefilled on the GPU.
    // Each round we tokenize ONLY the new turn delta and append it, then generate WITHOUT reset — so the
    // engine prefills just the new tokens, not the whole conversation. First generation of a session =
    // the full prompt (system + history); after that, deltas only.
    const first = this._ids.length === 0;
    const delta = first
      ? this._frame(messages, 0, true, true, toolDefs, persona, tools.toolSystemPrompt)
      : this._frame(messages, this._committed, false, false, toolDefs, persona, tools.toolSystemPrompt);
    this._committed = messages.length;
    this._ids = this._ids.concat(this._engine.tokenize(delta));

    // bridge engine.generate's onToken (CUMULATIVE output text of THIS round) → streamed deltas, with the
    // trailing <tool_call> markup hidden from prose (it renders as a tool block instead).
    let full = "", done = false, wake = null, lastStats = null; const ping = () => { const w = wake; wake = null; w && w(); };
    this._engine.generate(this._ids, { signal, maxNew: 384, onToken: ({ text, stats }) => { full = text; lastStats = stats; ping(); } })
      .then((r) => { full = r.text; this._ids = r.ids; done = true; ping(); })
      .catch((e) => { full += "\n[generation error: " + (e && e.message || e) + "]"; done = true; ping(); });

    let shown = 0, statsShown = null;
    for (;;) {
      if (lastStats && lastStats !== statsShown) { statsShown = lastStats; yield { type: "stats", tokps: lastStats.tokps || 0 }; }   // real decode rate → a braille pulse
      const vis = full.split("<tool_call")[0];
      if (vis.length > shown) { yield { type: "text", text: vis.slice(shown) }; shown = vis.length; }
      if (done) break;
      await new Promise((r) => { wake = r; if (done) r(); });   // re-check to avoid a lost-wakeup hang
    }
    const calls = tools.parseToolCalls(full);
    if (calls.length) yield { type: "tool_use", name: calls[0].name, input: calls[0].arguments || {} };
    else yield { type: "end" };
  },

  // ── canonical `code` faculty contract (ADR-0084) ──────────────────────────────────────────────────
  // The same loaded coder this app runs IS the OS's `code` brain. These three members let the host bind
  // this engine to holo-q-mux as the `code` specialist, so the Create studio, the omnibar, and every other
  // generative surface share THIS one κ-disk instead of each loading their own. isReady() gates on the
  // engine actually being connected (readiness — holo-q-active treats a not-ready brain as the text-model
  // fallback). generate() is a plain (toolless) completion in the voice/codegen delta shape.
  isReady() { return this._status === "connected" && !!this._engine; },
  async *generate(messages, opts = {}) {
    if (!this._engine) return;                       // not connected → empty stream → the chain/text floor stands
    for await (const ev of this.stream(messages, { toolDefs: [], persona: opts.persona || DEFAULT_PERSONA, signal: opts.signal })) {
      if (ev && ev.type === "text" && ev.text) yield ev.text;   // stream emits incremental text deltas already
    }
  },
  // bind this connected coder onto a holo-q-mux instance as the `code` faculty (the host passes ITS mux —
  // cross-frame sharing rides the holo-q-faculty bridge). Returns false if the mux can't take a binding.
  bindToMux(mux) {
    try {
      const bind = mux && (mux.bindSpecialist || (mux.default && mux.default.bindSpecialist));
      if (typeof bind !== "function") return false;
      bind("code", { id: this.modelName() || "holo-q-coder", faculty: "code", isReady: () => this.isReady(), generate: (m, o) => this.generate(m, o) });
      return true;
    } catch (e) { return false; }
  },
};

export const PROVIDERS = { local: localProvider, "holo-q": holoQProvider };
export function getProvider(id) { return PROVIDERS[id] || localProvider; }
export default { PROVIDERS, getProvider, localProvider, holoQProvider };
