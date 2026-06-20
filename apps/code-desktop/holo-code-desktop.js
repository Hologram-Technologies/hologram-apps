// holo-code-desktop.js — the Desktop GUI controller. It COMPOSES the witnessed Holo Code engine
// (apps/code) BY REFERENCE — importing ../code/*.mjs at runtime (manifest holo:dependsOn), never a fork.
// Three surfaces share one engine and one orchestrator, Q:
//   • Chat   — conversational Q.
//   • Cowork — Q tackles a task autonomously (auto-accept), local (no cloud VM).
//   • Code   — agentic coding session: Monaco editor + XTerm terminal + a visual diff whose Accept/Reject
//              resolves the fail-closed conscience permission gate (ADR-033).
// Execution-dependent features (run · build · test · terminal-exec · worktrees · schedule · ssh) are
// honestly gated to the native host, never faked. Layout follows the familiar Desktop information
// architecture; every value comes from the reused HOLOGRAM design tokens. Q is the brain throughout.

import HoloCodeAgent from "../code/holo-code-agent.mjs";
import { REPL, ACCENT } from "../code/holo-code-repl.js";
import { PROVIDERS } from "../code/holo-code-providers.mjs";
import { seedWorkspace } from "../code/holo-code-tools.mjs";

let verifyConstitution = async () => ({ ok: false });
try { const c = await import("./_shared/holo-conscience.js"); verifyConstitution = c.verifyConstitution; } catch {}
let SDK = {}; try { SDK = await import("@hologram/sdk"); } catch {}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const kshort = (k) => { const x = String(k || "").split(":").pop(); return x ? x.slice(0, 8) + "…" + x.slice(-4) : ""; };
const MODES = ["default", "plan", "auto", "acceptEdits", "bypass"];
const detached = (t) => document.createElement(t);

try { await (SDK.ready ? SDK.ready() : Promise.resolve()); } catch {}
// force the Hologram OS brand accent (blue, theme-adaptive) — overrides the engine's coral (ACCENT)
try { document.documentElement.style.setProperty("--holo-accent", "light-dark(#3b5bdb, #5b8cff)"); } catch {}
try { await verifyConstitution(); } catch {}
try { await seedWorkspace(); } catch {}
try { if (SDK.sealed && SDK.sealed()) $("st-seal").classList.add("ok"); } catch {}

// ── three surfaces, one engine, one orchestrator (Q) ─────────────────────────────────────────────────
function makeSurface(name, transcriptId, composerId, sendSel, suggestId, mode, opts = {}) {
  const els = {
    transcript: $(transcriptId), composer: $(composerId), send: document.querySelector(sendSel), suggest: $(suggestId),
    permission: opts.permission ? $("permission") : undefined,
    stProvider: opts.st ? $("st-provider") : {}, stMode: {}, stCtx: {}, stCost: {}, stKappa: opts.st ? $("st-kappa") : {},
  };
  const agent = new HoloCodeAgent({ providerId: "local", mode });
  const repl = new REPL({ agent, els, providers: ["local", "holo-q"], modes: MODES, onConnectHoloQ: () => setBrain("holo-q") });
  const surfaceEl = document.querySelector(`[data-panel="${name}"]`);
  // first message activates the surface (hero → thread); code also reveals the IDE
  const orig = repl._submit.bind(repl);
  repl._submit = function () {
    const t = (els.composer.value || "").trim();
    if (t) { surfaceEl.classList.remove("home"); surfaceEl.classList.add("active"); if (opts.onActivate) opts.onActivate(t); }
    orig();
  };
  if (opts.routePermission) agent.requestPermission = (tu) => requestPermissionCode(tu, repl);
  else agent.requestPermission = (tu) => repl.requestPermission(tu);
  agent.onEvent = (ev) => { repl.handle(ev); qWatch(ev, name); if (opts.onEvent) opts.onEvent(ev); };
  return { name, agent, repl, els, surfaceEl };
}

