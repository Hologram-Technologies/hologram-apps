// brc-worker.js — one mining core for the BRC Miner holospace, off the main thread.
//
// Loads the κ-pinned prism-argon2id engine and grinds the assigned nonce range
// of a single 148-byte BrowserCoin header through the prism `mineRange` sweep:
// Argon2id(header) per nonce, admit when digest(big-endian) < target. Yields
// between bounded slices so the UI stays live and Stop is instant. Posts
// `hashrate` ~1×/s and `solved` the moment a nonce admits. The main thread runs
// N of these (one per core), each splitting the 2^32 nonce space, and feeds the
// winning nonce back into BrowserCoin's real consensus — so a solve here is a
// genuine, network-valid BRC block.
//
// Each Argon2id hash is ~40-125 ms and touches 32 MB, so the bottleneck is RAM
// bandwidth, not core count — adding workers scales sub-linearly by design
// (that is BrowserCoin's ASIC/GPU resistance). One 65 MB engine arena per
// worker, allocated once at load and reused (no per-nonce allocation).

import { loadEngine, powHash, hashMeetsTarget, NONCE_OFFSET } from './_shared/prism-argon2id/prism-argon2id.js';

let running = false;
let gen = 0; // bumped per `mine`/`stop` so a stale slice loop exits

const SLICE = 8; // nonces per bounded slice before we yield + report

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.cmd === 'stop') { running = false; gen++; return; }
  if (m.cmd === 'verify') {
    // Parallel chain-sync PoW verification: a batch of headers → meets verdicts,
    // computed on the SAME κ-pinned engine that mines. Used to verify every
    // historical mainnet block's Argon2id PoW locally (the helper is not trusted).
    if (!self.__brcReady) {
      try { await loadEngine(); self.__brcReady = true; }
      catch (err) { self.postMessage({ type: 'verified', wid: m.wid, batch: m.batch, results: [], error: String(err) }); return; }
    }
    const results = [];
    for (const j of m.jobs) {
      const hb = j.headerBytes instanceof Uint8Array ? j.headerBytes : new Uint8Array(j.headerBytes);
      const digest = await powHash(hb);
      results.push({ id: j.id, meets: hashMeetsTarget(digest, BigInt('0x' + j.targetHex)) });
    }
    self.postMessage({ type: 'verified', wid: m.wid, batch: m.batch, results });
    return;
  }
  if (m.cmd === 'mine') {
    if (!self.__brcReady) {
      try { await loadEngine(); self.__brcReady = true; self.postMessage({ type: 'ready', wid: m.wid }); }
      catch (err) { self.postMessage({ type: 'oom', wid: m.wid, error: String(err) }); return; }
    }
    running = true;
    const myGen = ++gen;
    grind(m, myGen).catch((err) => self.postMessage({ type: 'error', wid: m.wid, error: String(err) }));
  }
};

async function grind(m, myGen) {
  const cgen = m.gen >>> 0; // template generation — echoed back so the main thread can drop stale solves
  const headerBytes = m.headerBytes instanceof Uint8Array ? m.headerBytes : new Uint8Array(m.headerBytes);
  const header = new Uint8Array(headerBytes); // own copy; we mutate the nonce
  const target = BigInt('0x' + m.targetHex);
  const startNonce = (m.startNonce >>> 0);

  const throttle = Math.max(0.05, Math.min(1, m.throttle == null ? 1 : m.throttle)); // CPU power 0.05..1
  let nonce = startNonce;
  let hashes = 0;
  let report = performance.now();
  const argon2id = await loadEngine();

  while (running && myGen === gen) {
    const sliceStart = performance.now();
    for (let i = 0; i < SLICE; i++) {
      header[NONCE_OFFSET] = (nonce >>> 24) & 0xff;
      header[NONCE_OFFSET + 1] = (nonce >>> 16) & 0xff;
      header[NONCE_OFFSET + 2] = (nonce >>> 8) & 0xff;
      header[NONCE_OFFSET + 3] = nonce & 0xff;
      let digest;
      try { digest = argon2id({ password: header, salt: SALT(), parallelism: 1, passes: 1, memorySize: 32 * 1024, tagLength: 32 }); }
      catch { self.postMessage({ type: 'oom', wid: m.wid, gen: cgen }); await sleep(400); break; }
      hashes++;
      if (hashMeetsTarget(digest, target)) {
        self.postMessage({ type: 'solved', wid: m.wid, gen: cgen, nonce: nonce >>> 0, hashHex: toHex(digest) });
        // keep grinding until the main thread sends stop (it will, to re-template)
      }
      nonce = (nonce + 1) >>> 0;
      if (nonce === startNonce) { self.postMessage({ type: 'exhausted', wid: m.wid, gen: cgen }); return; }
    }
    const now = performance.now();
    if (now - report >= 1000) {
      self.postMessage({ type: 'hashrate', wid: m.wid, gen: cgen, hps: (hashes * 1000) / (now - report), delta: hashes });
      hashes = 0; report = now;
    }
    // CPU-power duty cycle: sleep proportionally so the user can give CPU back.
    if (throttle < 1) { const work = performance.now() - sliceStart; await sleep(Math.min(250, work * (1 - throttle) / throttle)); }
    else await sleep(0); // yield so `stop` messages are received between slices
  }
}

// Salt is fixed by consensus; kept as a fn so the engine module stays the single
// source of POW params. powHash (imported) carries the same salt — used by the
// in-page self-test path; the hot loop calls argon2id directly for speed.
const _salt = new TextEncoder().encode('browsercoin-pow-v5');
function SALT() { return _salt; }
void powHash;

const HEXC = '0123456789abcdef';
function toHex(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += HEXC[u8[i] >>> 4] + HEXC[u8[i] & 15]; return s; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
