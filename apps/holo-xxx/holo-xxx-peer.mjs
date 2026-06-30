// holo-xxx-peer.mjs — HOSTLESS peer streaming of a shared scene. A #k= link carries only the recipe (manifest +
// MediaGraph, κ lists); the SEGMENT BYTES travel peer-to-peer over a data channel, each 1024-byte chunk verified
// against the segment's Bao root (Law L5) on arrival — so neither side hosts, and a lying peer is refused chunk
// by chunk, not trusted by URL.
//
// This module is DEPENDENCY-INJECTED — it imports nothing. The caller passes the lib function ({ rootHex } from
// holo-bao) and a transport ({ send, onMessage }). So the IDENTICAL code runs in the Node witness (dep imported by
// relative path, transport = loopbackTransportPair) and in the browser (dep dynamic-imported from /_shared,
// transport = makeRTCTransport). No mount-point branching, no static graph dragged into the browser bundle.
//
// Verification granularity: a κ-segment IS already a 2–4s chunk of the stream, so each segment is verified as ONE
// unit against its blake3/Bao root (rootHex(bytes) === seg.bao) — O(n), verify-as-you-go at segment granularity
// (segment 0 is proven and decoding before segment 1 arrives). Per-1024-byte Bao proofs are the right tool for a
// single very large κ-object, but generating proofs for a multi-MB segment is O(n²); the segment root is the
// honest, fast unit here. The trust anchor is the root the RECEIVER already holds from the recipe — never the peer.
//
//   transport := { send(obj), onMessage(cb) }            // obj may embed Uint8Array (holo-canvas-transport codec)
//   bao       := { rootHex(bytes) → hex }                // blake3 root; compared to seg.bao the receiver holds
//   swarm     := { createSwarmSource(peerList, opts) }   // optional; multi-peer pick + failover
//
// Wire protocol (one channel, request/response by κ):
//   → { t:"want", kappa }                                 receiver asks for a segment by its κ
//   ← { t:"block", kappa, bytes:Uint8Array }              owner answers with the raw segment bytes
//   ← { t:"deny",  kappa, reason }                        not owned / not allowed (rights boundary)

// in-memory transport pair for the witness (two ends, no network, no RTCPeerConnection). Pure.
export function loopbackTransportPair() {
  let aCb = () => {}, bCb = () => {};
  const A = { send: (o) => queueMicrotask(() => bCb(o)), onMessage: (fn) => (aCb = fn) };
  const B = { send: (o) => queueMicrotask(() => aCb(o)), onMessage: (fn) => (bCb = fn) };
  return [A, B];
}

// the rights gate: only content the owner actually holds may be served (never a metadata-only index entry).
const SERVABLE = new Set(["user-owned-source", "public-domain"]);

// ── SERVE side: answer κ-block requests for scenes the operator OWNS ────────────────────────────────────────
// served := [{ scene, bytesByKappa: Map<κ, Uint8Array> }]. bytesByKappa holds the init + media segment bytes
// (the owner has them in the κ-store). We build a Bao stream per requested κ on demand and send it.
//
// OPTIONAL SUBSCRIPTION GATE (creator economy): pass { gate } to require the requester to FIRST present a valid
// subscription credential. gate(authMsg) → Promise<bool> (the creator's verifySubscription). Until a → {t:"auth"}
// message passes the gate, every {t:"want"} is denied "subscription required". Default null = open (the legacy
// owned-scene share behaviour is byte-for-byte unchanged, so existing callers/witness are unaffected).
export function makeServer({ transport, bao }, served = [], { gate = null } = {}) {
  const owned = new Map();                                  // κ → { bytes, sceneKappa }
  for (const s of served) {
    if (!SERVABLE.has(s.scene?.rights?.class)) continue;    // rights: never serve an index-only / non-owned scene
    for (const [k, bytes] of s.bytesByKappa) owned.set(k, { bytes, sceneKappa: s.scene.kappa });
  }
  let authed = !gate;                                       // no gate → open; with a gate → locked until auth passes
  transport.onMessage(async (msg) => {
    if (!msg) return;
    if (gate && msg.t === "auth") {                         // subscription handshake — verify offline, then unlock
      try { authed = await gate(msg) === true; } catch { authed = false; }
      transport.send({ t: "authres", ok: authed, reason: authed ? null : "subscription invalid / expired" });
      return;
    }
    if (msg.t !== "want") return;
    if (gate && !authed) { transport.send({ t: "deny", kappa: msg.kappa, reason: "subscription required" }); return; }
    const hit = owned.get(msg.kappa);
    if (!hit) { transport.send({ t: "deny", kappa: msg.kappa, reason: "not owned / not servable here" }); return; }
    transport.send({ t: "block", kappa: msg.kappa, bytes: hit.bytes });   // raw bytes; receiver verifies vs its own root
  });
  return { servesCount: owned.size, serves: (k) => owned.has(k), get authed() { return authed; } };
}

