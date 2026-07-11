// holo-onion-snowflake-rdv.mjs — Component B / B1c: browser Snowflake rendezvous.
// Reaches the Tor Snowflake broker (CORS-open), gets matched to a volunteer WebRTC proxy, and opens the
// RTCDataChannel that (via the proxy's relay) carries our framing to the Snowflake bridge. Browser-pure:
// RTCPeerConnection + fetch + crypto.getRandomValues — runs on github.io/Q, no Node, no install.
//
// Protocol (from snowflake v2.14.1, verified live): POST {broker}/client with body
//   "1.0\n" + JSON({ offer: JSON.stringify({type,sdp}), nat:"unknown", fingerprint:<bridge> })
// → response JSON { answer: JSON<{type,sdp}>, error? }. DataChannel is Ordered:true (reliable); KCP still
// rides on top for the turbotunnel session that survives proxy re-dials.

export const SNOWFLAKE_DEFAULTS = {
  broker: "https://1098762253.rsc.cdn77.org/",           // cdn77 rendezvous (reachable, ACAO:*)
  fingerprint: "2B280B23E1107BB62ABFC40DDCC8824814F80A72", // default Snowflake bridge
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.antisip.com:3478" },
    { urls: "stun:stun.voipgate.com:3478" },
    { urls: "stun:stun.nextcloud.com:443" },
  ],
};
const CLIENT_VERSION = "1.0";

const randHex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };

// wait until ICE gathering finishes (Snowflake sends a non-trickle offer with all candidates inline)
function gatherComplete(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((res) => {
    const done = () => { clearTimeout(t); res(); };
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") done(); });
    pc.addEventListener("icecandidate", (e) => { if (!e.candidate) done(); });
  });
}

// snowflakeRendezvous(opts?) → { pc, dc } with dc already OPEN (connected to a live volunteer proxy).
// Throws on: no proxy available, broker error, or DataChannel open timeout.
async function rendezvousOnce(opts = {}) {
  const cfg = { ...SNOWFLAKE_DEFAULTS, ...opts };
  const log = opts.log || (() => {});
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
  const dc = pc.createDataChannel("snowflake-" + randHex(8), { ordered: true });
  dc.binaryType = "arraybuffer";

  const opened = new Promise((res, rej) => {
    dc.addEventListener("open", () => res(dc));
    dc.addEventListener("error", (e) => rej(new Error("dc error: " + (e?.error?.message || e?.message || "unknown"))));
    pc.addEventListener("connectionstatechange", () => {
      log("pc:" + pc.connectionState);
      if (pc.connectionState === "failed") rej(new Error("PeerConnection failed (ICE/UDP blocked or proxy unreachable)"));
    });
  });

  await pc.setLocalDescription(await pc.createOffer());
  await gatherComplete(pc, opts.gatherTimeoutMs || 5000);
  log("offer gathered, polling broker…");

  const body = CLIENT_VERSION + "\n" + JSON.stringify({
    offer: JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }),
    nat: "unknown",
    fingerprint: cfg.fingerprint,
  });
  // IMPORTANT: text/plain keeps this a CORS-SIMPLE request → no preflight. The broker's
  // Access-Control-Allow-Headers is only "Origin, X-Session-ID" (no Content-Type), so an
  // application/json POST is blocked browser-side ("Failed to fetch"). The broker parses the
  // raw body regardless of content-type.
  let data;
  try {
    const ctl = new AbortController();
    const ft = setTimeout(() => ctl.abort(), opts.fetchTimeoutMs || 10000);
    const resp = await fetch(new URL("client", cfg.broker).href, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body, signal: ctl.signal,
    });
    clearTimeout(ft);
    if (!resp.ok) throw new Error("broker HTTP " + resp.status);
    data = await resp.json();
  } catch (e) {
    try { pc.close(); } catch {}
    throw new Error("broker unreachable: " + (e?.message || e));
  }
  if (data.error) { try { pc.close(); } catch {} throw new Error("broker: " + data.error); }
  if (!data.answer) { try { pc.close(); } catch {} throw new Error("no proxy available — retry"); }
  log("proxy matched, connecting DataChannel…");

  await pc.setRemoteDescription(JSON.parse(data.answer));
  try {
    const channel = await Promise.race([
      opened,
      new Promise((_, rej) => setTimeout(() => rej(new Error("DataChannel open timeout (proxy/bridge unreachable)")), opts.openTimeoutMs || 30000)),
    ]);
    log("DataChannel OPEN");
    return { pc, dc: channel };
  } catch (e) { try { pc.close(); } catch {} throw e; }
}

// snowflakeRendezvous: retry the whole rendezvous (fresh PeerConnection each time) — volunteers rotate and the
// broker/ICE is intermittent, so a single attempt is unreliable. Retries on any failure until a DataChannel opens.
export async function snowflakeRendezvous(opts = {}) {
  const log = opts.log || (() => {});
  const tries = opts.tries || 8;
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    log(`rendezvous attempt ${i}/${tries}`);
    try {
      return await rendezvousOnce(opts);
    } catch (e) {
      lastErr = e;
      log(`  attempt ${i} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, opts.retryDelayMs || 800));
    }
  }
  throw new Error(`rendezvous failed after ${tries} tries: ${lastErr?.message || lastErr}`);
}

export default { snowflakeRendezvous, rendezvousOnce, SNOWFLAKE_DEFAULTS };
