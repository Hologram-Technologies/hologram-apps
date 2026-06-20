// btc-worker.js — one mining core for BTC Miner, off the main thread.
//
// Loads the vendored prism-btc wasm engine and mines ONE block on demand:
// it drives the kernel's bounded `mine_range` sweep over the nonce space
// slice-by-slice, yields between slices (so the UI stays live and Stop is
// instant), rolls the merkle root when a nonce space exhausts, and posts
// `found` with the winning nonce + the block's `sha256d` κ-label the
// moment a candidate admits. The main thread runs N of these in parallel
// (one per "core") and chains the blocks by κ-address. Each invocation is
// a genuine proof-of-work search; the κ-label it returns IS the real
// Bitcoin block hash of the header it mined.

import init, { JsBlockHeader, mine_range } from "./_shared/prism-btc/prism_btc_wasm.js";

let inited = false;
let running = false;
let gen = 0; // bumped on each new `mine` so a stale loop exits

const hexToBytes = (hex) => {
  const h = String(hex).replace(/^0x/, "");
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};
const bytesToHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const yieldTick = () => new Promise((res) => setTimeout(res, 0));

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.cmd === "stop") { running = false; return; }
  if (m.cmd === "mine") {
    if (!inited) { await init(); inited = true; self.postMessage({ type: "ready", wid: m.wid }); }
    running = true;
    const myGen = ++gen;
    mineBlock(m, myGen).catch((err) => self.postMessage({ type: "error", wid: m.wid, error: String(err) }));
  }
};

async function mineBlock(m, myGen) {
  const SLICE = (m.slice >>> 0) || 60000;
  const nbits = m.nbits >>> 0;
  const header = { ...m.header };          // {version, prevHash, merkleRoot, timestamp, bits}
  const prev = hexToBytes(header.prevHash);
  let merkle = hexToBytes(header.merkleRoot);

  let jsh = new JsBlockHeader(header.version >>> 0, prev, merkle, header.timestamp >>> 0, header.bits >>> 0);
  let nonce = 0, total = 0;
  const t0 = performance.now();
  let last = t0;

  while (running && myGen === gen) {
    const r = mine_range(jsh, nbits, nonce, SLICE);
    total += r.attempts;

    if (r.found) {
      const elapsed = (performance.now() - t0) / 1000;
      self.postMessage({
        type: "found", wid: m.wid, height: m.height,
        nonce: r.nonce >>> 0, hashHex: r.hash_hex(),
        attempts: total, zeroBits: r.best_zero_bits >>> 0,
        stratum: r.stratum >>> 0, spectrum: r.spectrum >>> 0,
        elapsed, hps: total / Math.max(elapsed, 1e-6),
        header: { ...header },
      });
      r.free(); jsh.free();
      return;
    }

    nonce = (nonce + r.attempts) >>> 0;
    r.free();

    // Nonce space exhausted (rare at these targets): roll the merkle root.
    if (nonce === 0 || nonce > (0xffffffff - SLICE)) {
      merkle = crypto.getRandomValues(new Uint8Array(32));
      header.merkleRoot = bytesToHex(merkle);
      jsh.free();
      jsh = new JsBlockHeader(header.version >>> 0, prev, merkle, header.timestamp >>> 0, header.bits >>> 0);
      nonce = 0;
    }

    const now = performance.now();
    if (now - last > 140) {
      self.postMessage({ type: "progress", wid: m.wid, attempts: total, hps: total / Math.max((now - t0) / 1000, 1e-6) });
      last = now;
    }
    await yieldTick();
  }
  jsh.free();
}