const code = makeSurface("code", "code-transcript", "code-composer", '[data-send-for="code"]', "code-suggest", "default",
  { permission: true, st: true, routePermission: true, onActivate: () => revealWork(), onEvent: onCodeEvent });
const chat = makeSurface("chat", "chat-transcript", "chat-composer", '[data-send-for="chat"]', "chat-suggest", "default", {});
const cowork = makeSurface("cowork", "cw-transcript", "cw-composer", '[data-send-for="cowork"]', "cw-suggest", "acceptEdits", {});
const surfaces = { chat, cowork, code };

// ── Chat → the Hologram-native Q engine, on a single fast model for testing ──────────────────────────
// Falcon-E-3B · ternary (0.63 GB κ-disk, WebGPU): the smallest chat-capable on-device model — fast,
// browser-native, conversational. It loads on the first Chat message (verified off the substrate), then
// every turn streams from Q on your GPU (greedy decode → a re-derivable inference receipt, Law L5).
const CHAT_MODEL = /Falcon-E/i;
let _chatQReady = false, _chatConnecting = false;
async function ensureChatQ() {
  if (_chatQReady) return true;
  const p = PROVIDERS["holo-q"];
  if (!p.available || !p.available()) { chat.repl._line('<span class="warn">WebGPU isn\'t available here — Q runs the model on your GPU. Chat stays on the reference brain.</span>'); return false; }
  if (_chatConnecting) return false;
  _chatConnecting = true;
  let idx; try { const list = await p.models(); const hit = list.find((m) => CHAT_MODEL.test(m.name)) || list.find((m) => m.def) || list[0]; idx = hit && hit.i; } catch {}
  const line = chat.repl.progressLine('<span class="dim">waking Q…</span>');
  setQ("thinking", "Q · loading the chat model…");
  const r = await p.connect({ modelIndex: idx, onStatus: (s) => s && line('<span class="dim">Q · ' + esc(s + "") + '</span>'), onProgress: (d, t, l) => t && line('<span class="dim">Q · ' + esc(l || "loading") + ' ' + Math.round((d / t) * 100) + '%</span>') });
  _chatConnecting = false;
  if (r.ok) {
    _chatQReady = true; chat.agent.setProvider("holo-q");
    const sel = chat.surfaceEl.querySelector(".brain"); if (sel) sel.value = "holo-q";
    setQ("idle", "Q ready · " + r.model);
    line('<span class="ok">Q connected</span> — <strong>' + esc(r.model) + '</strong>, on your GPU. Ask me anything.');
    return true;
  }
  setQ("idle", "Q unavailable"); line('Q: ' + esc(r.reason || r.status || "unavailable") + ' — staying on the reference brain.');
  return false;
}
// first Chat message wakes Q, then Q answers; subsequent messages stream straight through Q.
const _chatBaseSubmit = chat.repl._submit.bind(chat.repl);
chat.repl._submit = function () {
  const t = (chat.els.composer.value || "").trim(); if (!t) return;
  if (_chatQReady || chat.agent.providerId === "holo-q") { _chatBaseSubmit(); return; }
  chat.surfaceEl.classList.remove("home"); chat.surfaceEl.classList.add("active");
  chat.els.composer.value = "";
  ensureChatQ().then(() => chat.agent.send(t));
};

