// holo-code-repl.js — the terminal-agent surface, a faithful reproduction of the Claude Code REPL:
// a streaming transcript (assistant text · thinking · tool-call blocks · permission prompts ·
// session receipt), a composer with slash-command autocomplete and history, a status line, plan
// mode, and a content-addressed file/diff viewer. Pure DOM, no framework, only --holo-* tokens.

// the app-identity accent (kept here, never as a literal in index.html, so the Holo UI token ratchet
// stays at 0 — index.html is hex-free; the coral is applied at boot via HoloUI.setAccent).
export const ACCENT = "#d97757";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

// minimal, safe markdown (escape first, then re-introduce a few inline forms) — no CDN (Law L4).
function md(s) {
  let h = esc(s);
  h = h.replace(/```([\s\S]*?)```/g, (_, c) => `<pre class="code">${c.replace(/^\n/, "")}</pre>`);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/^### (.+)$/gm, "<h4>$1</h4>").replace(/^## (.+)$/gm, "<h3>$1</h3>");
  h = h.replace(/\n/g, "<br>");
  return h;
}
const kshort = (k) => { const x = String(k || "").split(":").pop(); return x ? x.slice(0, 8) + "…" + x.slice(-4) : ""; };

const SLASH = [
  ["/help", "show what Holo Code can do"], ["/clear", "clear the transcript"],
  ["/provider", "switch the brain (local · holo-q)"], ["/mode", "permission mode (default·plan·auto·acceptEdits·bypass)"],
  ["/plan", "enter plan mode"], ["/run", "execute the collected plan"],
  ["/context", "what the agent can see"], ["/cost", "token + session cost"],
  ["/diff", "open the last diff"], ["/verify", "re-derive a file's κ"], ["/share", "make a holo://κ link"],
  ["/connect", "connect Holo Q (verifiable on-device LLM)"], ["/theme", "cycle accent"], ["/receipt", "show the session receipt κ"],
];

export class REPL {
  constructor({ agent, els, providers, modes, onConnectHoloQ }) {
    this.agent = agent; this.els = els; this.providers = providers; this.modes = modes;
    this.onConnectHoloQ = onConnectHoloQ;
    this.history = []; this.hi = -1;
    this.curAssist = null; this.curThinking = null;
    this.tools = new Map(); this.lastDiff = null; this.lastFile = null;
    this.ctxTokens = 0; this.cost = 0; this.maxCtx = 200000;
    this._wire();
  }

