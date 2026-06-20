// script.js — Holo Control: the telemetry monitoring & control command center. Consumes Holo
// Telemetry (ADR-0073) — the FULL surface: it runs a telemetry runtime (the system's, or its own
// when ambient is absent), instruments its real operations as spans, records real metrics, emits
// logs, propagates W3C Trace Context, and lets you VERIFY any sealed signal live (Law L5 — re-derive,
// don't trust). It models the system as a graph of governable edges and stays calm by default: a
// signal-processing core surfaces only what crosses each edge's noise floor, so the operator sees
// signal and the noise recedes. Honest where a feed isn't wired — "no signal", never a fake.

import * as DSP from "./holo-control-dsp.js";
import { makeTelemetry } from "/_shared/holo-telemetry.mjs";
import { makeStore, memBackend } from "/_shared/holo-store.js";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "html") n.innerHTML = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const bytes = (b) => b < 1024 ? `${b | 0} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;
const rate = (b) => `${bytes(b)}/s`;
const kshort = (k) => { const h = String(k || "").split(":").pop(); return h ? h.slice(0, 8) + "…" + h.slice(-4) : "—"; };
const sha = async (s) => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
const sha256hex = async (b) => { const d = await crypto.subtle.digest("SHA-256", b instanceof Uint8Array ? b : new Uint8Array(b)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
const copy = (t) => { try { navigator.clipboard.writeText(t); toast("copied", t); } catch {} };
const waitFor = (name, ms = 1200) => new Promise((res) => { if (window[name]) return res(window[name]); const t = setInterval(() => { if (window[name]) { clearInterval(t); res(window[name]); } }, 60); setTimeout(() => { clearInterval(t); res(window[name] || null); }, ms); });

// ── state ───────────────────────────────────────────────────────────────────────────────────────
const KINDS = {
  app: { label: "App", ic: "apps" }, agent: { label: "Agent", ic: "robot" },
  egress: { label: "Egress", ic: "upload" }, ingress: { label: "Ingress", ic: "download" },
  social: { label: "Social", ic: "users" }, wallet: { label: "Wallet", ic: "wallet" },
};
const LENSES = [
  { id: "orbit", name: "Signal", ic: "radar" },
  { id: "apps", name: "Apps & Agents", ic: "apps", kinds: ["app", "agent"] },
  { id: "flow", name: "Flows", ic: "swap", kinds: ["ingress", "egress"] },
  { id: "social", name: "Social", ic: "users", kinds: ["social"] },
  { id: "wallet", name: "Wallet", ic: "wallet", kinds: ["wallet"] },
  { id: "telemetry", name: "Telemetry", ic: "pulse" },
];
const WIN = 40;
const edges = new Map();
const blocked = new Set();
let lens = "orbit", selected = null, tick = 0, conscience = null;

// telemetry runtime + live signal stream
let tel = null, tracer = null, meter = null, logger = null, ownRuntime = false;
const stream = []; const STREAM_MAX = 16; let lastSpanCtx = null, sessionCtx = null;

const makeEdge = (id, kind, label, meta = {}) => {
  if (edges.has(id)) return edges.get(id);
  const e = { id, kind, label, dir: meta.dir || (kind === "egress" ? "out" : kind === "ingress" ? "in" : "bi"),
    series: [], value: 0, salience: 0, level: "ambient", alert: false, control: "open",
    firstSeen: tick, lastSeen: tick, authority: meta.authority || "—", k: meta.k || null,
    rederivable: meta.rederivable ?? null, receipts: [], meta };
  edges.set(id, e); return e;
};
const bump = (id, amount) => { const e = edges.get(id); if (e) { e._in = (e._in || 0) + amount; e.lastSeen = tick; } };

// ════════════════════════════ TELEMETRY (the full Holo Telemetry surface) ════════════════════════
async function initTelemetry() {
  tel = await waitFor("HoloTelemetry");                 // the system runtime, if the shell wired it
  if (!tel) {                                           // else the terminal runs its OWN — real + verifiable
    const store = makeStore({ hash: sha256hex, axis: "did:holo:sha256", backend: memBackend() });
    tel = makeTelemetry({ store, hash: sha256hex, conscience: window.HoloConscience || null,
      resource: { "service.name": "holo-control" }, scope: { name: "holo-control", version: "1.0" } });
    ownRuntime = true;
  }
  tracer = tel.tracer("holo-control", "1.0");           // traces (spans → PROV-O activities)
  meter = tel.meter("holo-control");                    // metrics (sum · gauge)
  logger = tel.logger("holo-control");                  // logs
  // a session ROOT span: every instrumented op is its child, so they share ONE trace-id and tracer.seal()
  // produces a coherent, re-derivable PROV-O DAG (the OTel-trace-as-receipt).
  const root = tracer.startSpan("session", { kind: "internal", attributes: { service: "holo-control" } });
  const sealed = await root.end({ status: "ok" }); sessionCtx = { traceId: sealed.traceId, spanId: sealed.spanId }; lastSpanCtx = sessionCtx;
}
function pushSignal(item) {
  stream.unshift({ ...item, at: tick }); if (stream.length > STREAM_MAX) stream.pop();
  if (lens === "telemetry") renderLens(); updateTelPill();
}
async function emitSpan(name, attributes = {}, fn) {
  if (!tracer) return fn ? await fn() : null;
  const span = tracer.startSpan(name, { kind: "internal", attributes, parent: sessionCtx }); let out, err;
  try { out = fn ? await fn() : null; } catch (e) { err = e; }
  const sealed = await span.end({ status: err ? "error" : "ok" });
  lastSpanCtx = { traceId: sealed.traceId, spanId: sealed.spanId };
  pushSignal({ kind: "span", name, kappa: sealed.kappa, rederivable: true, measurement: sealed.object["hostel:measurement"], object: sealed.object });
  if (err) throw err; return out;
}
async function recordMetric(kind, name, value, attrs = {}) {
  if (!meter) return;
  try { const pt = await meter[kind](name, { unit: kind === "gauge" ? "ratio" : "1" }).record(value, attrs);
    pushSignal({ kind: "metric", name, value, kappa: pt.kappa, rederivable: false, measurement: pt.object["hostel:point"] }); } catch {}
}
async function emitLog(sev, body) {
  if (!logger) return;
  try { const lr = await logger.emit(sev, body, lastSpanCtx || {}); pushSignal({ kind: "log", name: body, kappa: lr.kappa, rederivable: true }); } catch {}
}
async function heartbeat() {                            // a real periodic snapshot — keeps telemetry alive + honest
  const v = vitals();
  await recordMetric("gauge", "snr", Number(v.snr.toFixed(3)));
  await recordMetric("counter", "edges.active", v.edges);
  if (v.ingress) await recordMetric("counter", "ingress.bytes", Math.round(v.ingress));
}

// ── SOURCES (real, best-effort, honest) ───────────────────────────────────────────────────────────
async function loadApps() {
  const cat = await fetch("/apps/index.jsonld", { cache: "no-store" }).then((r) => r.json());
  for (const a of cat["dcat:dataset"] || cat.dataset || []) {
    const id = "app:" + (a["dcterms:identifier"] || a.identifier || a["@id"] || a["dcterms:title"]);
    const e = makeEdge(id, "app", a["dcterms:title"] || a["schema:name"] || id, { k: a["@id"] || a["dcat:landingPage"], authority: "installed · self-contained" });
    e.rederivable = true;
  }
}
async function loadAgents() {
  for (const url of ["/.well-known/agents.json", "/.well-known/mcp.json", "/nanda/index.jsonld"]) {
    try {
      const j = await fetch(url, { cache: "no-store" }).then((r) => r.ok ? r.json() : null); if (!j) continue;
      const list = j.agents || j.tools || j.resources || j["dcat:dataset"] || [];
      for (const a of list) { const name = a.name || a.title || a["dcterms:title"] || a.uri || a["@id"]; if (!name) continue;
        makeEdge("agent:" + name, "agent", name, { k: a["@id"] || a.id || a.uri, authority: a.scope || a.capabilities ? "scoped capability" : "discoverable", rederivable: true }); }
      if (list.length) return;
    } catch {}
  }
}
function watchResources() {
  const ingest = (entries) => {
    for (const r of entries) {
      let origin; try { origin = new URL(r.name, location.href).origin; } catch { continue; }
      const isSelf = origin === location.origin, inB = r.transferSize || r.encodedBodySize || 0;
      const ie = makeEdge("ingress:" + origin, "ingress", origin.replace(/^https?:\/\//, ""), { dir: "in", k: origin, authority: isSelf ? "same-origin" : "cross-origin", rederivable: false });
      bump(ie.id, inB || 1);
      const ee = makeEdge("egress:" + origin, "egress", origin.replace(/^https?:\/\//, ""), { dir: "out", k: origin, authority: isSelf ? "same-origin" : "cross-origin", rederivable: false });
      ee.meta.newDestination = !ie.meta.seen; ie.meta.seen = true; bump(ee.id, (r.name.length) || 1);
    }
  };
  try { ingest(performance.getEntriesByType("resource")); } catch {}
  try { new PerformanceObserver((l) => ingest(l.getEntries())).observe({ entryTypes: ["resource"] }); } catch {}
}
async function loadWallet() { try { if (window.HoloWallet && window.HoloWallet.accounts) for (const a of await window.HoloWallet.accounts()) makeEdge("wallet:" + a.address, "wallet", a.label || a.address, { k: a.address, authority: a.chain || "chain", rederivable: false }); } catch {} }
function loadSocial() { try { if (window.HoloRTC && window.HoloRTC.roster) for (const p of window.HoloRTC.roster()) makeEdge("social:" + p.id, "social", p.name || p.id, { k: p.id, authority: "peer", rederivable: false }); } catch {} }

// ── the live tick ───────────────────────────────────────────────────────────────────────────────
function step() {
  tick++;
  for (const e of edges.values()) {
    const v = e._in || 0; e._in = 0; e.value = v; e.series.push(v); if (e.series.length > WIN) e.series.shift();
    const novelty = Math.max(0, 1 - (tick - e.firstSeen) / 8);
    const c = DSP.classify(e.series, v, { kind: e.kind, novelty, prevAlert: e.alert });
    e.salience = e.control === "cut" ? 0 : c.salience; e.level = e.control === "cut" ? "ambient" : c.level; e.alert = c.alert && e.control !== "cut";
    if (e.kind === "egress" && e.meta.newDestination && e.meta.authority === "cross-origin") e.exfil = DSP.egressSpike(e.series, { minRun: 3, toNewDestination: true }).match;
  }
  if (tick % 4 === 0 && tracer) heartbeat();
  pollSystem();
  render();
}
function vitals() {
  const live = [...edges.values()].filter((e) => e.control !== "cut");
  const sum = (k) => live.filter((e) => e.kind === k).reduce((a, e) => a + e.value, 0);
  const snr = DSP.aggregateSnr(live);
  return { edges: live.length, ingress: sum("ingress"), egress: sum("egress"), attention: live.filter((e) => e.alert).length, snr: snr.ratio };
}

// ════════════════════════════ LIVE SYSTEM PULSE ═══════════════════════════════════════════════════
// The OS exposes no streams (every seam is record/snapshot-only), so we POLL the genuine runtimes once
// per tick and fold whatever is live into Control: the real telemetry the system seals (heal sweeps,
// app launches, gate, ingest — via the perception tap), Q's unbidden notices, the spine's coherence,
// and the operator identity this terminal answers to. Each is re-checked every tick (the shell can wire
// them late) and stays silent when absent — no global is faked.
const sys = { tapSeen: 0, notices: new Set() };
let sysCoherence = null, sysAttention = null, sysIdentity = null;
function pollSystem() {
  // identity — who this terminal answers to (real, set by the shell; honest blank standalone)
  if (!sysIdentity && window.HoloIdentity && (window.HoloIdentity.operator || window.HoloIdentity.label)) sysIdentity = window.HoloIdentity;
  // coherence / attention — the OS's own health, from the sense→reason→speak spine
  try { const last = window.HoloSpine && window.HoloSpine.last && window.HoloSpine.last();
    if (last && typeof last.coherence === "number") { sysCoherence = last.coherence; if (typeof last.attention === "number") sysAttention = last.attention; } } catch {}
  // REAL system telemetry — the perception tap seals heal/app/gate/ingest spans; stream them as they land
  try { const spans = window.HoloTap && window.HoloTap.tracer && window.HoloTap.tracer.spans;
    if (Array.isArray(spans) && spans.length > sys.tapSeen) {
      for (const s of spans.slice(sys.tapSeen)) {
        const name = (s.object && (s.object["hostel:name"] || s.object.name)) || s.name || "system";
        pushSignal({ kind: "system", name, kappa: s.kappa, rederivable: true, measurement: s.object && s.object["hostel:measurement"], object: s.object });
      }
      sys.tapSeen = spans.length;
    } } catch {}
  // Q's proactive notices — the OS noticing things, unbidden
  try { const notices = window.Q && window.Q.notices && window.Q.notices();
    if (Array.isArray(notices)) for (const n of notices) {
      const id = n.id || n.kappa || n.text || JSON.stringify(n); if (sys.notices.has(id)) continue; sys.notices.add(id);
      pushSignal({ kind: "notice", name: n.title || n.text || n.summary || "notice", kappa: n.kappa || null, rederivable: !!n.kappa });
    } } catch {}
}

// ════════════════════════════ RENDER ════════════════════════════
function render() { renderTop(); renderRail(); renderLens(); if (selected) renderInspector(); }

function renderTop() {
  const v = vitals();
  const arc = $("#snrArc"); arc.setAttribute("pathLength", "100"); arc.setAttribute("stroke-dasharray", `${(v.snr * 100).toFixed(1)} 100`);
  arc.setAttribute("stroke", v.snr < 0.25 ? "var(--ok)" : v.snr < 0.6 ? "var(--accent)" : "var(--bad)");
  $("#snrNum").textContent = Math.round(v.snr * 100) + "%";
  const stat = (l, val, alert) => el("div", { class: "stat" + (alert ? " alert" : "") }, [el("span", { class: "v", text: val }), el("span", { class: "l", text: l })]);
  const tiles = [stat("Edges", v.edges), stat("Ingress", rate(v.ingress)), stat("Egress", rate(v.egress))];
  if (sysCoherence != null) tiles.push(stat("Coherence", Math.round(sysCoherence * 100) + "%"));   // the OS's own health (live)
  const attention = v.attention + (sysAttention || 0);
  if (attention > 0) tiles.push(stat("Attention", attention, true));
  $("#stats").replaceChildren(...tiles);
  const dot = $("#health"); dot.className = attention > 0 ? "dot alert" : "dot"; dot.style.color = attention > 0 ? "var(--bad)" : "var(--ok)";
}
function updateTelPill() {
  const dot = $("#telDot"), tp = $("#telTp"); if (!dot) return;
  if (!tel) { dot.className = "d off"; tp.textContent = "offline"; return; }
  dot.className = "d";
  let tparent = null; try { if (lastSpanCtx) tparent = tel.inject(lastSpanCtx); } catch {}
  tp.textContent = tparent ? tparent.slice(0, 19) + "…" : (ownRuntime ? "local runtime" : "live");
  const svc = tel.resource && tel.resource["service.name"], scope = tel.scope && `${tel.scope.name}@${tel.scope.version}`;
  const who = sysIdentity ? `${sysIdentity.label || sysIdentity.operator}${sysIdentity.verified ? " ✓" : ""}${sysIdentity.postQuantum ? " · PQ" : ""}` : null;
  $("#telpill").title = `Holo Telemetry · ${ownRuntime ? "terminal runtime" : "system runtime"}` + (who ? ` · operator ${who}` : "") + ` · resource ${svc || "—"} · scope ${scope || "—"}` + (tparent ? ` · traceparent ${tparent}` : "");
  $("#telpill").onclick = () => { if (tparent) copy(tparent); else toast(ownRuntime ? "terminal telemetry runtime — local-first" : "telemetry live"); };
}

function renderRail() {
  const rail = $("#rail"); const items = [];
  for (const L of LENSES) {
    const count = L.id === "telemetry" ? stream.length
      : L.kinds ? [...edges.values()].filter((e) => L.kinds.includes(e.kind) && e.control !== "cut").length
      : [...edges.values()].filter((e) => e.control !== "cut").length;
    const alert = L.kinds ? [...edges.values()].filter((e) => L.kinds.includes(e.kind) && e.alert).length : 0;
    items.push(el("button", { class: "lens" + (lens === L.id ? " on" : ""), onclick: () => setLens(L.id) }, [
      el("span", { class: "ic", html: icon(L.ic) }), el("span", { class: "label", text: L.name }),
      el("span", { class: "meta" + (alert ? " alert" : "") , text: alert ? `▲ ${alert}` : String(count) }),
    ]));
  }
  items.push(el("div", { class: "grow" }));
  items.push(el("div", { class: "note", html: `Your attention goes only to what matters: <b>salience</b> ranks every edge, so calm means healthy. Telemetry runs ${ownRuntime ? "on this terminal" : "across the system"}, every signal verifiable, nothing leaving the device unasked.` }));
  rail.replaceChildren(...items);
}

function setLens(id) { lens = id; $("#stageTitle").textContent = LENSES.find((l) => l.id === id).name; renderStageTools(); render(); }
function renderStageTools() {
  const t = $("#stageTools"); if (!t) return;
  if (lens === "telemetry") {
    t.replaceChildren(
      el("button", { class: "ghost", onclick: sealTrace, title: "Seal the session's spans into one self-verifying PROV-O trace κ (tracer.seal)" }, [iconEl("shield"), "Seal trace"]),
      el("button", { class: "ghost", onclick: adoptContext, title: "Ingest an external W3C traceparent and continue the trace (extract → correlated child span)" }, [iconEl("swap"), "Adopt context"]),
      el("button", { class: "ghost", onclick: copyOtlp, title: "Copy the recent spans as OpenTelemetry OTLP/JSON — stays on this device (toOtlp)" }, [iconEl("download"), "Copy OTLP"]),
      el("button", { class: "ghost", onclick: exportOtlp, title: "Export off-device as OTLP — conscience-gated egress (exportTo)" }, [iconEl("upload"), "Export"]),
    );
  } else t.replaceChildren();
}

function renderLens() {
  const view = $("#view");
  if (lens === "orbit") return renderOrbit(view);
  if (lens === "apps") return renderCards(view, ["app", "agent"], "No apps or agents connected yet.");
  if (lens === "flow") return renderFlow(view);
  if (lens === "social") return renderCards(view, ["social"], "No social connections", "Presence appears here only inside a live session (Holo Meet / share-to-run). Nothing to show — honestly, not a fake roster.");
  if (lens === "wallet") return renderCards(view, ["wallet"], "No wallet connected", "Connect Holo Wallet to see balances, inflows and outflows. Until then there is no signal — and no invented balance.");
  if (lens === "telemetry") return renderTelemetry(view);
}

// ── SIGNAL (birds-eye): calm starfield, labels only where there's signal ──────────────────────────
function renderOrbit(view) {
  const W = view.clientWidth || 900, H = view.clientHeight || 640, cx = W / 2, cy = H / 2;
  const live = [...edges.values()].filter((e) => e.control !== "cut");
  if (!live.length) return view.replaceChildren(emptyState("Listening for connections…", "Holo Control is watching the telemetry plane. As apps, agents, resources, people and wallets connect, they appear here as governable edges."));
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"); svg.id = "orbit"; svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const mk = (t, a) => { const n = document.createElementNS(ns, t); for (const k in a) n.setAttribute(k, a[k]); return n; };
  const temp = (e) => e.alert ? "var(--t4)" : e.level === "signal" ? "var(--t2)" : "var(--calm)";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const byKind = {}; for (const e of live) (byKind[e.kind] ||= []).push(e);
  const kinds = Object.keys(byKind);
  // soft sector rings (just guides)
  for (let ring = 1; ring <= 3; ring++) svg.append(mk("circle", { cx, cy, r: 110 + ring * 120, fill: "none", stroke: "var(--line)", "stroke-opacity": .35 }));
  kinds.forEach((kind, ki) => {
    const list = DSP.rank(byKind[kind]);
    const a0 = (ki / kinds.length) * Math.PI * 2 - Math.PI / 2, span = (Math.PI * 2 / kinds.length) * 0.8;
    list.forEach((e, i) => {
      const ring = 150 + (i % 4) * 120, ang = a0 + span * ((i + 0.5) / Math.max(1, list.length)) - span / 2;
      const x = cx + Math.cos(ang) * ring, y = cy + Math.sin(ang) * ring; e._xy = [x, y];
      const hot = e.level !== "ambient";
      const line = mk("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: temp(e), "stroke-width": hot ? Math.max(1.5, Math.min(6, 1 + Math.log10(1 + e.value) * 1.4)) : 1, "stroke-opacity": hot ? .85 : .12 });
      if (!reduce && hot && e.value > 0) { line.setAttribute("stroke-dasharray", "4 7"); line.append(mk("animate", { attributeName: "stroke-dashoffset", from: e.dir === "in" ? 0 : 11, to: e.dir === "in" ? 11 : 0, dur: "1.1s", repeatCount: "indefinite" })); }
      svg.append(line);
      const g = mk("g", { cursor: "pointer" }); g.addEventListener("click", () => openInspector(e.id));
      const r = e.alert ? 8 : hot ? 6 : 3;
      g.append(mk("circle", { cx: x, cy: y, r, fill: temp(e), "fill-opacity": hot ? 1 : .45 }));
      if (e.exfil) g.append(mk("circle", { cx: x, cy: y, r: r + 6, fill: "none", stroke: "var(--bad)", "stroke-width": 1.6, "stroke-dasharray": "2 4" }));
      if (hot) { const label = mk("text", { x, y: y - r - 7, "text-anchor": "middle", "font-size": 14, fill: e.alert ? "var(--bad)" : "var(--ink)" }); label.textContent = e.label.length > 20 ? e.label.slice(0, 19) + "…" : e.label; g.append(label); }
      const title = mk("title", {}); title.textContent = `${e.label} · ${KINDS[e.kind].label} · ${rate(e.value)}`; g.append(title);
      svg.append(g);
    });
  });
  svg.append(mk("circle", { cx, cy, r: 34, fill: "var(--panel2)", stroke: "var(--accent)", "stroke-width": 2 }));
  if (!reduce) { const halo = mk("circle", { cx, cy, r: 34, fill: "none", stroke: "var(--accent)", "stroke-opacity": .5, "stroke-width": 2 }); halo.append(mk("animate", { attributeName: "r", values: "34;46;34", dur: "3.4s", repeatCount: "indefinite" }), mk("animate", { attributeName: "stroke-opacity", values: ".5;0;.5", dur: "3.4s", repeatCount: "indefinite" })); svg.append(halo); }
  const c = mk("text", { x: cx, y: cy + 5, "text-anchor": "middle", "font-size": 15, fill: "var(--accent)", "font-weight": 700 }); c.textContent = "OS"; svg.append(c);
  view.replaceChildren(svg);
}

function renderCards(view, kinds, emptyMsg, emptyHint) {
  const list = DSP.rank([...edges.values()].filter((e) => kinds.includes(e.kind)));
  if (!list.length) return view.replaceChildren(emptyState(emptyMsg, emptyHint));
  view.replaceChildren(el("div", { class: "grid" }, list.map(card)));
}
function card(e) {
  return el("div", { class: "card" + (e.alert ? " alert" : ""), onclick: () => openInspector(e.id) }, [
    el("div", { class: "hd" }, [el("span", { class: "ic", html: icon(KINDS[e.kind].ic) }), el("span", { class: "name", text: e.label }), el("span", { class: "badge " + e.level }, e.level)]),
    el("div", { class: "sub", text: kshort(e.k) }),
    sparkline(e.series, e.alert),
    el("div", { class: "row" }, [el("span", { class: "dot-k" }), `${e.dir === "in" ? "↓ in" : e.dir === "out" ? "↑ out" : "↕"} · ${rate(e.value)}`, e.control !== "open" ? el("span", { class: "badge " + e.control, text: e.control }) : null]),
  ]);
}
function sparkline(series, alert) {
  const ns = "http://www.w3.org/2000/svg", W = 240, H = 34, n = series.length; const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "spark"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (n < 2) { svg.append(line(ns, 0, H - 1, W, H - 1, "var(--line)")); return svg; }
  const max = Math.max(1, ...series), floor = DSP.noiseFloor(series), fy = H - 1 - Math.min(1, floor / max) * (H - 3);
  const fl = line(ns, 0, fy, W, fy, "var(--dim)"); fl.setAttribute("stroke-dasharray", "2 3"); fl.setAttribute("stroke-opacity", ".5"); svg.append(fl);
  const p = document.createElementNS(ns, "polyline"); p.setAttribute("points", series.map((v, i) => `${(i / (n - 1) * W).toFixed(1)},${(H - 1 - (v / max) * (H - 3)).toFixed(1)}`).join(" ")); p.setAttribute("fill", "none"); p.setAttribute("stroke", alert ? "var(--bad)" : "var(--t2)"); p.setAttribute("stroke-width", "2"); svg.append(p);
  return svg;
}
const line = (ns, x1, y1, x2, y2, stroke) => { const l = document.createElementNS(ns, "line"); l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2); l.setAttribute("stroke", stroke); return l; };

function renderFlow(view) {
  const ingress = DSP.rank([...edges.values()].filter((e) => e.kind === "ingress" && e.control !== "cut"));
  const egress = DSP.rank([...edges.values()].filter((e) => e.kind === "egress" && e.control !== "cut"));
  if (!ingress.length && !egress.length) return view.replaceChildren(emptyState("No data flows yet", "This view streams REAL network traffic from the Performance API. Open another app or trigger a fetch and the flows appear live."));
  const maxIn = Math.max(1, ...ingress.map((e) => e.value)), maxOut = Math.max(1, ...egress.map((e) => e.value));
  const bar = (e, cls, max) => el("div", { class: "bar " + cls + (e.alert ? " alert" : ""), onclick: () => openInspector(e.id) }, [
    el("div", { class: "t" }, [el("span", { class: "n", text: e.label }), el("span", { class: "v", text: rate(e.value) })]),
    el("div", { class: "track" }, el("i", { style: `width:${Math.max(3, (e.value / max) * 100).toFixed(0)}%` })),
  ]);
  view.replaceChildren(el("div", { class: "flow" }, [
    el("div", { class: "col" }, [el("h3", { text: `Ingress · ${ingress.length} sources` }), ...ingress.map((e) => bar(e, "ingress", maxIn))]),
    el("div", { class: "hub" }, [el("span", { class: "ic", html: icon("radar") }), el("span", { class: "mono", text: "OS" })]),
    el("div", { class: "col" }, [el("h3", { text: `Egress · ${egress.length} destinations` }), ...egress.map((e) => bar(e, "egress", maxOut))]),
  ]));
}

// ── TELEMETRY: the live, verifiable signal stream (tracer · meter · logger · verify) ──────────────
function renderTelemetry(view) {
  if (!stream.length) return view.replaceChildren(emptyState("Telemetry is warming up…", `The terminal runs ${ownRuntime ? "its own" : "the system"} Holo Telemetry runtime. Real spans, metrics and logs stream here as the system breathes — each one a content-addressed object you can verify (Law L5).`));
  view.replaceChildren(el("div", { class: "stream" }, stream.map(sigRow)));
}
function sigRow(s) {
  const split = s.rederivable ? '<span class="split"><span class="rd">● re-derivable</span></span>' : '<span class="split"><span class="at">● attested</span></span>';
  return el("div", { class: "sig" }, [
    el("span", { class: "tag " + s.kind, text: s.kind }),
    el("span", { class: "nm", text: s.name + (s.value != null ? " = " + s.value : "") }),
    el("span", { class: "kx", text: kshort(s.kappa), title: s.kappa, onclick: () => copy(s.kappa) }),
    el("span", { class: "sp" }), el("span", { class: "split", html: split }), verifyBtn(s),
  ]);
}
function verifyBtn(s) {
  const b = el("button", { class: "verify", html: icon("shield") + " Verify", onclick: async () => {
    b.innerHTML = icon("shield") + " verifying…";
    const v = await tel.verify(s.kappa);                 // structural re-derivation (Law L5)
    const att = s.measurement ? tel.verifyAttestation(s.measurement) : null;   // the host-attested half
    if (v.ok) {
      b.className = "verify ok";
      const tail = att && att.attested ? (att.ok ? " · attested ✓" : " · attest ✗") : "";
      b.innerHTML = icon("check") + " re-derived (L5)" + tail;
      b.title = `structure re-derives to ${kshort(s.kappa)}` + (att ? (att.attested ? ` · host attestation ${att.ok ? "valid" : "INVALID"}` : ` · wall-clock is host-claimed (no host key in this context), not re-derived`) : "");
    } else { b.className = "verify bad"; b.innerHTML = "✗ " + (v.reason || "failed"); }
  } });
  return b;
}
// SEAL TRACE — the session's spans become ONE self-verifying PROV-O trace κ (tracer.seal); its Verify
// re-derives the WHOLE DAG (every span re-derives + shares the trace-id), the OTel-trace-as-receipt story.
async function sealTrace() {
  if (!tracer) return toast("Telemetry offline");
  const sealed = await tracer.seal();
  if (!sealed.spanCount) return toast("No spans to seal yet");
  pushSignal({ kind: "trace", name: `trace · ${sealed.spanCount} spans`, kappa: sealed.kappa, rederivable: true, object: sealed.object });
  toast(`Sealed trace · ${sealed.spanCount} spans`, sealed.kappa);
}
// ADOPT CONTEXT — ingest an external W3C traceparent (extract) and continue it: a correlated child span
// under the incoming trace-id. Completes the inject⇄extract round-trip the propagation standard is for.
async function adoptContext(tp) {
  if (!tracer) return toast("Telemetry offline");
  if (tp == null) tp = prompt("Paste an incoming W3C traceparent (00-<32hex>-<16hex>-01):", lastSpanCtx ? tel.inject(lastSpanCtx) : "");
  if (!tp) return;
  const ex = tel.extract(String(tp).trim());
  if (!ex.valid) return toast("Invalid traceparent (not W3C Trace Context)");
  // a SEPARATE tracer for the foreign trace, so the external trace-id never pollutes the session DAG
  const span = tel.tracer("adopted", "1.0").startSpan("adopted.context", { kind: "server", attributes: { source: "external" }, parent: { spanId: ex.spanId, traceId: ex.traceId } });
  const sealed = await span.end({ status: "ok" }); lastSpanCtx = { traceId: sealed.traceId, spanId: sealed.spanId };
  pushSignal({ kind: "span", name: `adopted.context · trace ${ex.traceId.slice(0, 8)}…`, kappa: sealed.kappa, rederivable: true, measurement: sealed.object["hostel:measurement"], object: sealed.object });
  toast(sealed.traceId === ex.traceId ? `Adopted trace ${ex.traceId.slice(0, 12)}… — child span correlated` : "Adopted context", sealed.kappa);
}
// COPY OTLP — the recent spans as a genuine OpenTelemetry OTLP/JSON envelope (toOtlp), to the clipboard.
// Local-first: this never leaves the device; it's the interop hand-off any OTel collector can ingest.
async function copyOtlp() {
  const spans = stream.filter((s) => s.kind === "span" && s.object).map((s) => s.object);
  if (!spans.length) return toast("No spans to copy yet");
  try { await navigator.clipboard.writeText(JSON.stringify(tel.toOtlp(spans), null, 2)); toast(`Copied OTLP · ${spans.length} spans (stayed local)`); } catch { toast("Clipboard unavailable"); }
}
async function exportOtlp() {
  const spans = stream.filter((s) => s.kind === "span" && s.object).map((s) => s.object);
  if (!spans.length) return toast("No spans to export yet");
  const local = await tel.exportTo("https://collector.example/v1/traces", { spans, consent: false });   // default-deny (Law L1)
  if (local.ok) return;
  const go = await confirmModal("Send telemetry off-device?", `Holo Control is <b>local-first</b> — telemetry stays on this device by default (Law L1). ${local.reason}. Exporting sends <b>${spans.length}</b> span(s) as OpenTelemetry OTLP, through the conscience gate. Proceed?`, "Export");
  if (!go) return toast("Kept local — nothing left the device");
  const sent = await tel.exportTo("https://collector.example/v1/traces", { spans, consent: true });
  toast(sent.ok ? `Exported ${sent.exported} span(s) as OTLP · conscience: accepted` : "Conscience blocked the export");
}

function emptyState(big, hint) { return el("div", { class: "empty" }, el("div", { class: "inner" }, [el("div", { class: "big", text: big }), hint ? el("div", { class: "hint", text: hint }) : null])); }

// ════════════════════════════ INSPECTOR ════════════════════════════
function openInspector(id) { selected = id; $("#inspector").classList.add("open"); renderInspector(); }
function closeInspector() { selected = null; $("#inspector").classList.remove("open"); }
function renderInspector() {
  const e = edges.get(selected); if (!e) return closeInspector();
  $("#iName").innerHTML = `<span class="ic" style="color:var(--accent)">${icon(KINDS[e.kind].ic)}</span> ${e.label}`;
  const splitBadge = e.rederivable == null ? null : e.rederivable
    ? '<span class="split"><span class="rd">● re-derivable provenance (Law L5)</span></span>'
    : '<span class="split"><span class="at">● host-attested measurement (not re-derived)</span></span>';
  const field = (k, v, mono) => el("div", { class: "field" }, [el("span", { class: "k", text: k }), el("span", { class: "v" + (mono ? " mono" : ""), html: v })]);
  const ctl = (label, ic, action) => el("button", { class: "ctl" + (action === "cut" ? " cut" : ""), "aria-pressed": stateOf(e, action) ? "true" : "false", onclick: () => applyControl(e, action) }, [el("span", { class: "ic", html: icon(ic) }), label]);
  $("#iBody").replaceChildren(
    el("div", {}, [el("span", { class: "badge " + e.level }, e.level), " ", e.control !== "open" ? el("span", { class: "badge " + e.control, text: e.control }) : "", e.exfil ? el("span", { class: "badge alert", text: "⚠ exfil pattern" }) : ""]),
    field("Class", `${KINDS[e.kind].label} · ${e.dir === "in" ? "ingress" : e.dir === "out" ? "egress" : "bidirectional"}`),
    field("Identity (κ)", `<span title="${e.k || ""}">${kshort(e.k)}</span>`, true),
    field("Authority", e.authority),
    field("Signal", `salience ${(e.salience * 100).toFixed(0)}% · z=${DSP.zScore(e.value, e.series).toFixed(1)} · floor ${rate(DSP.noiseFloor(e.series))}`),
    splitBadge ? el("div", { html: splitBadge }) : null,
    el("div", { class: "field" }, [el("span", { class: "k", text: "Signal timeline" }), timeline(e)]),
    el("div", { class: "field" }, [el("span", { class: "k", text: "Control" }), el("div", { class: "controls" }, [ctl("Throttle", "gauge", "throttle"), ctl("Restrict", "lock", "restrict"), ctl("Pause", "pause", "pause"), ctl("Cut", "scissors", "cut")])]),
    e.receipts.length ? el("div", { class: "field" }, [el("span", { class: "k", text: "Control receipts (verifiable)" }), el("div", { class: "receipts" }, e.receipts.map(receiptRow))]) : null,
  );
}
const stateOf = (e, action) => e.control === ({ throttle: "throttled", restrict: "restricted", pause: "paused", cut: "cut" })[action];
function receiptRow(r) {
  const row = el("div", { class: "r" }, [el("span", { text: r.action }), el("span", { text: "· " + r.verdict, style: "color:var(--dim)" }), el("span", { class: "kx", text: kshort(r.kappa), title: r.kappa, onclick: () => verifyReceipt(row, r.kappa) })]);
  return row;
}
async function verifyReceipt(row, kappa) {
  const v = await tel.verify(kappa); const kx = row.querySelector(".kx");
  kx.innerHTML = (v.ok ? icon("check") + " " : "✗ ") + kshort(kappa); kx.style.color = v.ok ? "var(--ok)" : "var(--bad)";
  toast(v.ok ? "Receipt re-derived ✓ (Law L5)" : "Receipt failed: " + v.reason, kappa);
}
function timeline(e) {
  const ns = "http://www.w3.org/2000/svg", W = 320, H = 76; const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "timeline"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const s = e.series; if (s.length < 2) return svg;
  const max = Math.max(1, ...s), sm = DSP.smooth(s, .35);
  const path = (arr, color, w, dash) => { const p = document.createElementNS(ns, "polyline"); p.setAttribute("points", arr.map((v, i) => `${(i / (s.length - 1) * W).toFixed(1)},${(H - 3 - (v / max) * (H - 8)).toFixed(1)}`).join(" ")); p.setAttribute("fill", "none"); p.setAttribute("stroke", color); p.setAttribute("stroke-width", w); if (dash) p.setAttribute("stroke-dasharray", dash); svg.append(p); };
  path(s, e.alert ? "var(--bad)" : "var(--t2)", 2); path(sm, "var(--accent)", 1.3, "4 3");
  return svg;
}

// ════════════════════════════ CONTROL PLANE ════════════════════════════
async function applyControl(e, action) {
  if (action === "cut") { const ok = await confirmModal("Cut this connection?", `This severs <b>${e.label}</b>. ${e.kind === "egress" ? "This pane will refuse future requests to this destination." : "The policy is recorded and the edge is marked cut; cross-process enforcement is armed pending the delegation layer."} The action is sealed to a verifiable receipt.`, "Cut"); if (!ok) return; }
  let verdict = "accepted";
  try { if (conscience && conscience.evaluate) { const v = conscience.evaluate({ action: "control." + action, edge: e.id, leavesNoAuditTrace: false, refusesLawfulRequest: false }); verdict = v.outcome === "block" ? "blocked" : v.outcome; if (v.outcome === "block") return toast("Conscience blocked the action"); } } catch {}
  if (action === "cut") { e.control = "cut"; if (e.kind === "egress" && e.k) blocked.add(e.k); }
  else { const want = { throttle: "throttled", restrict: "restricted", pause: "paused" }[action]; e.control = e.control === want ? "open" : want; }
  const kappa = await sealControl(e, action, verdict);
  e.receipts.unshift({ action, verdict, kappa, at: tick });
  toast(`${action} · ${e.label}`, kappa); render();
}
async function sealControl(e, action, verdict) {
  if (tracer) {
    const span = tracer.startSpan("control." + action, { kind: "internal", attributes: { edge: e.id, kind: e.kind, verdict }, parent: sessionCtx });
    const sealed = await span.end({ status: "ok" }); lastSpanCtx = { traceId: sealed.traceId, spanId: sealed.spanId };
    pushSignal({ kind: "span", name: "control." + action + " · " + e.label, kappa: sealed.kappa, rederivable: true, measurement: sealed.object["hostel:measurement"], object: sealed.object });
    emitLog(13, "control." + action + " on " + e.label);
    return sealed.kappa;
  }
  return "did:holo:sha256:" + await sha(JSON.stringify({ action, edge: e.id, verdict, tick }));
}
// real egress enforcement for what this pane owns: refuse fetches to a cut origin
const _fetch = window.fetch.bind(window);
window.fetch = (input, init) => { try { const u = new URL(typeof input === "string" ? input : input.url, location.href); if (blocked.has(u.origin)) return Promise.reject(new Error("Holo Control: egress to " + u.origin + " is CUT by the operator")); } catch {} return _fetch(input, init); };

// ── modal · toast · palette · isolate ─────────────────────────────────────────────────────────────
function confirmModal(title, blast, goLabel = "Confirm") {
  return new Promise((resolve) => {
    $("#modal").replaceChildren(el("h3", { text: title }), el("div", { class: "blast", html: blast }),
      el("div", { class: "acts" }, [
        el("button", { onclick: () => { $("#scrim").classList.remove("show"); resolve(false); } }, "Cancel"),
        el("button", { class: "go", onclick: () => { $("#scrim").classList.remove("show"); resolve(true); } }, goLabel),
      ]));
    $("#scrim").classList.add("show");
  });
}
let toastT; function toast(msg, kappa) {
  const t = $("#toast"); t.replaceChildren(msg, kappa ? el("span", { class: "kx", text: kshort(kappa) }) : null);
  t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3400);
}
function commandPalette() { const q = prompt("Search edges by name or κ:"); if (!q) return; const hit = [...edges.values()].find((e) => (e.label + " " + (e.k || "")).toLowerCase().includes(q.toLowerCase())); if (hit) openInspector(hit.id); else toast("No edge matches “" + q + "”"); }
async function isolateAll() {
  const out = [...edges.values()].filter((e) => e.kind === "egress" && e.meta.authority === "cross-origin" && e.control !== "cut");
  if (!out.length) return toast("No cross-origin egress to cut");
  if (!(await confirmModal("Isolate — cut all cross-origin egress?", `This cuts <b>${out.length}</b> outbound destination(s). Same-origin OS traffic is untouched. Each cut is sealed to a receipt.`, "Isolate"))) return;
  for (const e of out) await applyControl(e, "cut"); toast(`Isolated · cut ${out.length} egress edges`);
}

// ── icons (clean inline monochrome SVGs) ────────────────────────────────────────────────────────
const PATHS = {
  radar: '<circle cx="12" cy="12" r="9"/><path d="M12 12V3"/><path d="M12 12l7 4"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  robot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4M8 13h.01M16 13h.01M9.5 16.5h5"/>',
  upload: '<path d="M12 19V6M5 12l7-7 7 7"/>', download: '<path d="M12 5v13M5 12l7 7 7-7"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5M21 20a6 6 0 0 0-4-5.6"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M16 14h2"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8"/>',
  gauge: '<path d="M12 13l4-4"/><path d="M4 17a8 8 0 1 1 16 0"/><circle cx="12" cy="13" r="1.5" fill="currentColor" stroke="none"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="3.5" height="14" rx="1.2"/>',
  scissors: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5 20 18M8 15.5 20 6"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>', check: '<path d="M5 13l4 4L19 7"/>',
  shield: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
};
function icon(name) { const p = PATHS[name]; if (!p) return ""; return `<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em">${p}</svg>`; }
const iconEl = (name) => el("span", { class: "ic", html: icon(name), style: "display:inline-flex" });