// ── Q brain (the single orchestrator across all three surfaces) ──────────────────────────────────────
let _modelsPicked = false, _connecting = false;
async function setBrain(tier) {
  document.querySelectorAll(".brain").forEach((s) => (s.value = tier));
  if (tier === "holo-q") return connectQ();
  for (const k in surfaces) surfaces[k].agent.setProvider("local");
  $("st-provider").textContent = "Q · reference";
}
async function connectQ() {
  if (_connecting) return; _connecting = true; setQ("thinking", "Connecting Q on-device…");
  const p = PROVIDERS["holo-q"];
  try { if (!_modelsPicked) { await p.models(); _modelsPicked = true; } } catch {}
  const line = code.repl.progressLine('<span class="dim">connecting Q…</span>');
  const r = await p.connect({ onStatus: (s) => s && line('<span class="dim">Q · ' + esc(s + "") + '</span>'), onProgress: (d, t, l) => t && line('<span class="dim">Q · ' + esc(l || "loading") + ' ' + Math.round((d / t) * 100) + '%</span>') });
  _connecting = false;
  if (r.ok) { for (const k in surfaces) surfaces[k].agent.setProvider("holo-q"); $("st-provider").textContent = "Q · on-device · " + r.model; setQ("idle", "Q on-device connected ✓ — " + r.model); updateQGuide(); line('<span class="ok">Q connected</span> <strong>' + esc(r.model) + '</strong> — streaming on your GPU, κ-addressable; every tool call conscience-gated.'); }
  else { document.querySelectorAll(".brain").forEach((s) => (s.value = "local")); setQ("idle", "Staying on the reference brain."); line('Q on-device: <strong>' + esc(r.status || "unavailable") + '</strong> ' + esc(r.reason || "") + ' — staying on the reference brain.'); }
}
document.querySelectorAll(".brain").forEach((s) => s.addEventListener("change", () => setBrain(s.value)));

