// cdp-proof.mjs — prove the CEF host in the REAL Chromium it embeds, headlessly, over CDP.
//
// Verifies, against a running holo_cef_host (remote-debugging-port 9333):
//   A. the OS shell booted in real Chromium, served by the holo:// κ-route;
//   B. the web→native bridge (window.HoloHost) creates a real SECOND WebContents tab;
//   C. live Law L5 — a pinned file serves 200; tamper it on disk → 403; restore.
//
// Node 22 globals only (fetch + WebSocket). Usage: HOLO_OS_DIR=<dist> node cdp-proof.mjs
import fs from "node:fs";

const CDP = "http://127.0.0.1:9333";
const OS_DIR = process.env.HOLO_OS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jget = async (path) => (await fetch(CDP + path)).json();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
      }),
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(new Error("ws error: " + (e?.message || e)));
  });
}

const evalJs = async (c, expression) => {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

async function waitShell() {
  for (let i = 0; i < 80; i++) {
    const t = await jget("/json/list").catch(() => []);
    const page = t.find((x) => x.type === "page" && x.url.startsWith("holo://os/"));
    if (page) return { targets: t, page };
    await sleep(500);
  }
  throw new Error("shell page never appeared on CDP");
}

(async () => {
  let pass = true;
  const { targets, page } = await waitShell();
  const pageCount = (t) => t.filter((x) => x.type === "page").length;
  console.log("A. shell:", page.url, "| page targets:", pageCount(targets));

  const c = await connect(page.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  const ready = await evalJs(c, "document.readyState");
  const host = await evalJs(c, "typeof window.HoloHost");
  console.log("   readyState:", ready, "| window.HoloHost:", host);
  if (!page.url.startsWith("holo://os/")) pass = false;
  if (host !== "object") pass = false;

  // B. native bridge → real second WebContents
  await evalJs(c, "window.HoloHost && window.HoloHost.tabNavigate('t1','holo://os/home.html')");
  let after = [];
  for (let i = 0; i < 25; i++) {
    after = await jget("/json/list");
    if (after.find((t) => t.type === "page" && t.url.includes("home.html"))) break;
    await sleep(400);
  }
  const tab = after.find((t) => t.type === "page" && t.url.includes("home.html"));
  console.log("B. bridge tab:", tab ? tab.url : "NOT FOUND", "| page targets:", pageCount(after));
  if (!tab) pass = false;

  // C. live Law L5 on a COLD (lazily-loaded, uncached) file: tamper on disk BEFORE the first fetch,
  //    so the κ-cache can't mask it → cold-fetch must be refused (403); restore → verifies clean (200).
  let coldTamper = "(skipped: set HOLO_OS_DIR)";
  let recovered = "n/a";
  if (OS_DIR) {
    const rel = "_shared/voice/vendor/kokoro/stub.js"; // in the voice tree → not loaded at boot
    const f = OS_DIR + "/" + rel;
    const url = "holo://os/" + rel;
    const orig = fs.readFileSync(f);
    try {
      fs.writeFileSync(f, Buffer.concat([orig, Buffer.from("\n//tamper\n")]));
      coldTamper = await evalJs(c, `fetch('${url}?a=' + Date.now(),{cache:'no-store'}).then(r=>r.status).catch(()=>'err')`);
    } finally {
      fs.writeFileSync(f, orig);
    }
    recovered = await evalJs(c, `fetch('${url}?b=' + Date.now(),{cache:'no-store'}).then(r=>r.status).catch(()=>'err')`);
    if (!(coldTamper === 403 && recovered === 200)) pass = false;
  }
  console.log("C. L5 cold-tamper:", coldTamper, "| after restore:", recovered, "(expect 403 → 200)");

  c.close();
  console.log(pass ? "\nPROOF: PASS" : "\nPROOF: FAIL");
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("PROOF ERROR:", e.message); process.exit(2); });
