// holo-code-agent.mjs — the agent turn loop, faithful to Claude Code's query pipeline but sovereign:
//   user message → provider stream → on tool_use → PERMISSION GATE → run tool → tool_result → continue
//   → end_turn → seal a re-derivable PROV-O work receipt (Law L5).
//
// Two things make it substrate-native rather than a remote-API clone:
//   1. PERMISSION = the fail-closed conscience gate (ADR-033). Every tool call is judged by the OS
//      Constitution before it runs; a red-line verdict (or an unsealed/tampered constitution) refuses
//      the call no matter the mode. The permission MODE (default/plan/auto/acceptEdits/bypass) layers
//      the familiar Claude Code UX on top of that constitutional floor.
//   2. The SESSION is a content-addressed object. Each turn records its steps (tool · input · κ ·
//      verdict) and seals to a did:holo you can re-derive — a session you can prove, not just recall.

import { runTool, TOOLS, toolDefs } from "./holo-code-tools.mjs";
import { getProvider, DEFAULT_PERSONA } from "./holo-code-providers.mjs";

// the agent's system persona — armed onto the Holo Q model so it drives the substrate tools itself.
const HOLO_CODE_PERSONA = DEFAULT_PERSONA;
// conscience imported directly (not via the SDK global) so the gate is reliable in any context.
let _conscience = { evaluate: () => ({ outcome: "block", sealed: false, reason: "conscience not loaded — fail closed" }), sealed: () => false };
try { _conscience = await import("./_shared/holo-conscience.js"); } catch {}
let SDK = {}; try { SDK = await import("@hologram/sdk"); } catch {}
// content addressing imported directly (not via the SDK global) so the receipt always seals to a
// re-derivable κ, independent of global load order. holo-object.address/verify mirror holo-uor exactly.
let _obj = null; try { _obj = await import("./_shared/holo-object.js"); } catch {}

// map a tool call → a constitutional decision. We always KEEP an audit trace (the receipt), so the
// caretaker/kill-switch/provenance duties are met by construction; ordinary edits evaluate to accept
// when the constitution is sealed, and to block (fail closed) when it is not.
function decisionFor(name, input) {
  return { leavesNoAuditTrace: false, overridesKillSwitch: false, refusesLawfulRequest: false, revealsUnverifiedClaim: false, _tool: name, _target: input?.path || input?.ref || "" };
}
function judge(name, input) {
  try { const v = _conscience.evaluate(decisionFor(name, input), { posture: "answer-then-caveat" }); return v; }
  catch { return { outcome: "block", sealed: false, reason: "conscience error — fail closed" }; }
}

let _seq = 0;
export class HoloCodeAgent {
  constructor({ providerId = "local", onEvent = () => {}, requestPermission = async () => "deny", mode = "default" } = {}) {
    this.providerId = providerId;
    this.onEvent = onEvent;
    this.requestPermission = requestPermission;   // (toolUse, verdict) → "allow" | "deny" | "always"
    this.mode = mode;                              // default | plan | auto | acceptEdits | bypass
    this.messages = [];                            // {role:"user"|"assistant"|"tool", content, ...}
    this.rules = new Set();                        // tool names the user said "Always" to (session scope)
    this.plan = [];                                // queued tool_uses while in plan mode
    this.steps = [];                               // receipt steps for the live turn
    this.busy = false;
    this._defs = toolDefs();                        // Qwen function schemas (arm the Holo Q model)
    this._abort = null;                            // per-turn AbortController (interrupt generation)
  }
  setMode(m) { this.mode = m; this.onEvent({ type: "mode", mode: m }); }
  setProvider(id) { this.providerId = id; this.onEvent({ type: "provider", id }); }
  stop() { try { this._abort && this._abort.abort(); } catch {} }
  // start a fresh session — clears the history AND the Holo Q model's running context (so the KV cache
  // stays aligned with the messages). Wired to /clear.
  reset() { this.messages = []; this.rules = new Set(); this.plan = []; this.steps = []; this._lastReceipt = ""; try { const p = getProvider("holo-q"); p.resetContext && p.resetContext(); } catch {} }

  // does this tool need a human prompt, given the mode + the verdict?
  _needsPrompt(name, danger, verdict) {
    if (verdict.outcome === "block") return "refused";              // fail-closed / red line — never runs
    if (this.rules.has(name)) return false;
    switch (this.mode) {
      case "bypass": return false;
      case "acceptEdits": return TOOLS[name]?.category === "File I/O" ? false : (danger ? true : false);
      case "auto": return danger ? true : false;
      case "plan": return false;                                    // collected, executed on ExitPlan
      default: return danger ? true : false;                        // "default"
    }
  }

