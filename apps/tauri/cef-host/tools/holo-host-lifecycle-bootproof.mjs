// holo-host-lifecycle-bootproof.mjs — the deploy-gate WITNESS for the native host boot-health invariant.
//
// Asserts, over CDP (:9333) against a running holo_cef_host, that the host reached a HEALTHY boot:
//   1. there is at least one holo://os page target (a real OS window exists),
//   2. window.__holoLifecycle.healthy === true (the supervisor's own verdict — process L5),
//   3. the lifecycle trail ends in a healthy state, not a collapse.
// GREEN → exit 0; RED → exit 1. Prove RED first (run with HOLO_WINDOW_MODE=views, which wedges Views in this
// CEF dist → no healthy boot) so this is a real gate, not a rubber stamp.
//
// Usage:  node holo-host-lifecycle-bootproof.mjs [port]   (default 9333; host must already be running)
const PORT = Number(process.argv[2] || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) { console.log(`RED  ✗ ${msg}`); process.exit(1); }
function pass(msg) { console.log(`GREEN ✓ ${msg}`); process.exit(0); }

// Poll for an OS page target (the host needs a moment past the T_live latch to mark healthy).
let page = null;
for (let i = 0; i < 25 && !page; i++) {
  try {
    const list = await (await fetch(`${BASE}/json/list`)).json();
    const pages = list.filter((p) => p.type === "page");
    page = pages.find((p) => /^holo:\/\/os/.test(p.url)) || pages.find((p) => /^data:/.test(p.url)) || null;
    if (page && /^data:/.test(page.url)) fail(`host fell back to the DIAGNOSTIC surface (boot collapsed): ${page.title || page.url.slice(0, 60)}`);
  } catch (e) { /* CDP not up yet */ }
  if (!page) await sleep(600);
}
if (!page) fail("no holo://os page target on CDP — the OS window never came up (boot collapse / no-show)");
console.log(`  page: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true }); return r && r.result && r.result.value; };

// Wait up to ~8s for the supervisor to publish a healthy verdict into the shell.
let lc = null;
for (let i = 0; i < 16; i++) {
  lc = await ev("window.__holoLifecycle ? JSON.parse(JSON.stringify(window.__holoLifecycle)) : null");
  if (lc && lc.healthy === true) break;
  await sleep(500);
}
if (!lc) fail("window.__holoLifecycle absent — the supervisor never published a boot verdict");
console.log(`  __holoLifecycle: healthy=${lc.healthy} strategy=${lc.strategy} paintMs=${lc.paintMs} heals=${lc.heals} events=${(lc.events || []).length}`);
const tail = (lc.events || []).slice(-1)[0] || "";
if (lc.healthy !== true) fail(`boot not healthy (strategy=${lc.strategy}, last="${tail}")`);
if (/COLLAPSE|no window|diagnostic/i.test(tail)) fail(`lifecycle tail indicates collapse: "${tail}"`);
// Canonical login: the boot must land on the one κ-sealed OS entry (login/shell), never a stray/blank/newtab.
if (!/^holo:\/\/os\//.test(page.url)) fail(`not the canonical OS entry: ${page.url}`);
// Instant-boot budget: paintMs is "boot → canonical login on screen". Enforce a ceiling (override via BUDGET).
const budget = Number(process.env.HOLO_PAINT_BUDGET_MS || 1500);  // measured ~350ms; 1500 = generous regression ceiling
if (typeof lc.paintMs !== "number" || lc.paintMs < 0) fail("paintMs not recorded — login never reached load-end");
if (lc.paintMs > budget) fail(`boot too slow: paintMs=${lc.paintMs} > budget ${budget}ms`);

// REAL CONTENT (no false positive): the canonical login must have actually RENDERED — not a Chrome error
// page at the holo:// URL (ERR_INVALID_RESPONSE from a stale seal renders as an error doc at this same URL).
const title = await ev("document.title || ''");
const isErr = await ev("/can.?t be reached|ERR_[A-Z_]+/i.test((document.body&&document.body.innerText)||'')");
const hasLogin = await ev("!!(document.getElementById('holo-agent-login')||document.getElementById('panel')||document.querySelector('[data-holo-shell]'))");
console.log(`  content: title=${JSON.stringify(title)} loginDOM=${hasLogin} chromeError=${isErr}`);
if (isErr) fail(`canonical entry is a browser ERROR page (stale seal? run node _reseal-dist.mjs): ${title}`);
if (!hasLogin) fail(`login surface did not render (no login/shell DOM) — title=${JSON.stringify(title)}`);
pass(`healthy boot — strategy=${lc.strategy}, paintMs=${lc.paintMs}ms (≤${budget}), real login rendered ("${title}"), trail ends "${tail}"`);
