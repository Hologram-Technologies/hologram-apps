// holo-hyperliquid-exchange.mjs — the UOR-native write side of Holo Trade (ADR-0070).
//
// 100% native to the substrate, zero signing code: ALL msgpack + phantom-agent EIP-712 signing is
// the vendored, SEALED official SDK's (./vendor/hyperliquid-sdk.mjs). This layer adds only the
// three things Hologram owns — the pre-dispatch CONSCIENCE gate (an action is screened before the
// key ever signs it), the default-deny SIGNER seam (the key lives in the wallet / an agent key,
// never here), and a re-derivable PROV-O RECEIPT for every action (Law L5). The SDK is loaded only
// after its bytes re-derive to the sealed κ (hyperliquid-sdk.uor.json) — a tampered SDK is refused.

import * as SDK from "./vendor/hyperliquid-sdk.mjs";
import { screen } from "./holo-hl-conscience.mjs";
import { requestSignTypedData, requestAddress } from "./holo-wallet-bridge.js";

// walletBridgeSigner — an AbstractWallet whose signTypedData forwards to the running Holo Wallet
// (the SDK builds the typed data; the WALLET signs it; the master key NEVER enters this tab).
// Default-deny: if no wallet is open the bridge errors, so nothing is signed. This is the master path.
export function walletBridgeSigner(address, chain = "ethereum") {
  return { address, async signTypedData(params) { const { signature } = await requestSignTypedData(chain, params); return signature; } };
}
// connect: ask the running wallet for its address → a master signer bound to it (default-deny).
export async function connectWallet(chain = "ethereum") { const { address } = await requestAddress(chain); return walletBridgeSigner(address, chain); }

// the substrate's canonical content address (browser flavour of holo-uor.mjs — same jcs, same κ)
const jcs = (v) => Array.isArray(v) ? "[" + v.map(jcs).join(",") + "]"
  : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}"
  : JSON.stringify(v);