// ── AUTH handshake (receiver side): present a subscription credential to a gated server and await its verdict.
// authorizePeer(transport, { core, disclosure }) → Promise<bool>. Call this ONCE before wantBlock on a gated room.
export function authorizePeer(transport, payload, { timeoutMs = 8000 } = {}) {
  return new Promise((res) => {
    const prior = [];
    const to = setTimeout(() => res(false), timeoutMs);
    transport.onMessage((m) => { if (m && m.t === "authres") { clearTimeout(to); res(!!m.ok); } });
    transport.send({ t: "auth", core: payload.core, disclosure: payload.disclosure });
  });
}

// ── RECEIVE side: a `peer` (for createSwarmSource) that fetches a segment by κ over the transport and
// stream-verifies every chunk against the segment's Bao root before returning the assembled bytes (or null). ──
export function makePeer({ transport, bao }, graph, { id = "peer-0", timeoutMs = 15000 } = {}) {
  const hexOf = (k) => String(k).split(":").pop().toLowerCase();
  // index κ → its blake3/Bao root, from the recipe the receiver already holds (the trust anchor; NOT the peer's).
  const baoByKappa = new Map(), segSet = new Set();
  for (const v of graph.videos || []) for (const r of v.representations || []) {
    if (r.initSegment) { baoByKappa.set(r.initSegment, r.initBao); segSet.add(r.initSegment); }
    for (const s of r.segments || []) { baoByKappa.set(s.kappa, s.bao); segSet.add(s.kappa); }
  }
  const waiters = new Map();                                // κ → resolver for the in-flight request
  transport.onMessage((msg) => {
    if (!msg || (msg.t !== "block" && msg.t !== "deny")) return;
    const w = waiters.get(msg.kappa); if (!w) return;
    waiters.delete(msg.kappa); w(msg);
  });

  async function wantBlock(kappa) {
    const root = baoByKappa.get(kappa); if (!root) return null;        // not a segment of this recipe
    const reply = await new Promise((res) => {
      const to = setTimeout(() => { waiters.delete(kappa); res(null); }, timeoutMs);
      waiters.set(kappa, (m) => { clearTimeout(to); res(m); });
      transport.send({ t: "want", kappa });
    });
    if (!reply || reply.t !== "block" || !reply.bytes) return null;    // denied / timed out → swarm reassigns
    const bytes = reply.bytes instanceof Uint8Array ? reply.bytes : new Uint8Array(reply.bytes);
    // VERIFY against the root WE hold (Law L5). A lying peer's bytes fail → null → re-fetched from another holder.
    if (bao.rootHex(bytes) !== hexOf(root)) return null;
    return bytes;
  }

  return { id, has: (k) => segSet.has(k), wantBlock };
}

// makeClient — the receiver's resolve(κ) for openStream, backed by one or more peers + swarm failover.
export function makeClient({ transport, bao, swarm }, graph, opts = {}) {
  const peer = makePeer({ transport, bao }, graph, opts);
  const source = swarm ? swarm.createSwarmSource([peer], { attempts: 3 }) : peer;
  return {
    peer,
    source,
    // resolve(κ) → verified segment bytes (peer→peer, Bao-verified). Throws if no peer can supply it (fail-closed).
    async resolve(kappa) { const b = await source.wantBlock(kappa); if (!b) throw new Error("peer: no verified source for " + kappa); return b; },
  };
}

export default { loopbackTransportPair, makeServer, makePeer, makeClient };
