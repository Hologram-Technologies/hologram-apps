// cdp-latency.mjs — measure the by-κ cache effect in the live CEF host, over CDP.
//
// Fetches a large pinned asset N times from the shell page (unique query each time so Chromium's own
// cache never serves it → the κ-route handler runs every time). The FIRST hit is COLD (disk read +
// sha256 + blake3 over the bytes); the rest are WARM (κ-cache: a map lookup, no disk, no re-hash).
// Node 22 globals only. Usage: node cdp-latency.mjs   (PROBE_URL optional)
const CDP = "http://127.0.0.1:9333";
const URL =
  process.env.PROBE_URL ||
  "holo://os/_shared/voice/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm";
const N = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jget = async (p) => (await fetch(CDP + p)).json();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(new Error("ws error"));
  });
}
const evalJs = async (c, expression) => {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

(async () => {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    const t = await jget("/json/list").catch(() => []);
    page = t.find((x) => x.type === "page" && x.url.startsWith("holo://os/"));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("shell page not found");
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Runtime.enable");

  const expr = `(async () => {
    const url = ${JSON.stringify(URL)};
    const t = [];
    for (let i = 0; i < ${N}; i++) {
      const s = performance.now();
      const r = await fetch(url + '?n=' + i, { cache: 'no-store' });
      const b = await r.arrayBuffer();
      t.push({ ms: +(performance.now() - s).toFixed(1), status: r.status, bytes: b.byteLength });
    }
    return t;
  })()`;
  const t = await evalJs(c, expr);
  c.close();

  const cold = t[0];
  const warm = t.slice(1).map((x) => x.ms).sort((a, b) => a - b);
  const warmMedian = warm[Math.floor(warm.length / 2)];
  console.log("asset:", URL.split("/").pop(), "|", (cold.bytes / 1048576).toFixed(1), "MB | status", cold.status);
  console.log("per-fetch ms:", t.map((x) => x.ms).join(", "));
  console.log(`COLD (disk + sha256 + blake3): ${cold.ms} ms`);
  console.log(`WARM (κ-cache hit, median):    ${warmMedian} ms`);
  const speedup = (cold.ms / warmMedian).toFixed(1);
  const ok = cold.status === 200 && warmMedian <= cold.ms;
  console.log(`speedup: ${speedup}x  → ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("LATENCY ERROR:", e.message); process.exit(2); });