async function sha256hex(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
export const kappa = async (obj) => "did:holo:sha256:" + await sha256hex(jcs(obj));

// verify the vendored SDK re-derives to its sealed κ BEFORE trusting it (Law L5). Call once at boot.
export async function verifySdk(base = "./_shared/vendor/") {
  const [bytes, descriptor] = await Promise.all([
    fetch(base + "hyperliquid-sdk.mjs").then((r) => r.text()),
    fetch(base + "hyperliquid-sdk.uor.json").then((r) => r.json()),
  ]);
  const sha = await sha256hex(bytes);
  const ok = sha === descriptor["hostrade:sealedBody"].bundleSha256;
  return { ok, sha, expected: descriptor["hostrade:sealedBody"].bundleSha256, head: descriptor.head };
}

const RECEIPT_CTX = { schema: "https://schema.org/", prov: "http://www.w3.org/ns/prov#", hostrade: "https://hologram.os/ns/trade#", ucan: "https://github.com/ucan-wg/spec#" };
// mirror of holo-hl-conscience FUND_MOVING + holo-delegate cmdCovers (NIHITO — same attenuation model)
const FUND_MOVING = new Set(["withdraw3", "spotSend", "usdSend", "vaultTransfer", "sendAsset", "cWithdraw"]);
const cmdCovers = (parent, child) => parent === "/" || child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");

export class HoloHyperliquid {
  // wallet  — an AbstractWallet signer (the injected Holo Wallet provider, or SDK.agentWallet(key)).
  //           The key NEVER enters this layer; the wallet does the EIP-712 signTypedData.
  // limits  — conscience risk limits (see holo-hl-conscience.mjs). scope:"agent" forbids fund moves.
  // builder — optional Hyperliquid builder code { b: address, f: tenthsOfBp } (transparent fee share).
  constructor({ wallet, testnet = false, limits = {}, builder = null, onReceipt = null } = {}) {
    this.wallet = wallet; this.limits = limits; this.builder = builder; this.onReceipt = onReceipt;
    this.transport = new SDK.HttpTransport({ isTestnet: testnet });
    this.ex = wallet ? new SDK.ExchangeClient({ wallet, transport: this.transport }) : null;
    this.info = new SDK.InfoClient({ transport: this.transport });
    this.address = wallet?.address || null;
    this.grant = null; this.grantRevoked = false;     // an active approveAgent UCAN grant, if any
  }

  // every write goes through here: (grant check) → screen → (sign+dispatch via SDK) → seal a receipt
  async _do(type, action, exec) {
    if (this.grant) {                                  // the fast path is bounded by the agent grant (ADR-0042)
      if (this.grantRevoked) throw new Error("agent grant revoked");
      if (this.grant.exp && Math.floor(Date.now() / 1000) > this.grant.exp) throw new Error("agent grant expired");
      const cmd = (FUND_MOVING.has(type) ? "/funds/" : "/trade/") + type;   // attenuation by command
      if (!cmdCovers(this.grant.cmd, cmd)) throw new Error(`action ${type} is out of grant scope (${this.grant.cmd})`);
    }
    const v = screen(action, this.limits);
    if (!v.allow) { const e = new Error("conscience gate: " + v.reason); e.verdict = v.verdict; throw e; } // NO signature is produced
    const result = await exec();                                    // the SDK signs (in the wallet) + posts
    const receipt = await this._seal(type, action, v.verdict, result);
    this.onReceipt?.(receipt);
    return { result, receipt };
  }

  async _seal(type, action, verdict, result) {
    const body = {
      "@context": RECEIPT_CTX, "@type": ["prov:Activity", "hostrade:Trade", "schema:TradeAction"],
      "hostrade:venue": "hyperliquid", "hostrade:actionType": type,
      "hostrade:action": action, "hostrade:conscience": verdict,
      "prov:wasAssociatedWith": this.address, "prov:generated": result ?? null,
      "hostrade:builder": this.builder ?? null,
    };
    return { id: await kappa(body), ...body };
  }

  // ── orders ──────────────────────────────────────────────────────────────────────────────────
  // o = { coin?|a, isBuy|b, px|p, sz|s, reduceOnly?|r, tif?("Gtc"|"Ioc"|"Alo"), trigger?, cloid?|c }
  order(orders, grouping = "na") {
    const list = (Array.isArray(orders) ? orders : [orders]).map(normalizeOrder);
    const action = { type: "order", orders: list, grouping, ...(this.builder ? { builder: this.builder } : {}) };
    return this._do("order", action, () => this.ex.order({ orders: list, grouping, ...(this.builder ? { builder: this.builder } : {}) }));
  }
  marketOrder(o) { return this.order({ ...o, tif: o.tif || "Ioc" }); }
  cancel(cancels) { const list = (Array.isArray(cancels) ? cancels : [cancels]); const action = { type: "cancel", cancels: list }; return this._do("cancel", action, () => this.ex.cancel({ cancels: list })); }
  cancelByCloid(cancels) { const list = (Array.isArray(cancels) ? cancels : [cancels]); return this._do("cancelByCloid", { type: "cancelByCloid", cancels: list }, () => this.ex.cancelByCloid({ cancels: list })); }
  modify(oid, order) { const o = normalizeOrder(order); return this._do("modify", { type: "modify", oid, order: o }, () => this.ex.modify({ oid, order: o })); }
  scheduleCancel(time) { return this._do("scheduleCancel", { type: "scheduleCancel", time }, () => this.ex.scheduleCancel(time != null ? { time } : {})); }

  // ── account / margin ────────────────────────────────────────────────────────────────────────
  updateLeverage(asset, isCross, leverage) { const a = { type: "updateLeverage", asset, isCross, leverage }; return this._do("updateLeverage", a, () => this.ex.updateLeverage({ asset, isCross, leverage })); }
  updateIsolatedMargin(asset, isBuy, ntli) { return this._do("updateIsolatedMargin", { type: "updateIsolatedMargin", asset, isBuy, ntli }, () => this.ex.updateIsolatedMargin({ asset, isBuy, ntli })); }

  // ── delegation + monetization (master-key actions) ───────────────────────────────────────────
  approveAgent(agentAddress, agentName) { return this._do("approveAgent", { type: "approveAgent", agentAddress, agentName }, () => this.ex.approveAgent({ agentAddress, agentName })); }
  approveBuilderFee(builder, maxFeeRate) { return this._do("approveBuilderFee", { type: "approveBuilderFee", builder, maxFeeRate }, () => this.ex.approveBuilderFee({ builder, maxFeeRate })); }

  // ── approveAgent → a withdrawal-less agent wallet, wrapped as a revocable, attenuated grant (ADR-0042) ──
  // The MASTER (this.wallet — the real Holo Wallet) signs the on-chain approveAgent through the gate;
  // Hologram mints a content-addressed UCAN-shaped grant {iss=sub=master, aud=agent, cmd:"/trade", exp}
  // the fast path is bounded by (cmd attenuation + expiry + revocation). The full cryptographic UCAN
  // (re-derivation, chain proof, revocation-subtree) is the Holo Delegate object proven in the witness.
  async grantAgent({ ttlMs = 8 * 3600e3, agentName = "holo-trade" } = {}) {
    if (!this.ex) throw new Error("connect a master wallet first");
    const pk = "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const agent = SDK.agentWallet(pk);
    const { result } = await this._do("approveAgent", { type: "approveAgent", agentAddress: agent.address, agentName }, () => this.ex.approveAgent({ agentAddress: agent.address, agentName }));
    const exp = Math.floor((Date.now() + ttlMs) / 1000);
    const body = { "@context": RECEIPT_CTX, "@type": ["ucan:Delegation", "hostrade:AgentGrant", "prov:Entity"], iss: this.address, sub: this.address, aud: agent.address, cmd: "/trade", pol: [], exp, "hostrade:venue": "hyperliquid" };
    const grant = { id: await kappa(body), ...body };
    return { agent, agentKey: pk, grant, approval: result };
  }
  // bind a grant for the fast path: orders are signed by the agent key and bounded by the grant
  useGrant(grant, agentWallet) { this.wallet = agentWallet; this.ex = new SDK.ExchangeClient({ wallet: agentWallet, transport: this.transport }); this.address = agentWallet.address; this.limits = { ...this.limits, scope: "agent" }; this.grant = grant; this.grantRevoked = false; return this; }
  revokeGrant() { this.grantRevoked = true; return { revoked: this.grant?.id || null }; }

  // ── fund movement (refused for agent scope by the conscience gate) ────────────────────────────
  withdraw3(destination, amount) { return this._do("withdraw3", { type: "withdraw3", destination, amount }, () => this.ex.withdraw3({ destination, amount })); }
  usdSend(destination, amount) { return this._do("usdSend", { type: "usdSend", destination, amount }, () => this.ex.usdSend({ destination, amount })); }
  spotSend(destination, token, amount) { return this._do("spotSend", { type: "spotSend", destination, token, amount }, () => this.ex.spotSend({ destination, token, amount })); }

  // ── default-deny PREVIEW: screen + sign WITHOUT broadcasting (verify, don't trust) ────────────
  // Produces the exact signed payload Hyperliquid would receive — for the human to inspect/approve,
  // or for an agent to hand back a proven intent. Nothing is sent.
  async previewOrder(orders, grouping = "na", nonce = Date.now()) {
    const list = (Array.isArray(orders) ? orders : [orders]).map(normalizeOrder);
    const action = { type: "order", orders: list, grouping, ...(this.builder ? { builder: this.builder } : {}) };
    const v = screen(action, this.limits);
    if (!v.allow) { const e = new Error("conscience gate: " + v.reason); e.verdict = v.verdict; throw e; }
    const signature = await SDK.signing.signL1Action({ wallet: this.wallet, action, nonce, isTestnet: this.transport.isTestnet });
    const intent = { action, nonce, signature, signer: this.address };
    return { intent, verdict: v.verdict, receipt: await this._seal("order", action, v.verdict, { intent: true }) };
  }

  // a read passthrough (the existing read plane is HyperCore; the SDK's InfoClient also serves it)
  clearinghouseState(user) { return this.info.clearinghouseState({ user: user || this.address }); }
  openOrders(user) { return this.info.openOrders({ user: user || this.address }); }
}

// Holo-friendly order → Hyperliquid wire order (a/b/p/s/r/t). Accepts either shape.
function normalizeOrder(o) {
  if (o.a != null && o.b != null && o.p != null && o.s != null) return o;       // already wire-shaped
  const t = o.trigger
    ? { trigger: { isMarket: !!o.trigger.isMarket, triggerPx: String(o.trigger.triggerPx), tpsl: o.trigger.tpsl } }
    : { limit: { tif: o.tif || "Gtc" } };
  const wire = { a: o.a ?? o.asset, b: o.isBuy ?? o.b, p: String(o.px ?? o.p), s: String(o.sz ?? o.s), r: !!(o.reduceOnly ?? o.r), t };
  if (o.cloid ?? o.c) wire.c = o.cloid ?? o.c;
  return wire;
}

export { SDK };