// ── per-surface permission-mode control ──────────────────────────────────────────────────────────────
document.querySelectorAll("[data-mode-for]").forEach((btn) => {
  const s = surfaces[btn.dataset.modeFor]; const label = btn.querySelector(".modelabel");
  const sync = () => label && (label.textContent = s.agent.mode);
  sync();
  btn.addEventListener("click", () => { const i = MODES.indexOf(s.agent.mode); s.agent.setMode(MODES[(i + 1) % MODES.length]); sync(); });
  const oh = s.repl.handle.bind(s.repl); s.repl.handle = (ev) => { oh(ev); if (ev.type === "mode") sync(); };
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// TABS + per-tab sidebar
// ════════════════════════════════════════════════════════════════════════════════════════════════════
// only wired, functional entries — New ✕ (reset/new), Customize (theme), plus the live Recents list below.
const SIDEBARS = {
  chat: { new: "New chat", nav: [["Customize", "settings"]] },
  cowork: { new: "New task", nav: [["Customize", "settings"]] },
  code: { new: "New session", nav: [["Customize", "settings"]] },
};
const NATIVE_GATED = {};
function toast(msg) {
  const t = document.createElement("div"); t.textContent = msg;
  t.style.cssText = "position:fixed;left:50%;bottom:7rem;transform:translateX(-50%);background:var(--holo-surface-2);border:1px solid var(--holo-border);color:var(--holo-ink);padding:.6rem 1rem;border-radius:var(--holo-radius,14px);z-index:60;font-size:.9375rem;max-width:30rem;text-align:center";
  document.body.appendChild(t); setTimeout(() => t.remove(), 2800);
}
function buildSidebar(name) {
  const cfg = SIDEBARS[name];
  $("newbtn-label").textContent = cfg.new;
  const nl = $("navlist"); nl.innerHTML = "";
  for (const [label, icon] of cfg.nav) {
    const b = document.createElement("button"); b.innerHTML = `<holo-icon name="${icon}" size="14"></holo-icon> ${label}`;
    b.addEventListener("click", () => {
      if (label === "Customize") return cycleTheme();
      if (NATIVE_GATED[label]) return toast(label + " needs a persistent runner — gated to the native host.");
      toast(label + " · " + (label === "Projects" ? "holospaces" : label === "Artifacts" ? "sealed receipts & files" : "settings"));
    });
    nl.appendChild(b);
  }
}
let activeTab = "chat";
function showTab(name) {
  activeTab = name;
  document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  buildSidebar(name);
  if (name === "code") renderRecents();
  updateQGuide();
}
document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("newbtn").addEventListener("click", () => {
  const s = surfaces[activeTab]; s.surfaceEl.classList.remove("active"); s.surfaceEl.classList.add("home");
  if (activeTab === "code") { $("work").hidden = true; $("code-home").hidden = false; }
  s.repl.els.transcript.innerHTML = ""; s.agent.reset && s.agent.reset(); s.repl.els.composer.focus();
});

// ── Chat quick-starts + Cowork task suggestions (prefill / run; no redundant copy) ───────────────────
const CHAT_CHIPS = [["Write", "pencil", "Help me write "], ["Learn", "book", "Explain "], ["Code", "code", "Write code that "], ["Build", "box", "Build "], ["Plan", "list", "Plan "]];
const CW_TASKS = [["Audit the workspace", "shield", "audit the workspace for issues and summarize what you find"], ["Summarize recent changes", "list", "summarize the recent changes in this workspace"], ["Find a TODO to fix", "check", "find a TODO comment and fix it"]];
(function renderChips() {
  const box = $("chat-chips");
  for (const [label, icon, seed] of CHAT_CHIPS) {
    const b = document.createElement("button"); b.className = "chip-action"; b.innerHTML = `<holo-icon name="${icon}" size="13"></holo-icon> ${label}`;
    b.addEventListener("click", () => { const c = $("chat-composer"); c.value = seed; c.focus(); });
    box.appendChild(b);
  }
  const tasks = $("cw-tasks");
  for (const [label, icon, prompt] of CW_TASKS) {
    const r = document.createElement("div"); r.className = "row";
    r.innerHTML = `<span class="ricon"><holo-icon name="${icon}" size="15"></holo-icon></span><span class="rname">${label}</span>`;
    r.addEventListener("click", () => { const c = $("cw-composer"); c.value = prompt; cowork.repl._submit(); });
    tasks.appendChild(r);
  }
})();

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// CODE: sessions, IDE reveal, permission→diff, Monaco, XTerm
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const sessions = []; let currentRow = null;
function revealWork() { $("code-home").hidden = true; $("work").hidden = false; if (!currentRow) addSession(); ensureTerminal().catch(() => {}).then(() => ensureEditor()); }
function addSession() {
  sessions.unshift({ name: "Session", desc: "started just now", live: true });
  renderSessions(); renderRecents();
  currentRow = true;
}
function renderSessions() {
  const list = $("sessions"); if (!list) return;
  if (!sessions.length) { list.innerHTML = '<div class="empty">No sessions yet. Start one below, or click New session.</div>'; return; }
  list.innerHTML = "";
  sessions.forEach((s) => {
    const r = document.createElement("div"); r.className = "row";
    r.innerHTML = `<span class="st"><span class="dot"></span>${s.live ? "Live" : "Idle"}</span><span class="rname">${esc(s.name)}</span><span class="rdesc">${esc(s.desc)}</span><span class="rmeta">HOLOGRAM · now</span>`;
    r.addEventListener("click", () => { revealWork(); });
    list.appendChild(r);
  });
}
function renderRecents() {
  const rec = $("recents"); if (!rec || activeTab !== "code") return;
  rec.innerHTML = "";
  (sessions.length ? sessions : [{ name: "—", desc: "", idle: true }]).forEach((s) => {
    if (s.idle) { rec.innerHTML = '<div class="recent dim">no recents</div>'; return; }
    const d = document.createElement("div"); d.className = "recent live"; d.innerHTML = `<span class="dot"></span><span>${esc(s.name)}</span>`;
    d.addEventListener("click", () => revealWork()); rec.appendChild(d);
  });
}
function onCodeEvent(ev) {
  if (ev.type === "user" && currentRow && sessions[0] && !sessions[0]._named) {
    sessions[0]._named = true; sessions[0].name = (ev.text || "Session").slice(0, 26); sessions[0].desc = ev.text || "";
    renderSessions(); renderRecents(); $("dock-session").textContent = (ev.text || "").slice(0, 22);
  }
  if (ev.type === "tool_result" && ev.result && ev.result.viewer) {
    const vw = ev.result.viewer;
    if (vw.kind === "diff") {
      $("diff-path").textContent = vw.path || ""; $("diff-kappa").textContent = vw.kappa ? "κ " + kshort(vw.kappa) : ""; $("diff-kappa").title = vw.kappa || "";
      $("diff-body").innerHTML = (vw.diff || []).map((d) => `<span class="dl ${d.t === "+" ? "add" : d.t === "-" ? "del" : "ctx"}">${esc((d.t === " " ? " " : d.t) + " " + d.line)}</span>`).join("\n");
      $("diff-gate").innerHTML = `<span class="ok">applied · re-derives (L5)</span>`; $("diffcard").hidden = false;
    } else if (vw.kind === "file" || vw.text != null) { openInEditor(vw.path || "file", vw.text || "", vw.kappa); }
  }
}
let _pending = null;
function requestPermissionCode(tu, repl) {
  const isEdit = tu && tu.danger && /^(write_file|edit_file|write|edit)$/.test(tu.name || tu.title || "");
  if (!isEdit) return repl.requestPermission(tu);
  revealWork();
  return new Promise((resolve) => {
    _pending = resolve;
    $("diff-path").textContent = (tu.input && (tu.input.path || tu.input.file)) || tu.title || "edit"; $("diff-kappa").textContent = "proposed";
    const preview = (tu.input && (tu.input.content || tu.input.replacement || tu.input.new || "")) || "";
    $("diff-body").innerHTML = preview ? `<span class="dl add">${esc(preview).split("\n").join('</span>\n<span class="dl add">')}</span>` : `<span class="dl ctx">(Accept to apply and view the verified change)</span>`;
    const v = tu.verdict || {}; $("diff-gate").innerHTML = `conscience: <strong class="${v.outcome === "accept" ? "ok" : v.outcome === "block" ? "bad" : "warn"}">${esc(v.outcome || "—")}</strong>${v.sealed ? " · sealed (L5)" : " · unsealed"}`;
    $("diffcard").hidden = false;
  });
}
function settle(decision) { if (!_pending) return; const r = _pending; _pending = null; $("diffcard").hidden = (decision !== "accept"); r(decision === "accept" ? "allow" : "deny"); }
$("diff-accept").addEventListener("click", () => settle("accept"));
$("diff-reject").addEventListener("click", () => { $("diffcard").hidden = true; settle("reject"); });

// Monaco editor (reused from the OS workspace vendor)
let _monaco = null, _editor = null, _editorReady = false, _termReady = false;
function injectScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src)); document.head.appendChild(s); }); }
function injectStyle(href) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l); }
async function ensureEditor() {
  if (_editorReady) return; _editorReady = true;
  try {
    self.MonacoEnvironment = { getWorkerUrl: () => URL.createObjectURL(new Blob(["self.onmessage=function(){};"], { type: "text/javascript" })) };
    injectStyle("./vendor/monaco/editor/editor.main.css");
    await injectScript("./vendor/monaco/loader.js");
    window.require.config({ paths: { vs: "./vendor/monaco" } });
    await new Promise((r) => window.require(["vs/editor/editor.main"], r));
    _monaco = window.monaco; _editor = _monaco.editor.create($("editor-host"), { value: "", language: "plaintext", theme: "vs-dark", automaticLayout: true, minimap: { enabled: false } });
  } catch (e) { $("editor-host").hidden = true; $("editor-fallback").hidden = false; $("editor-fallback").textContent = "editor unavailable here — files open read-only.\n" + (e && e.message || e); }
}
const LANG = { js: "javascript", mjs: "javascript", ts: "typescript", json: "json", md: "markdown", css: "css", html: "html", sh: "shell", py: "python", rs: "rust" };
function openInEditor(path, text, kappa) {
  ensureEditor(); $("editor-path").innerHTML = esc(path) + (kappa ? ` <span class="dim">· κ ${esc(kshort(kappa))}</span>` : ""); addToTree(path);
  if (_editor && _monaco) { const ext = (path.split(".").pop() || "").toLowerCase(); _editor.setModel(_monaco.editor.createModel(text, LANG[ext] || "plaintext")); }
  else { $("editor-host").hidden = true; $("editor-fallback").hidden = false; $("editor-fallback").textContent = text; }
}
const _seen = new Set();
function addToTree(path) {
  if (!path || _seen.has(path)) return; _seen.add(path);
  const row = document.createElement("div"); row.className = "f"; row.textContent = path; row.title = path;
  row.addEventListener("click", () => { revealWork(); code.agent.send("read " + path); });
  $("tree-body").appendChild(row);
}
// XTerm terminal (display reused; execution gated to the native host)
async function ensureTerminal() {
  if (_termReady) return; _termReady = true;
  try {
    injectStyle("./vendor/xterm/xterm.css");
    const _def = window.define; try { window.define = undefined; } catch {}      // UMD: avoid Monaco's AMD define shadowing window.Terminal
    try { await injectScript("./vendor/xterm/xterm.js"); await injectScript("./vendor/xterm/addon-fit.js"); } finally { window.define = _def; }
    const term = new window.Terminal({ convertEol: true, fontSize: 13, fontFamily: "ui-monospace, monospace", theme: { background: "#1e1e1e", foreground: "#cccccc" }, cursorBlink: false });
    const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open($("term-host")); fit.fit();
    window.addEventListener("resize", () => { try { fit.fit(); } catch {} });
    term.writeln("\x1b[38;5;209mHolo Code\x1b[0m — sovereign, browser-first");
    term.writeln("");
    term.writeln("Execution (\x1b[1mrun · build · test · shell · git/worktrees · schedule · ssh\x1b[0m) requires the native host.");
    term.writeln("In this browser build it is \x1b[2mdisabled, not faked\x1b[0m. Editing your files works here, each call conscience-gated.");
    $("term-note").textContent = "· execution requires native host";
  } catch (e) {
    $("term-host").innerHTML = `<div style="padding:.7rem;color:var(--holo-ink-dim);font-family:var(--mono);font-size:.9375rem">terminal display unavailable (${esc(e && e.message || e)}). Execution requires the native host — disabled in the browser build.</div>`;
    $("term-note").textContent = "· execution requires native host";
  }
}

