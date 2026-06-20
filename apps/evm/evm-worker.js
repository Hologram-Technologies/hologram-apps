// evm-worker.js — the Holo EVM engine, off the main thread.
//
// Loads the vendored EthereumJS reference engine (the bytes the page already
// κ-verified, handed over as a Blob URL) and holds ONE persistent Ethereum
// Virtual Machine whose entire state lives in a CONTENT-ADDRESSED κ-store: a
// Merkle-Patricia trie whose every node is keyed by its keccak256 hash. The
// state root is a κ-label; contract code is addressed by codeHash = keccak(code).
//
// It executes REAL EVM bytecode and REAL signed transactions (deploy / call),
// emits a full opcode-level trace (pc · opcode · gas · stack), and re-derives
// live mainnet block hashes (RLP→keccak) to κ-verify them against the network.
// The main thread stays free for the UI; persistence is a JSON snapshot of the
// κ-store that resumes byte-for-byte.

let E = null;                 // the engine namespace
let common = null;            // mainnet @ cancun
let vm = null;                // the persistent VM
let kappaMap = null;          // the κ-store: Map<keccakHex, nodeBytes>
let devKey = null, devAddr = null;
const DEV_BAL = 10n ** 24n;   // 1,000,000 ETH dev faucet

const H = (u8) => "0x" + Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const B = (hex) => { const h = String(hex || "").replace(/^0x/, ""); const o = new Uint8Array(h.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const big = (v) => (typeof v === "bigint" ? v : BigInt(v || 0));
const KECCAK_NULL = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"; // keccak256("")
async function rpcCall(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
// stable (sorted-key) serialization → the κ of a witness is reproducible byte-for-byte
function stableStringify(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(x[k])).join(",") + "}";
}
const witnessKappa = (w) => H(E.keccak256(new TextEncoder().encode(stableStringify(w))));
// EF BlockchainTest helpers (full-block state-transition verifier)
const hfFor = (net) => { const k = Object.keys(E.Common.Hardfork).find((x) => E.Common.Hardfork[x] === String(net).toLowerCase()); return E.Common.Hardfork[k] || E.Common.Hardfork.cancun; };
const stripHex = (h) => { h = String(h).replace(/^0x/, "").replace(/^0+/, ""); return h.length ? B("0x" + (h.length % 2 ? "0" + h : h)) : new Uint8Array(); };

// ── κ-Fork shared machinery: discover touched state, fetch+verify proofs ─────────
function forkHandler(touched, ft) {
  const CAP = 16000;
  return (d, resolve) => {
    const a = (d.address && d.address.toString) ? d.address.toString() : "";
    if (a && !touched[a]) touched[a] = new Set();
    const n = d.stack.length, op = d.opcode.name;
    if ((op === "SLOAD" || op === "SSTORE") && n) { const slot = "0x" + d.stack[n - 1].toString(16).padStart(64, "0"); (touched[a] = touched[a] || new Set()).add(slot); }
    let tgt = null;
    if (n && (op === "BALANCE" || op === "EXTCODESIZE" || op === "EXTCODECOPY" || op === "EXTCODEHASH")) tgt = d.stack[n - 1];
    else if (n >= 2 && (op === "CALL" || op === "CALLCODE" || op === "DELEGATECALL" || op === "STATICCALL")) tgt = d.stack[n - 2];
    if (tgt != null) { const ta = "0x" + (tgt & ((1n << 160n) - 1n)).toString(16).padStart(40, "0"); if (!touched[ta]) touched[ta] = new Set(); }
    if (ft.length < CAP) { const top = []; for (let i = 0; i < Math.min(6, n); i++) top.push("0x" + d.stack[n - 1 - i].toString(16)); ft.push({ pc: d.pc, op, fee: d.opcode.fee, gasLeft: d.gasLeft.toString(), depth: d.depth, top }); }
    if (typeof resolve === "function") resolve();
  };
}
async function forkExecute(RPC, N, call) {
  const Nhex = "0x" + N.toString(16);
  const blk = await rpcCall(RPC, "eth_getBlockByNumber", [Nhex, false]);
  const headerObj = { ...blk }; delete headerObj.transactions; delete headerObj.withdrawals; delete headerObj.uncles;
  const hdr = E.Block.createBlockHeaderFromRPC(headerObj, { common, setHardfork: true });
  const blockHash = H(hdr.hash());
  const headerOk = blockHash.toLowerCase() === String(blk.hash).toLowerCase();
  const sm = new E.StateManager.RPCStateManager({ provider: RPC, blockTag: N });
  const fvm = await E.VM.createVM({ common, stateManager: sm });
  const touched = {}, ft = [];
  fvm.evm.events.on("step", forkHandler(touched, ft));
  const caller = call.from && /^0x[0-9a-fA-F]{40}$/.test(call.from) ? E.Util.createAddressFromString(call.from) : E.Util.createZeroAddress();
  const res = await fvm.evm.runCall({ to: E.Util.createAddressFromString(call.to), caller, data: B(call.data || "0x"), value: big(call.value || 0n), gasLimit: big(call.gas || 5_000_000n) });
  return { blk, headerObj, blockHash, headerOk, stateRoot: blk.stateRoot, touched, ft, ex: res.execResult, Nhex };
}
async function fetchWitnessData(RPC, Nhex, touched, stateRoot) {
  const proofs = [], codes = {}, proofMeta = []; let provenSlots = 0, allOk = true;
  for (const [addr, slotSet] of Object.entries(touched)) {
    const slots = [...slotSet];
    try {
      const proof = await rpcCall(RPC, "eth_getProof", [addr, slots, Nhex]);
      proofs.push(proof);
      const psm = await E.StateManager.fromMerkleStateProof(proof);
      const ok = H(await psm.getStateRoot()).toLowerCase() === String(stateRoot).toLowerCase();
      let codeOk = null;
      if (proof.codeHash && proof.codeHash.toLowerCase() !== KECCAK_NULL) { const c = await rpcCall(RPC, "eth_getCode", [addr, Nhex]); codes[addr.toLowerCase()] = c; codeOk = H(E.keccak256(B(c))).toLowerCase() === String(proof.codeHash).toLowerCase(); }
      proofMeta.push({ address: addr, slots: slots.length, ok, codeOk });
      provenSlots += slots.length; if (!ok || codeOk === false) allOk = false;
    } catch (err) { proofMeta.push({ address: addr, slots: slots.length, ok: null, error: String(err && err.message || err) }); allOk = false; }
  }
  return { proofs, codes, proofMeta, provenSlots, allOk };
}

// ── opcode trace + storage capture (attached once, gated by `tracing`) ───────────
let tracing = false, trace = [], capStorage = [], lastMem = "0x", lastStack = [];
const TRACE_CAP = 16000, MEM_CAP = 8192;
function onStep(d, resolve) {
  if (tracing) {
    const n = d.stack.length;
    const top = [];
    for (let i = 0; i < Math.min(6, n); i++) top.push("0x" + d.stack[n - 1 - i].toString(16));
    if (trace.length < TRACE_CAP) trace.push({ pc: d.pc, op: d.opcode.name, fee: d.opcode.fee, gasLeft: d.gasLeft.toString(), depth: d.depth, top });
    if (d.opcode.name === "SSTORE" && n >= 2) capStorage.push({ slot: "0x" + d.stack[n - 1].toString(16), value: "0x" + d.stack[n - 2].toString(16) });
    lastStack = top;
    if (d.memory && d.memory.length) { const m = d.memory.length > MEM_CAP ? d.memory.subarray(0, MEM_CAP) : d.memory; lastMem = H(m); }
  }
  if (typeof resolve === "function") resolve();
}
function beginTrace() { tracing = true; trace = []; capStorage = []; lastMem = "0x"; lastStack = []; }
function endTrace() { tracing = false; return { trace, storage: capStorage, memory: lastMem, stack: lastStack }; }

// ── build / rebuild the VM over a (possibly restored) κ-store ─────────────────────
async function buildVM(snapshot, root) {
  kappaMap = new Map(snapshot || []);
  const trie = await E.MPT.createMPT({ db: new E.Util.MapDB(kappaMap), useKeyHashing: true, ...(root ? { root: B(root) } : {}) });
  const sm = new E.StateManager.MerkleStateManager({ trie });
  vm = await E.VM.createVM({ common, stateManager: sm });
  vm.evm.events.on("step", onStep);
}
async function fundDev() {
  const acct = await vm.stateManager.getAccount(devAddr);
  if (!acct || acct.balance < DEV_BAL / 2n) await vm.stateManager.putAccount(devAddr, E.Util.createAccount({ balance: DEV_BAL, nonce: acct ? acct.nonce : 0n }));
}
const stateRoot = async () => H(await vm.stateManager.getStateRoot());
const snapshot = () => [...kappaMap.entries()];

// ── self-test (Law L5, in-engine): keccak KAT + a canonical opcode trace ─────────
async function selfTest() {
  const empty = H(E.keccak256(new Uint8Array()));
  const kat = empty === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
  const r = await vm.evm.runCode({ code: B("0x600760050160005260206000f3"), gasLimit: 0xffffffn }); // 7+5
  const add = H(r.returnValue) === "0x000000000000000000000000000000000000000000000000000000000000000c" && r.executionGasUsed === 24n;
  return { ok: kat && add, keccakEmpty: empty, addResult: H(r.returnValue), addGas: r.executionGasUsed.toString(), hardfork: common.hardfork() };
}

async function devInfo() {
  const a = await vm.stateManager.getAccount(devAddr);
  return { address: devAddr.toString(), balance: (a ? a.balance : 0n).toString(), nonce: Number(a ? a.nonce : 0n) };
}

// ── command dispatch ─────────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const m = e.data || {};
  const reply = (o) => self.postMessage({ id: m.id, ...o });
  try {
    if (m.cmd === "init") {
      const url = URL.createObjectURL(new Blob([m.src], { type: "text/javascript" }));
      E = await import(url);
      common = new E.Common.Common({ chain: E.Common.Mainnet, hardfork: E.Common.Hardfork.Cancun });
      devKey = B(m.devKey || H(E.keccak256(new TextEncoder().encode("holo-evm-dev-account-v1"))));
      devAddr = E.Util.createAddressFromPrivateKey(devKey);
      await buildVM(m.snapshot, m.root);
      await fundDev();
      const st = await selfTest();
      reply({ type: "ready", selftest: st, dev: await devInfo(), stateRoot: await stateRoot(), restored: !!(m.snapshot && m.snapshot.length), nodes: kappaMap.size, devKey: H(devKey) });
      return;
    }
    if (m.cmd === "run") {                 // stateless quick eval of raw bytecode
      beginTrace();
      const r = await vm.evm.runCode({ code: B(m.code), gasLimit: big(m.gas || 0xffffffn), data: B(m.calldata || "0x") });
      const tr = endTrace();
      reply({ type: "result", kind: "run", success: !r.exceptionError, error: r.exceptionError ? String(r.exceptionError.error || r.exceptionError) : null,
        returnValue: H(r.returnValue), gasUsed: r.executionGasUsed.toString(), ...tr });
      return;
    }
    if (m.cmd === "deploy") {              // real signed creation tx → persists code + state
      beginTrace();
      const acct = await vm.stateManager.getAccount(devAddr);
      const tx = E.Tx.createLegacyTx({ nonce: acct.nonce, gasLimit: big(m.gas || 8_000_000n), gasPrice: 10n, value: big(m.value || 0n), data: B(m.initcode) }, { common }).sign(devKey);
      const res = await E.VM.runTx(vm, { tx, skipBalance: false });
      const tr = endTrace();
      const ex = res.execResult;
      const addr = res.createdAddress;
      const code = addr ? H(await vm.stateManager.getCode(addr)) : "0x";
      const ca = addr ? await vm.stateManager.getAccount(addr) : null;
      reply({ type: "result", kind: "deploy", success: !ex.exceptionError, error: ex.exceptionError ? String(ex.exceptionError.error || ex.exceptionError) : null,
        address: addr ? addr.toString() : null, code, codeHash: ca ? H(ca.codeHash) : null,
        gasUsed: ex.executionGasUsed.toString(), txGas: res.totalGasSpent.toString(),
        logs: (ex.logs || []).map(serializeLog), stateRoot: await stateRoot(), dev: await devInfo(), ...tr });
      return;
    }
    if (m.cmd === "call") {                // real signed message call
      beginTrace();
      const acct = await vm.stateManager.getAccount(devAddr);
      const tx = E.Tx.createLegacyTx({ nonce: acct.nonce, to: m.to, gasLimit: big(m.gas || 8_000_000n), gasPrice: 10n, value: big(m.value || 0n), data: B(m.calldata || "0x") }, { common }).sign(devKey);
      const res = await E.VM.runTx(vm, { tx, skipBalance: false });
      const tr = endTrace();
      const ex = res.execResult;
      reply({ type: "result", kind: "call", success: !ex.exceptionError, error: ex.exceptionError ? String(ex.exceptionError.error || ex.exceptionError) : null,
        returnValue: H(ex.returnValue), gasUsed: ex.executionGasUsed.toString(), txGas: res.totalGasSpent.toString(),
        logs: (ex.logs || []).map(serializeLog), stateRoot: await stateRoot(), dev: await devInfo(), ...tr });
      return;
    }
    if (m.cmd === "account") {
      const a = await vm.stateManager.getAccount(E.Util.createAddressFromString(m.address));
      const code = H(await vm.stateManager.getCode(E.Util.createAddressFromString(m.address)));
      reply({ type: "account", address: m.address, exists: !!a, balance: (a ? a.balance : 0n).toString(), nonce: Number(a ? a.nonce : 0n), codeHash: a ? H(a.codeHash) : null, code });
      return;
    }
    if (m.cmd === "snapshot") { reply({ type: "snapshot", snapshot: snapshot(), root: await stateRoot(), nodes: kappaMap.size }); return; }
    if (m.cmd === "reset") {
      await buildVM([], null); await fundDev();
      reply({ type: "ready", selftest: await selfTest(), dev: await devInfo(), stateRoot: await stateRoot(), restored: false, nodes: kappaMap.size });
      return;
    }
    if (m.cmd === "fork") {                // TRUSTLESS mainnet fork: execute on PROVEN state
      const f = await forkExecute(m.rpc, BigInt(m.block), { to: m.to, data: m.data, from: m.from, value: m.value, gas: m.gas });
      const w = await fetchWitnessData(m.rpc, f.Nhex, f.touched, f.stateRoot);
      reply({ type: "fork", success: !f.ex.exceptionError, error: f.ex.exceptionError ? String(f.ex.exceptionError.error || f.ex.exceptionError) : null,
        returnValue: H(f.ex.returnValue), gasUsed: f.ex.executionGasUsed.toString(), kind: "fork",
        blockNumber: Number(m.block), blockHash: f.blockHash, headerOk: f.headerOk, stateRoot: f.stateRoot,
        proofs: w.proofMeta, provenAccounts: w.proofMeta.length, provenSlots: w.provenSlots, allProven: f.headerOk && w.allOk && w.proofMeta.length > 0,
        logs: (f.ex.logs || []).map(serializeLog), trace: f.ft, storage: [], memory: "0x", stack: [] });
      return;
    }
    if (m.cmd === "forkWitness") {         // fork + execute, then MINT a portable, self-verifying κ-witness
      const N = BigInt(m.block);
      const f = await forkExecute(m.rpc, N, { to: m.to, data: m.data, from: m.from, value: m.value, gas: m.gas });
      const w = await fetchWitnessData(m.rpc, f.Nhex, f.touched, f.stateRoot);
      const call = { to: m.to, data: m.data || "0x", from: (m.from && /^0x[0-9a-fA-F]{40}$/.test(m.from)) ? m.from : "0x0000000000000000000000000000000000000000", value: "0x" + big(m.value || 0n).toString(16) };
      const witness = { v: 1, network: "mainnet", block: Number(N), blockHash: f.blockHash, header: f.headerObj, call, result: H(f.ex.returnValue), proofs: w.proofs, codes: w.codes };
      const kappa = witnessKappa(witness);
      reply({ type: "forkWitness", success: !f.ex.exceptionError, error: f.ex.exceptionError ? String(f.ex.exceptionError.error || f.ex.exceptionError) : null,
        result: H(f.ex.returnValue), gasUsed: f.ex.executionGasUsed.toString(),
        blockNumber: Number(N), blockHash: f.blockHash, headerOk: f.headerOk, stateRoot: f.stateRoot,
        proofs: w.proofMeta, provenAccounts: w.proofMeta.length, provenSlots: w.provenSlots, allProven: f.headerOk && w.allOk && w.proofMeta.length > 0,
        witness, kappa, sizeBytes: new TextEncoder().encode(JSON.stringify(witness)).length, trace: f.ft });
      return;
    }
    if (m.cmd === "verifyWitness") {       // VERIFY a κ-witness fully OFFLINE — no network, no trust
      const w = m.witness;
      const realFetch = self.fetch; let usedNetwork = false;
      self.fetch = () => { usedNetwork = true; throw new Error("NETWORK DISABLED (offline witness verification)"); };
      const out = { type: "verifyWitness" };
      try {
        out.kappa = witnessKappa(w);
        out.kappaOk = !m.expectKappa || out.kappa.toLowerCase() === String(m.expectKappa).toLowerCase();
        const hdr = E.Block.createBlockHeaderFromRPC(w.header, { common, setHardfork: true });
        out.blockHash = H(hdr.hash());
        out.headerOk = out.blockHash.toLowerCase() === String(w.blockHash).toLowerCase();
        const stateRoot = w.header.stateRoot;
        out.stateRoot = stateRoot;
        const proofChecks = []; let allRoot = (w.proofs || []).length > 0;
        for (const p of (w.proofs || [])) {
          const vsm = await E.StateManager.fromMerkleStateProof(p);
          const rootOk = H(await vsm.getStateRoot()).toLowerCase() === String(stateRoot).toLowerCase();
          const c = w.codes ? w.codes[String(p.address).toLowerCase()] : null;
          let codeOk = null; if (c != null) codeOk = H(E.keccak256(B(c))).toLowerCase() === String(p.codeHash).toLowerCase();
          proofChecks.push({ address: p.address, rootOk, codeOk });
          if (!rootOk || codeOk === false) allRoot = false;
        }
        out.proofs = proofChecks; out.proofsOk = allRoot;
        // rebuild the partial state from ONLY the witness and re-execute the EVM
        let sm2 = await E.StateManager.fromMerkleStateProof(w.proofs[0]);
        for (let i = 1; i < w.proofs.length; i++) await E.StateManager.addMerkleStateProofData(sm2, w.proofs[i]);
        for (const [a, c] of Object.entries(w.codes || {})) await sm2.putCode(E.Util.createAddressFromString(a), B(c));
        const vm2 = await E.VM.createVM({ common, stateManager: sm2 });
        const caller = w.call.from && /^0x[0-9a-fA-F]{40}$/.test(w.call.from) ? E.Util.createAddressFromString(w.call.from) : E.Util.createZeroAddress();
        const r = await vm2.evm.runCall({ to: E.Util.createAddressFromString(w.call.to), caller, data: B(w.call.data || "0x"), value: big(w.call.value || 0n), gasLimit: 5_000_000n });
        out.result = H(r.execResult.returnValue);
        out.resultOk = out.result.toLowerCase() === String(w.result).toLowerCase();
        out.gasUsed = r.execResult.executionGasUsed.toString();
      } catch (err) { out.error = String(err && err.message || err); }
      self.fetch = realFetch;
      out.usedNetwork = usedNetwork;
      out.allOk = !!(out.headerOk && out.proofsOk && out.resultOk && out.kappaOk !== false && !usedNetwork);
      reply(out);
      return;
    }
    if (m.cmd === "verifyBlockTest") {     // FULL-BLOCK state-transition verifier (offline, EF consensus vector)
      const c = m.test;
      const common = new E.Common.Common({ chain: E.Common.Mainnet, hardfork: hfFor(c.network) });
      const map = new Map();
      const sm = new E.StateManager.MerkleStateManager({ trie: await E.MPT.createMPT({ db: new E.Util.MapDB(map), useKeyHashing: true }) });
      for (const [addr, a] of Object.entries(c.pre)) {                 // load the complete pre-state alloc
        const A = E.Util.createAddressFromString(addr);
        await sm.putAccount(A, E.Util.createAccount({ nonce: big(a.nonce), balance: big(a.balance) }));
        if (a.code && a.code !== "0x") await sm.putCode(A, B(a.code));
        for (const [sk, sv] of Object.entries(a.storage || {})) { const key = B("0x" + sk.replace(/^0x/, "").padStart(64, "0")); const val = stripHex(sv); if (val.length) await sm.putStorage(A, key, val); }
      }
      const genesisStateRoot = H(await sm.getStateRoot());
      const preOk = genesisStateRoot.toLowerCase() === String(c.genesisBlockHeader.stateRoot).toLowerCase();
      const vm = await E.VM.createVM({ common, stateManager: sm });
      const blocks = []; let allPost = preOk; let totalGas = 0n;
      for (const b of c.blocks) {                                      // re-execute each block → recompute post-state root
        try {
          const blk = E.Block.createBlockFromRLP(B(b.rlp), { common });
          const res = await E.VM.runBlock(vm, { block: blk, skipBlockValidation: true, skipHeaderValidation: true, generate: false });
          const post = H(await vm.stateManager.getStateRoot()), want = H(blk.header.stateRoot);
          const okp = post.toLowerCase() === want.toLowerCase(); if (!okp) allPost = false; totalGas += res.gasUsed;
          blocks.push({ number: Number(blk.header.number), txs: blk.transactions.length, gasUsed: res.gasUsed.toString(), postRoot: post, want, ok: okp });
        } catch (err) { blocks.push({ number: null, ok: false, error: String(err && err.message || err) }); allPost = false; }
      }
      let postStateOk = true, psChecked = 0;                          // independently check final account states
      for (const [addr, a] of Object.entries(c.postState || {})) {
        const acc = await sm.getAccount(E.Util.createAddressFromString(addr));
        if (!(acc && acc.balance === big(a.balance) && acc.nonce === big(a.nonce))) postStateOk = false; psChecked++;
      }
      reply({ type: "verifyBlockTest", network: c.network, preOk, genesisStateRoot, blocks, postStateOk, psChecked, totalGas: totalGas.toString(), nodes: map.size, allOk: preOk && allPost && (psChecked === 0 || postStateOk) });
      return;
    }
    if (m.cmd === "verifyBlock") {         // re-derive a REAL block hash (RLP→keccak) vs network
      try {
        const hdr = E.Block.createBlockHeaderFromRPC(m.block, { common, setHardfork: true });
        const got = H(hdr.hash());
        reply({ type: "verifyBlock", number: m.block.number, ok: got.toLowerCase() === String(m.block.hash).toLowerCase(), hash: got });
      } catch (err) { reply({ type: "verifyBlock", number: m.block.number, ok: null, error: String(err && err.message || err) }); }
      return;
    }
  } catch (err) {
    reply({ type: "error", error: String(err && err.message || err) });
  }
};

function serializeLog(l) { return { address: H(l[0]), topics: (l[1] || []).map(H), data: H(l[2] || new Uint8Array()) }; }
