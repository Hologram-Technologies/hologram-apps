// holo-sovereign.witness.mjs — the broker's guarantees, proven headless (no DOM, no biometric).
// The properties that make "your logins on every site" SAFE: exact-origin reveal, fail-closed on guest,
// and capability isolation (a look-alike can't reuse a saved login; a page-declared origin can't spoof).
//   node holo-sovereign.witness.mjs
import { makeBroker, makeLocalStore, sameOrigin } from "./_shared/holo-sovereign.mjs";

let fails = 0;
const ok = (n, c) => { console.log((c ? "  ✓ " : "  ✗ ") + n); if (!c) fails++; };

// in-memory store (no localStorage in node)
function memStore() { const m = new Map(); return { kind: "local",
  async get(o){ const k = new URL(o).origin; return m.get(k) || null; },
  async put(o,c){ m.set(new URL(o).origin, { username:c.username, secret:c.secret, totp:c.totp||null }); },
  async list(){ return [...m.keys()].map(o=>({origin:o})); }, async has(){ return m.size>0; } }; }

const REAL = "https://securebank.example";
const FAKE = "https://securebank.example.evil.com";     // different host — a look-alike
const store = memStore();
let stepUps = 0;
const stepUp = async () => { stepUps++; return true; };

console.log("holo-sovereign broker witness");

// 0 · sameOrigin is exact (scheme+host), not a suffix/normalization match
ok("sameOrigin: exact match true", sameOrigin(REAL + "/login", REAL + "/account"));
ok("sameOrigin: look-alike false", !sameOrigin(REAL, FAKE));
ok("sameOrigin: scheme downgrade false", !sameOrigin("https://a.com", "http://a.com"));

// 1 · save a login at REAL, then fill REAL → the credential, behind a step-up
{
  const b = makeBroker({ store, operator: "op1", stepUp, hostOrigin: () => REAL });
  const s = await b.save(REAL, { username: "you@holo.id", secret: "hunter2" });
  ok("save at real origin ok", s.ok);
  const f = await b.fill(REAL);
  ok("fill at real origin returns the credential", f.ok && f.credential.secret === "hunter2");
  ok("fill went through the step-up gate", stepUps >= 1);
}

// 2 · THE MONEY SHOT: a look-alike origin fills NOTHING (SEC-5), even though the vault has the login
{
  const b = makeBroker({ store, operator: "op1", stepUp, hostOrigin: () => FAKE });
  const f = await b.fill(FAKE);
  ok("look-alike origin → refused, no credential", !f.ok && f.refused === "no-login-for-origin");
  ok("look-alike reveal exposes NO secret", !f.credential);
}

// 3 · a page that DECLARES a false origin (spoof) is refused — broker trusts hostOrigin, not the page
{
  const b = makeBroker({ store, operator: "op1", stepUp, hostOrigin: () => FAKE });   // really on FAKE
  const f = await b.fill(REAL);   // page CLAIMS to be REAL
  ok("page-declared origin ≠ host origin → refused (SEC-5 spoof-proof)", !f.ok && f.refused === "origin-mismatch");
}

// 4 · fail-closed: a guest (no operator) never reveals a secret
{
  const b = makeBroker({ store, operator: null, stepUp, hostOrigin: () => REAL });
  const f = await b.fill(REAL);
  ok("guest (no operator) → fill refused, fail-closed", !f.ok && f.refused === "no-identity");
  const p = await b.presentFor(REAL);
  ok("guest presence: seam knows a login exists but operator:false", p.present && p.hasLogin && !p.operator);
}

// 5 · SEC-2: presence (read) never returns the secret — only whether one exists
{
  const b = makeBroker({ store, operator: "op1", stepUp, hostOrigin: () => REAL });
  const p = await b.presentFor(REAL);
  ok("presentFor discloses existence, never the secret", p.hasLogin === true && p.secret === undefined && p.credential === undefined);
}

// ── WALLET (the second face): connect ≠ sign ≠ send, spoof-proof, key never exposed ──
{
  const b = makeBroker({ store, operator: "op1", stepUp, hostOrigin: () => "https://dapp.example" });
  const c = await b.walletConnect("https://dapp.example");
  ok("connect returns an ADDRESS (0x…40 hex), never a key", c.ok && /^0x[0-9a-f]{40}$/.test(c.address));
  ok("connect response contains no key/secret/seed", c.ok && !c.key && !c.secret && !c.privateKey && !c.seed);
  const s = await b.walletSign("https://dapp.example", "hello");
  ok("personal_sign returns a signature after the gate", s.ok && /^0x[0-9a-f]{64}$/.test(s.signature));
  const send = await b.walletSend("https://dapp.example", { to: "0xabc", value: "0x1" });
  ok("send returns a tx hash only through the (fresh) gate", send.ok && /^0x/.test(send.txHash));
}
// guest dApp: no operator → connect/sign/send all fail-closed
{
  const b = makeBroker({ store, operator: null, stepUp, hostOrigin: () => "https://dapp.example" });
  const c = await b.walletConnect("https://dapp.example");
  ok("guest dApp connect refused (fail-closed)", !c.ok && c.refused === "no-identity");
}
// spoof: a dApp declaring a different origin than the host is refused (SEC-5)
{
  const b = makeBroker({ store, operator: "op1", stepUp, hostOrigin: () => "https://dapp.example" });
  const c = await b.walletConnect("https://evil.example");
  ok("wallet: page-declared origin ≠ host → refused (spoof-proof)", !c.ok && c.refused === "origin-mismatch");
}
// SEND is attenuated from CONNECT: a broker whose gate DENIES send refuses it even after a connect
{
  let calls = 0; const denySend = async (a) => { calls++; return a.kind !== "wallet.send"; };  // approve all but send
  const b = makeBroker({ store, operator: "op1", stepUp: denySend, hostOrigin: () => "https://dapp.example" });
  await b.walletConnect("https://dapp.example");
  const s = await b.walletSign("https://dapp.example", "x");
  const send = await b.walletSend("https://dapp.example", { to: "0x0" });
  ok("SEC-2: sign allowed but SEND refused by its own gate (connect≠sign≠send)", s.ok && !send.ok && send.refused === "step-up-denied");
}

console.log(fails === 0 ? "\nALL GREEN — Pass reveals only at the exact origin; Wallet gives an address not a key, and connect≠sign≠send; all spoof-proof + fail-closed." : "\n" + fails + " FAILED");
process.exit(fails ? 1 : 0);