// ── personalize + self-verify identity (Law L5) ──────────────────────────────────────────────────────
try {
  const name = (SDK.identity && (await SDK.identity())?.name) || "Ilya";
  $("user-name").textContent = name; $("user-av").textContent = (name[0] || "I").toUpperCase(); // name shown ONCE, in the sidebar
} catch {}
try {
  const obj = { "@type": "schema:SoftwareApplication", "schema:name": "Holo Code" };
  const did = SDK.address ? await SDK.address(obj) : "";
  const okv = (did && SDK.verify) ? await SDK.verify({ id: did, ...obj }) : null;
  const f = $("app-did");
  if (did) { f.textContent = did.split(":").pop().slice(0, 10) + "… " + (okv ? "✓ self-verifying" : ""); f.title = did; } else { f.textContent = "self-contained"; }
} catch { $("app-did").textContent = "self-contained"; }

// ── Q orb — the orchestrator's presence across the whole experience ──────────────────────────────────
function setQ(state, msg) {
  qThinking = (state === "thinking");
  const orb = $("q-orb"); if (!orb) return;
  orb.classList.toggle("thinking", state === "thinking");
  if (msg) {
    const s = $("q-status"); if (s) { s.textContent = msg; s.classList.add("show"); clearTimeout(setQ._t); setQ._t = setTimeout(() => s.classList.remove("show"), state === "thinking" ? 4000 : 2600); }
    const st = $("q-stat"); if (st) st.textContent = msg;
  }
}
function qWatch(ev) {
  switch (ev && ev.type) {
    case "user": setQ("thinking", "Q is on it…"); break;
    case "assistant_delta": setQ("thinking", "Q is thinking…"); break;
    case "tool_start": setQ("thinking", "Q · " + (ev.title || "working")); break;
    case "tool_result": setQ("thinking", "Q · " + (ev.result && ev.result.ok ? (ev.title || "done") : "needs a look")); break;
    case "receipt": setQ("idle", "Sealed · re-derivable receipt"); break;
    case "assistant_done": setQ("idle", "Q · ready"); break;
  }
}
function updateQGuide() {
  const g = $("q-guide"); if (!g) return;
  g.textContent = activeTab === "chat" ? "Ask anything I answer on-device."
    : activeTab === "cowork" ? "Hand me a task I'll work it autonomously."
    : "Describe a change I edit your files, conscience-gated.";
  const lbl = $("q-act-label"); if (lbl) lbl.textContent = code.agent.providerId === "holo-q" ? "On-device brain connected ✓" : "Connect on-device brain";
}
$("q-orb").addEventListener("click", () => { const p = $("q-panel"); p.hidden = !p.hidden; if (!p.hidden) updateQGuide(); });
$("q-act-primary").addEventListener("click", () => { if (code.agent.providerId !== "holo-q") setBrain("holo-q"); else { $("newbtn").click(); $("q-panel").hidden = true; } updateQGuide(); });

