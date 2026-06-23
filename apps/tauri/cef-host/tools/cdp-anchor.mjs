// cdp-anchor.mjs — read the live host's verdict on one κ-path, over CDP. Prints "STATUS=<n|refused>".
// Used by the anchor proof: healthy image → 200; manifest tampered (anchor mismatch) → 403/refused
// for EVERYTHING (the store is poisoned at the trust root).
const CDP = "http://127.0.0.1:9333";
const URL = process.env.PROBE_URL || "holo://os/_shared/voice/vendor/kokoro/stub.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jget = async (p) => (await fetch(CDP + p)).json();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    ws.onopen = () => resolve({ send: (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() });
    ws.onerror = () => reject(new Error("ws error"));
  });
}

(async () => {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    const t = await jget("/json/list").catch(() => []);
    page = t.find((x) => x.type === "page");
    if (!page) await sleep(500);
  }
  if (!page) { console.log("STATUS=no-page"); process.exit(0); }
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  const r = await c.send("Runtime.evaluate", {
    expression: `fetch(${JSON.stringify(URL)} + '?z=' + Date.now(), {cache:'no-store'}).then(r=>String(r.status)).catch(()=>'refused')`,
    awaitPromise: true, returnByValue: true,
  });
  c.close();
  console.log("STATUS=" + (r.result?.result?.value ?? "err"));
  process.exit(0);
})().catch((e) => { console.log("STATUS=error:" + e.message); process.exit(0); });