// ── init ────────────────────────────────────────────────────────────────────────────────────────
async function init() {
  window.HoloControl = { edges, vitals, setLens, openInspector, get lens() { return lens; }, get stream() { return stream; },
    telemetryWired: () => !!tel, ownRuntime: () => ownRuntime, DSP,
    verify: (k) => tel && tel.verify(k), verifyAttestation: (m) => tel && tel.verifyAttestation(m),
    inject: (c) => tel && tel.inject(c), extract: (h) => tel && tel.extract(h), toOtlp: (s) => tel && tel.toOtlp(s),
    sealTrace, adoptContext };
  conscience = window.HoloConscience || null;
  $("#isoIc")?.replaceWith(iconEl("scissors"));
  $("#iClose").addEventListener("click", closeInspector);
  $("#isolate").addEventListener("click", isolateAll);
  window.addEventListener("keydown", (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); commandPalette(); } });
  await initTelemetry();
  watchResources();
  await emitSpan("boot.discover", { runtime: ownRuntime ? "own" : "system" }, async () => { await Promise.all([loadApps().catch(() => {}), loadAgents().catch(() => {}), loadWallet().catch(() => {})]); loadSocial(); });
  await emitLog(9, `Holo Control online · ${ownRuntime ? "terminal" : "system"} telemetry runtime`);
  renderStageTools(); step(); setInterval(step, 1000);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
