// etherscan-worker.js — bulk Law-L5 re-derivation off the main thread.
//
// keccak256 is not free; verifying a whole page of blocks/transactions on the UI
// thread would jank the explorer. This module Worker imports the SAME holo-eth engine
// the page uses and re-derives block/tx hashes in batches, so "low latency, very
// responsive" holds even while every received object is κ-verified. Mirrors the
// worker-pool model of btc-worker.js.

import { verifyBlock, verifyTx } from "./_shared/holo-eth.js";

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.cmd === "verifyBlocks") {
      const results = m.blocks.map((b) => { const v = verifyBlock(b); return { hash: b.hash, number: b.number, ok: v.ok, derived: v.derived }; });
      self.postMessage({ cmd: "blocksVerified", id: m.id, results });
    } else if (m.cmd === "verifyTxs") {
      const results = m.txs.map((t) => { const v = verifyTx(t); return { hash: t.hash, ok: v.ok, derived: v.derived }; });
      self.postMessage({ cmd: "txsVerified", id: m.id, results });
    }
  } catch (err) {
    self.postMessage({ cmd: "error", id: m.id, error: String(err && err.message || err) });
  }
};
self.postMessage({ cmd: "ready" });
