// cdp-shell.mjs — prove the REAL OS shell (apps/browser/index.html), unmodified, enters the native
// multi-WebContents tier under CEF via the window.__TAURI__ facade, and that its OWN invoke path
// creates a real tab WebContents + that the window-control facade is wired.
const CDP = "http://127.0.0.1:9333";
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
const targets = async () => (await jget("/json/list")).filter((t) => t.type === "page");

(async () => {
  let shell;
  for (let i = 0; i < 60 && !shell; i++) {
    shell = (await targets().catch(() => [])).find((t) => t.url.includes("/apps/browser/"));
    if (!shell) await sleep(500);
  }
  if (!shell) { console.log("FAIL: shell never appeared"); process.exit(1); }
  const c = await connect(shell.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  const evalJs = async (expr, awaitPromise = false) =>
    (await c.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true })).result?.result?.value;

  // wait for the shell's own native-tier detection (it adds body.native only when NATIVE_MW is true).
  let nativeClass = false;
  for (let i = 0; i < 30 && !nativeClass; i++) {
    nativeClass = await evalJs("document.body.classList.contains('native')");
    if (!nativeClass) await sleep(300);
  }
  const invokeType = await evalJs("typeof (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)");
  const winType = await evalJs("typeof (window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow)");

  console.log(`A. real shell native tier: body.native=${nativeClass} | __TAURI__.core.invoke=${invokeType} | window.getCurrentWindow=${winType}`);

  // drive a tab through the shell's OWN facade invoke → must create a real content WebContents.
  const before = (await targets()).length;
  await evalJs("window.__TAURI__.core.invoke('tab_navigate',{id:'p1a',url:'holo://os/home.html'})", true);
  await sleep(1200);
  const after = (await targets()).length;
  const contentTab = (await targets()).find((t) => t.url.includes("/home.html"));
  console.log(`B. invoke('tab_navigate') via real facade: page targets ${before} -> ${after} | content WebContents at home.html: ${!!contentTab}`);

  // window-control facade returns a real boolean from the native window.
  const isMax = await evalJs("window.__TAURI__.window.getCurrentWindow().isMaximized()", true);
  console.log(`C. window control facade: isMaximized() -> ${isMax} (${typeof isMax})`);

  c.close();
  const pass = nativeClass === true && invokeType === "function" && winType === "function" &&
               after === before + 1 && !!contentTab && typeof isMax === "boolean";
  console.log("\nP1a PROOF: " + (pass ? "PASS" : "FAIL"));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log("ERROR: " + e.message); process.exit(1); });