// ── theme modes: Dark · Light · Immersive (glass) ────────────────────────────────────────────────────
const THEMES = ["dark", "light", "immersive"];
let themeIdx = THEMES.indexOf("dark"); // default to Dark
try { const t = localStorage.getItem("hcd-theme"); if (t && THEMES.includes(t)) themeIdx = THEMES.indexOf(t); } catch {}
function applyTheme(m) {
  const light = (m === "light" || m === "immersive");   // Immersive is LIGHT, delightful translucent glass
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  document.body.classList.toggle("immersive", m === "immersive");
  document.body.classList.toggle("theme-light", m === "light");
  document.querySelectorAll("#theme-seg [data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === m)));
  themeIdx = Math.max(0, THEMES.indexOf(m));
  try { localStorage.setItem("hcd-theme", m); } catch {}
}
function setTheme(m) { applyTheme(m); }
function cycleTheme() { applyTheme(THEMES[(themeIdx + 1) % THEMES.length]); }
document.querySelectorAll("#theme-seg [data-theme-set]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.themeSet)));
applyTheme(THEMES[themeIdx]);

// ── Q's living orb — the SAME WebGL orb as the holospace desktop (voice/holo-voice-orb.mjs) ──────────
// brand-spectrum icosahedron, alive at rest, energized when Q is thinking (level → orb deformation).
let qThinking = false;
(function mountOrb() {
  const canvas = $("q-orb-canvas"); if (!canvas) return;
  const s = document.createElement("script"); s.src = "/_shared/voice/lib/three.min.js";
  s.onload = () => import("/_shared/voice/holo-voice-orb.mjs").then((m) => {
    try {
      if (m.orbSupported && !m.orbSupported()) return;                 // graceful: keep the CSS fallback glyph
      const orb = m.createOrb(canvas, { detail: 5, spin: 0.9, level: () => qThinking ? (0.55 + 0.35 * Math.sin(performance.now() / 110)) : 0.07 });
      orb.start(); $("q-orb").classList.add("live");
      const ro = () => { try { orb.resize(); } catch {} }; ro(); setTimeout(ro, 60); window.addEventListener("resize", ro);
    } catch {}
  }, () => {});
  document.head.appendChild(s);
})();

// boot on Chat (the familiar default landing); Q greets and guides
showTab("chat");
setQ("idle", "Hi, I'm Q your orchestrator.");
