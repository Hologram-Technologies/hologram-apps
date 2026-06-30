// quantum-boot.mjs — boots the κ-substrate quantum kernel for Holo Quantum.
// Reuses the sealed, content-addressed Pyodide that ships with Holo Jupyter (no duplication),
// installs UNMODIFIED PennyLane, registers the first-party tqc.anyon device by entry point,
// and exposes a warm run() that executes verbatim PennyLane scripts.
//
// The whole kernel is one object kept warm on the page; cold boot happens once.
//
// Provability (S4): every circuit the device executes is content-addressed with holo-blake3
// over its canonical form (the substrate κ) and appended to a holo-strand — a signed,
// hash-linked, verifiable chain. Equivalent circuits mint the SAME κ (the TQC echo property),
// and the whole session is a provable, replayable record (Law L5).

import { kappaBlake3 } from "/usr/lib/holo/holo-blake3.mjs";
import { makeStrand } from "/usr/lib/holo/holo-strand.mjs";

const PYODIDE_BASE = "/apps/jypyter/static/pyodide/";   // shared sealed Pyodide (Law L5)
const enc = new TextEncoder();

// FULLY OFFLINE (Law L4 — no CDN, no PyPI at runtime). The native stack loads from the bundled
// Pyodide lock (its wheels + python_stdlib.zip + libopenblas ride in the sealed image); PennyLane
// and its pure-python deps install from wheels bundled under ./pypi/ (see pypi/index.json). Nothing
// is fetched from the network.
const NATIVE = ["numpy","scipy","networkx","rustworkx","autograd"];
const PYPI_DIR = "/apps/quantum/pypi/";   // bundled wheelhouse (sealed, content-addressed)

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

export class QuantumKernel {
  constructor({ onStage } = {}) {
    this.onStage = onStage || (() => {});
    this.ready = false;
    this.py = null;
    // The provenance strand for this session. now() uses real wall-clock; in-memory backend.
    this.strand = makeStrand({ now: () => new Date().toISOString() });
    this.lastKappa = null;
  }

  async boot() {
    if (this.ready) return this;
    this.onStage("loading runtime");
    if (typeof loadPyodide === "undefined") await loadScript(PYODIDE_BASE + "pyodide.js");
    this.py = await loadPyodide({ indexURL: PYODIDE_BASE });
    const py = this.py;

    this.onStage("loading scientific stack");
    await py.loadPackage(["micropip", ...NATIVE]);

    this.onStage("installing PennyLane (offline)");
    // Build absolute URLs to every bundled wheel and install them all at once with deps=False —
    // the native deps are already loaded from the lock, the pure deps are all in this set, so
    // micropip never needs to touch the network.
    const wheels = await (await fetch(PYPI_DIR + "index.json")).json();
    const urls = wheels.map((f) => PYPI_DIR + f);
    await py.runPythonAsync(`
import micropip
await micropip.install(${JSON.stringify(urls)}, deps=False)
`);

    this.onStage("registering tqc.anyon");
    // Fetch the first-party plugin source (single source of truth) and register it as a real
    // entry-point plugin so qml.device("tqc.anyon", ...) resolves by name in verbatim scripts.
    const pluginSrc = await (await fetch("./tqc_anyon.py")).text();
    py.FS.writeFile("/lib/python3.13/site-packages/tqc_anyon.py", pluginSrc);
    await py.runPythonAsync(`
import os, importlib, site
sp = site.getsitepackages()[0]
di = os.path.join(sp, "pennylane_tqc-0.1.0.dist-info"); os.makedirs(di, exist_ok=True)
open(os.path.join(di,"METADATA"),"w").write("Metadata-Version: 2.1\\nName: pennylane-tqc\\nVersion: 0.1.0\\n")
open(os.path.join(di,"entry_points.txt"),"w").write("[pennylane.plugins]\\ntqc.anyon = tqc_anyon:TQCAnyonDevice\\n")
importlib.invalidate_caches()
import pennylane as qml
qml.refresh_devices()
assert "tqc.anyon" in qml.plugin_devices, "tqc.anyon did not register"
# Actually LOAD + instantiate once so any module/import error fails the boot (not the first Run).
_smoke = qml.device("tqc.anyon", wires=1)
assert type(_smoke).__name__ == "TQCAnyonDevice", "tqc.anyon resolved to the wrong class"
`);

    this.onStage("ready");
    this.ready = true;
    return this;
  }

  // Execute verbatim PennyLane code, capturing stdout/stderr and an optional `result` value.
  async run(code) {
    if (!this.ready) await this.boot();
    const wrapped = [
      "import sys, io, json, traceback",
      "_o=io.StringIO(); _e=io.StringIO(); _r=None; _ok=True; _err=None",
      "_ns = globals().setdefault('__holo_q_ns', {})",
      "sys.stdout=_o; sys.stderr=_e",
      "try:",
      "    exec(compile(" + JSON.stringify(code) + ", '<holo-quantum>', 'exec'), _ns)",
      "    _r = _ns.get('result', None)",
      "except Exception:",
      "    _ok=False; _err=traceback.format_exc()",
      "finally:",
      "    sys.stdout=sys.__stdout__; sys.stderr=sys.__stderr__",
      "json.dumps({'ok':_ok,'stdout':_o.getvalue(),'stderr':_e.getvalue(),'result':(repr(_r) if _r is not None else None),'error':_err})",
    ].join("\n");
    const out = JSON.parse(await this.py.runPythonAsync(wrapped));
    await this._commitPending();   // mint blake3 κ + append every executed circuit to the strand
    return out;
  }

  // Drain the device's pending executions, mint the substrate κ with holo-blake3 over the exact
  // canonical bytes, and append each to the provenance strand.
  async _commitPending() {
    let pending;
    try {
      pending = JSON.parse(await this.py.runPythonAsync(
        "import json, tqc_anyon\njson.dumps(tqc_anyon.drain_pending())"
      ));
    } catch { return; }
    for (const ex of pending) {
      const kappa = kappaBlake3(enc.encode(ex.payload));   // the provable substrate κ
      this.lastKappa = kappa;
      await this.strand.append({
        kind: "circuit",
        payload: { kappa, ops: ex.ops, echo: !!ex.hit },
      });
    }
  }

  // Strand status for the inspector: length, head κ, last circuit κ, and a live verify().
  async strandStatus() {
    let v = { ok: false, length: 0 };
    try { v = await this.strand.verify(); } catch {}
    return { length: this.strand.length(), head: this.strand.head(), last: this.lastKappa, verified: !!v.ok };
  }

  // Toggle κ-collapse canonicalization (Opportunity #1): widen the cache equivalence class so
  // semantically-equal-but-structurally-different circuits collapse to one κ. Off by default.
  async setCanonicalize(on) {
    if (!this.ready) return false;
    const raw = await this.py.runPythonAsync(
      "import tqc_anyon\nstr(tqc_anyon.set_canonicalize(" + (on ? "True" : "False") + "))"
    );
    return raw === "True";
  }

  // Aggregate κ-cache stats + the ordered κ trace across every tqc.anyon device the
  // script created (read straight from the plugin registry — no dependence on var names).
  async stats() {
    if (!this.ready) return { hits: 0, misses: 0, devices: 0, trace: [] };
    try {
      const raw = await this.py.runPythonAsync(
        "import json, tqc_anyon\njson.dumps(tqc_anyon.aggregate_stats())"
      );
      return JSON.parse(raw);
    } catch { return { hits: 0, misses: 0, devices: 0, trace: [] }; }
  }
}