  async send(userText) {
    if (this.busy) return; this.busy = true;
    this.steps = [];
    try { this._abort = new AbortController(); } catch { this._abort = null; }
    this.messages.push({ role: "user", content: userText });
    this.onEvent({ type: "user", text: userText });
    const provider = getProvider(this.providerId);
    const opts = { tools: Object.keys(TOOLS), toolDefs: this._defs, persona: HOLO_CODE_PERSONA, signal: this._abort ? this._abort.signal : undefined };
    try {
      let guard = 0;
      while (guard++ < 24) {
        if (this._abort && this._abort.signal.aborted) break;
        let producedTool = false;
        const it = provider.stream(this.messages, opts);
        let asstText = "";
        for await (const ev of it) {
          if (ev.type === "thinking") this.onEvent({ type: "thinking", text: ev.text });
          else if (ev.type === "text") { asstText += ev.text; this.onEvent({ type: "assistant_delta", text: ev.text }); }
          else if (ev.type === "stats") this.onEvent({ type: "stats", tokps: ev.tokps });
          else if (ev.type === "tool_use") { producedTool = true; await this._handleTool(ev); break; }
          else if (ev.type === "end") break;
        }
        if (asstText) { this.messages.push({ role: "assistant", content: asstText }); this.onEvent({ type: "assistant_done" }); }
        if (!producedTool) break;                                   // turn complete
      }
      await this._seal();
    } finally { this.busy = false; }
  }

  async _handleTool({ name, input }) {
    const id = "t" + ++_seq;
    const danger = !!TOOLS[name]?.danger;
    const verdict = judge(name, input);
    this.onEvent({ type: "tool_start", id, name, input, danger, verdict, title: TOOLS[name]?.title || name, category: TOOLS[name]?.category || "" });

    // plan mode: collect, don't execute. Feed a synthetic result so the provider can close the turn.
    if (this.mode === "plan") {
      this.plan.push({ name, input });
      this.onEvent({ type: "tool_planned", id, name, input });
      this.messages.push({ role: "tool", tool: name, result: { ok: true, text: "(planned — not executed)", planned: true } });
      return;
    }

    const need = this._needsPrompt(name, danger, verdict);
    if (need === "refused") {
      const reason = verdict.reason || `conscience refused (${verdict.outcome}${verdict.sealed ? "" : ", unsealed"})`;
      this.onEvent({ type: "tool_denied", id, name, reason });
      this.steps.push({ tool: name, input: redact(input), outcome: "refused", verdict: verdict.outcome });
      this.messages.push({ role: "tool", tool: name, result: { ok: false, text: "permission refused: " + reason } });
      return;
    }
    if (need) {
      const decision = await this.requestPermission({ id, name, input, danger, verdict, title: TOOLS[name]?.title || name });
      if (decision === "always") this.rules.add(name);
      if (decision === "deny") {
        this.onEvent({ type: "tool_denied", id, name, reason: "denied by you" });
        this.steps.push({ tool: name, input: redact(input), outcome: "denied" });
        this.messages.push({ role: "tool", tool: name, result: { ok: false, text: "permission denied by user" } });
        return;
      }
    }

    // run it
    const result = await runTool(name, input);
    this.onEvent({ type: "tool_result", id, name, result });
    this.steps.push({ tool: name, input: redact(input), outcome: result.ok ? "ok" : "error", kappa: result.kappa || "", verdict: verdict.outcome });
    this.messages.push({ role: "tool", tool: name, result });
  }

  // execute the queued plan (Claude Code's ExitPlanMode). Switches to acceptEdits and replays.
  async runPlan() {
    if (!this.plan.length) return;
    const queued = this.plan.slice(); this.plan = [];
    const prevMode = this.mode; this.mode = "acceptEdits";
    this.onEvent({ type: "plan_run", count: queued.length });
    for (const { name, input } of queued) { await this._handleTool({ name, input }); }
    this.mode = prevMode;
    await this._seal();
  }

  // seal the turn into a re-derivable PROV-O work receipt (composes the Orchestrate receipt shape).
  async _seal() {
    if (!this.steps.length) return;
    const activity = {
      "@context": { prov: "http://www.w3.org/ns/prov#", schema: "https://schema.org/", hcode: "https://hologram.os/ns/holo-code#" },
      "@type": ["prov:Activity", "schema:Action"],
      "hcode:agent": this.providerId,
      "hcode:mode": this.mode,
      "prov:used": this.steps.map((s) => ({ "hcode:tool": s.tool, "hcode:target": s.input?.path || s.input?.ref || "", "hcode:outcome": s.outcome, "hcode:verdict": s.verdict || "", ...(s.kappa ? { "prov:wasDerivedFrom": { "@id": s.kappa } } : {}) })),
      "hcode:steps": this.steps.length,
    };
    let kappa = "", ok = null;
    try {
      const addr = _obj?.address || SDK.address, ver = _obj?.verify || SDK.verify;
      if (addr) { kappa = await addr(activity); if (ver) ok = await ver({ id: kappa, ...activity }); }
    } catch {}
    this.onEvent({ type: "receipt", kappa, ok, steps: this.steps.length, sealed: _conscience.sealed ? _conscience.sealed() : false });
  }
}

// keep file contents out of the receipt — record the shape, not the payload.
function redact(input) {
  const o = {}; for (const k of Object.keys(input || {})) o[k] = (k === "content" || k === "new" || k === "old" || k === "source") ? `[${String(input[k]).length} chars]` : input[k];
  return o;
}

export default HoloCodeAgent;