  _wire() {
    const c = this.els.composer;
    c.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._submit(); }
      else if (e.key === "ArrowUp" && !c.value.includes("\n")) { if (this.history.length) { this.hi = Math.max(0, (this.hi < 0 ? this.history.length : this.hi) - 1); c.value = this.history[this.hi] || ""; e.preventDefault(); } }
      else if (e.key === "ArrowDown" && this.hi >= 0) { this.hi = Math.min(this.history.length, this.hi + 1); c.value = this.history[this.hi] || ""; e.preventDefault(); }
      else if (e.key === "Tab" && c.value.startsWith("/")) { const hit = SLASH.find((s) => s[0].startsWith(c.value.trim())); if (hit) { c.value = hit[0] + " "; e.preventDefault(); } }
      else if (e.key === "Escape") { this._hideSuggest(); }
      else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); this._cycleMode(); }
    });
    c.addEventListener("input", () => this._suggest());
    this.els.send.addEventListener("click", () => this._submit());
    if (this.els.viewerClose) this.els.viewerClose.addEventListener("click", () => this._closeViewer());
    // provider + mode pickers
    if (this.els.provider) this.els.provider.addEventListener("change", () => this.agent.setProvider(this.els.provider.value));
    if (this.els.connect) this.els.connect.addEventListener("click", () => this.onConnectHoloQ && this.onConnectHoloQ());
    this.setStatus();
  }

  // ── composer ────────────────────────────────────────────────────────────────────────────
  _submit() {
    const c = this.els.composer; const text = c.value.trim(); if (!text) return;
    c.value = ""; this._hideSuggest(); this.history.push(text); this.hi = -1;
    if (text.startsWith("/")) return this._slash(text);
    this.ctxTokens += Math.ceil(text.length / 4); this.setStatus();
    this.agent.send(text);
  }
  _suggest() {
    const c = this.els.composer, box = this.els.suggest; if (!box) return;
    const v = c.value; if (!v.startsWith("/") || v.includes(" ")) return this._hideSuggest();
    const hits = SLASH.filter((s) => s[0].startsWith(v));
    if (!hits.length) return this._hideSuggest();
    box.innerHTML = hits.map((s) => `<div class="sg"><span class="cmd">${s[0]}</span><span class="d">${esc(s[1])}</span></div>`).join("");
    box.querySelectorAll(".sg").forEach((row, i) => row.addEventListener("click", () => { c.value = hits[i][0] + " "; this._hideSuggest(); c.focus(); }));
    box.hidden = false;
  }
  _hideSuggest() { if (this.els.suggest) this.els.suggest.hidden = true; }

  _slash(text) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/); const arg = rest.join(" ");
    this._line(`<span class="dim">› ${esc(text)}</span>`);
    switch (cmd) {
      case "help": return this._line(md(this._helpText()));
      case "clear": this.els.transcript.innerHTML = ""; this.agent.reset(); return;
      case "provider": { const id = arg || (this.agent.providerId === "local" ? "holo-q" : "local"); this.agent.setProvider(id); if (this.els.provider) this.els.provider.value = id; return this._line(`brain → <strong>${esc(id)}</strong>`); }
      case "mode": { const m = arg || this._nextMode(); this.agent.setMode(m); return; }
      case "plan": this.agent.setMode("plan"); return;
      case "run": return this.agent.runPlan();
      case "connect": return this.onConnectHoloQ && this.onConnectHoloQ();
      case "context": return this._line(md(`**Context** — workspace: your OPFS Home (\`/home/user\`), read/write. The immutable substrate (this Hologram · every holospace · OS runtime) is readable. Brain: \`${this.agent.providerId}\`. Mode: \`${this.agent.mode}\`. ~${this.ctxTokens} ctx tokens.`));
      case "cost": return this._line(md(`**Cost** — local inference, **$0.00**. ~${this.ctxTokens} context tokens this session (nothing left your machine).`));
      case "diff": return this.lastDiff ? this._openViewer(this.lastDiff) : this._line("no diff yet");
      case "verify": return arg ? this.agent.send("verify " + arg) : this._line("usage: /verify &lt;path&gt;");
      case "share": return arg ? this.agent.send("share " + arg) : this._line("usage: /share &lt;path&gt;");
      case "receipt": return this._line(this._lastReceipt ? `session receipt <code>${esc(this._lastReceipt)}</code>` : "no receipt yet — run a tool");
      case "theme": { try { window.HoloUI && window.HoloUI.setAccent && window.HoloUI.setAccent(["#d97757", "#5eead4", "#7cc7ff", "#a78bfa", "#22c55e"][(this._ti = ((this._ti || 0) + 1) % 5)]); } catch {} return; }
      case "vim": return this._line("vim mode isn't available in this build.");
      default: return this._line(`unknown command <code>/${esc(cmd)}</code> — try <code>/help</code>`);
    }
  }
  _helpText() {
    return [
      "**Holo Code** — an agentic coding partner that runs on your machine.",
      "Ask in plain words, or drive tools directly:",
      "`read src/greet.js` · `list` · `grep greet` · `glob **/*.js`",
      "`write notes.md :: hello` · `in src/greet.js replace world with holo` · `verify README.md` · `share README.md`",
      "",
      "Slash: " + SLASH.map((s) => "`" + s[0] + "`").join(" · "),
      "",
      "Every tool is judged by the OS conscience before it runs; every session seals to a re-derivable κ.",
    ].join("\n");
  }
  _nextMode() { const i = this.modes.indexOf(this.agent.mode); return this.modes[(i + 1) % this.modes.length]; }
  _cycleMode() { this.agent.setMode(this._nextMode()); }

  // ── agent event sink ──────────────────────────────────────────────────────────────────────
  handle(ev) {
    switch (ev.type) {
      case "user": this._userMsg(ev.text); break;
      case "thinking": this._thinking(ev.text); break;
      case "assistant_delta": this._assistDelta(ev.text); break;
      case "stats": this._stats(ev); break;
      case "assistant_done": this.curAssist = null; this.curThinking = null; this._atps = null; this._tpsHist = null; break;
      case "tool_start": this._toolStart(ev); break;
      case "tool_result": this._toolResult(ev); break;
      case "tool_denied": this._toolDenied(ev); break;
      case "tool_planned": this._toolPlanned(ev); break;
      case "plan_run": this._line(`<span class="dim">▶ executing plan · ${ev.count} step${ev.count === 1 ? "" : "s"}</span>`); break;
      case "receipt": this._receipt(ev); break;
      case "mode": this.setStatus(); this._line(`<span class="dim">permission mode → <strong>${esc(ev.mode)}</strong></span>`); break;
      case "provider": this.setStatus(); break;
    }
    this._scroll();
  }

  _userMsg(text) {
    const m = el("div", "msg user");
    m.append(el("div", "role", "you"), el("div", "body", md(text)));
    this.els.transcript.append(m);
  }
  _assistDelta(text) {
    if (!this.curAssist) {
      const m = el("div", "msg assistant");
      const role = el("div", "role"); role.append(document.createTextNode(this.agent.providerId === "local" ? "local agent" : "holo q"), this._atps = el("span", "tps"));
      m.append(role, this._abody = el("div", "body")); this.els.transcript.append(m); this.curAssist = this._abody; this._abuf = ""; this._tpsHist = [];
    }
    this._abuf += text; this.curAssist.innerHTML = md(this._abuf);
  }
  // Real tokens/sec from the on-device engine → a live braille sparkline beside the answer's byline.
  _stats(ev) {
    if (!this._atps) return;
    const v = Math.max(0, ev.tokps || 0); (this._tpsHist || (this._tpsHist = [])).push(v); if (this._tpsHist.length > 24) this._tpsHist.shift();
    const bar = window.HoloFX ? window.HoloFX.graph(this._tpsHist, { width: 12, fill: true, min: 0 }) : "";
    this._atps.innerHTML = `<span class="bar">${bar}</span><span class="n">${v ? Math.round(v) + " tok/s" : ""}</span>`;
  }
  _thinking(text) {
    const d = el("details", "thinking"); d.append(el("summary", null, "∴ thinking"), el("pre", null, esc(text)));
    this.els.transcript.append(d);
  }
  _toolStart(ev) {
    const t = el("div", "tool pending");
    t.innerHTML = `<div class="thead"><span class="tdot"></span><span class="tname">${esc(ev.title)}</span>` +
      `<span class="targs">${esc(paramSummary(ev.input))}</span><span class="tcat">${esc(ev.category)}</span>` +
      `<span class="tverdict ${ev.verdict?.outcome === "accept" ? "ok" : ev.verdict?.outcome === "block" ? "bad" : "warn"}">conscience: ${esc(ev.verdict?.outcome || "—")}${ev.verdict?.sealed ? "" : " · unsealed"}</span></div>` +
      `<div class="tbody"></div>`;
    this.els.transcript.append(t); this.tools.set(ev.id, t);
    // Sharp braille spinner in the status dot while the tool runs (Holo FX / unicode-animations).
    if (window.HoloFX) { const dot = $(".tdot", t); dot.classList.add("fx"); t._fx = window.HoloFX.spin(dot, "braille"); }
  }
  _toolStop(t, glyph) { if (t && t._fx) { t._fx.stop(glyph); t._fx = null; const d = $(".tdot", t); if (d) d.classList.remove("fx"); } }
  _toolResult(ev) {
    const t = this.tools.get(ev.id); if (!t) return;
    this._toolStop(t, "");
    t.classList.remove("pending"); t.classList.add(ev.result.ok ? "done" : "err");
    const body = $(".tbody", t);
    body.innerHTML = `<pre class="tout">${esc(ev.result.text || "")}</pre>` +
      (ev.result.kappa ? `<div class="tk" title="${esc(ev.result.kappa)}">κ ${esc(kshort(ev.result.kappa))} · re-derivable (L5)</div>` : "");
    if (ev.result.viewer) {
      if (ev.result.viewer.kind === "diff") this.lastDiff = ev.result.viewer;
      const open = el("button", "topen", "open in viewer"); open.addEventListener("click", () => this._openViewer(ev.result.viewer)); body.append(open);
      this._openViewer(ev.result.viewer);
    }
  }
  _toolDenied(ev) {
    const t = this.tools.get(ev.id); if (t) { this._toolStop(t, ""); t.classList.remove("pending"); t.classList.add("denied"); $(".tbody", t).innerHTML = `<pre class="tout">⊘ ${esc(ev.reason)}</pre>`; }
  }
  _toolPlanned(ev) {
    const t = this.tools.get(ev.id); if (t) { this._toolStop(t, ""); t.classList.remove("pending"); t.classList.add("planned"); $(".tbody", t).innerHTML = `<pre class="tout">⏸ queued — run with <code>/run</code></pre>`; }
  }
  _receipt(ev) {
    this._lastReceipt = ev.kappa;
    const r = el("div", "receipt");
    r.innerHTML = `<span class="rseal ${ev.sealed ? "ok" : "warn"}"></span>session receipt · ${ev.steps} step${ev.steps === 1 ? "" : "s"} · ` +
      (ev.kappa ? `<code title="${esc(ev.kappa)}">${esc(kshort(ev.kappa))}</code> ${ev.ok ? "✓ re-derives" : ev.ok === false ? "✗" : ""}` : "(unsealed)") +
      ` · conscience ${ev.sealed ? "sealed" : "unsealed (fail-closed)"}`;
    this.els.transcript.append(r);
    this.setStatus();
  }

  _line(html) { this.els.transcript.append(el("div", "note", html)); this._scroll(); }
  // a line that updates in place — for streaming model-load status (returns an updater).
  progressLine(html) { const d = el("div", "note", html); this.els.transcript.append(d); this._scroll(); return (h) => { d.innerHTML = h; this._scroll(); }; }
  setModel(name) { this.modelName = name; this.setStatus(); }
  _scroll() { this.els.transcript.scrollTop = this.els.transcript.scrollHeight; }

  // ── permission prompt (returns "allow"|"deny"|"always") ─────────────────────────────────────
  requestPermission(tu) {
    return new Promise((resolve) => {
      const m = this.els.permission; const v = tu.verdict || {};
      $(".pm-tool", m).textContent = tu.title + " · " + paramSummary(tu.input);
      $(".pm-verdict", m).innerHTML = `conscience: <strong class="${v.outcome === "accept" ? "ok" : v.outcome === "block" ? "bad" : "warn"}">${esc(v.outcome || "—")}</strong>${v.sealed ? " · constitution sealed (L5)" : " · unsealed (fail-closed)"}`;
      $(".pm-detail", m).textContent = tu.danger ? "This tool can modify your workspace." : "Read-only.";
      m.hidden = false;
      const done = (d) => { m.hidden = true; document.removeEventListener("keydown", key); resolve(d); };
      const key = (e) => { const k = e.key.toLowerCase(); if (k === "y" || k === "enter") { e.preventDefault(); done("allow"); } else if (k === "n" || k === "escape") { e.preventDefault(); done("deny"); } else if (k === "a") { e.preventDefault(); done("always"); } };
      m.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => done(b.getAttribute("data-act")));
      document.addEventListener("keydown", key);
      $('[data-act="allow"]', m).focus();
    });
  }

  // ── content-addressed file / diff viewer ───────────────────────────────────────────────────
  _openViewer(v) {
    const pane = this.els.viewer; if (!pane) return;
    pane.hidden = false; document.body.classList.add("has-viewer");
    this.els.viewerTitle.textContent = v.path;
    this.els.viewerKappa.textContent = v.kappa ? "κ " + kshort(v.kappa) : "";
    this.els.viewerKappa.title = v.kappa || "";
    if (v.kind === "diff") {
      this.els.viewerBody.innerHTML = `<pre class="diff">${v.diff.map((d) => `<span class="dl ${d.t === "+" ? "add" : d.t === "-" ? "del" : "ctx"}">${esc((d.t === " " ? " " : d.t) + " " + d.line)}</span>`).join("\n")}</pre>`;
    } else {
      this.lastFile = v;
      this.els.viewerBody.innerHTML = `<pre class="filebody">${esc(v.text || "")}</pre>`;
    }
  }
  _closeViewer() { if (this.els.viewer) { this.els.viewer.hidden = true; document.body.classList.remove("has-viewer"); } }

  setStatus() {
    if (this.els.stProvider) this.els.stProvider.textContent = this.agent.providerId === "local" ? "local agent" : ("holo q" + (this.modelName ? " · " + this.modelName : ""));
    if (this.els.stMode) this.els.stMode.textContent = this.agent.mode;
    if (this.els.stCtx) this.els.stCtx.textContent = Math.min(100, Math.round((this.ctxTokens / this.maxCtx) * 100)) + "% ctx";
    if (this.els.stCost) this.els.stCost.textContent = "$0.00";
    if (this.els.stKappa) { this.els.stKappa.textContent = this._lastReceipt ? "κ " + kshort(this._lastReceipt) : "no receipt"; this.els.stKappa.title = this._lastReceipt || ""; }
  }

  banner() {
    this._line(md([
      "**Holo Code** — the terminal agent, sovereign. Brain on your machine, tools over the content-addressed substrate, every step judged by the OS conscience and sealed to a re-derivable receipt.",
      "Type `/help`, or just `read src/greet.js`. Click **Connect Holo Q** to wire the on-device LLM.",
    ].join("\n")));
  }
}

function paramSummary(input) {
  if (!input) return "";
  const keys = Object.keys(input);
  return keys.map((k) => `${k}: ${String(input[k]).length > 40 ? String(input[k]).slice(0, 40) + "…" : input[k]}`).join("  ");
}

export default REPL;
