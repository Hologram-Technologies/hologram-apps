#!/usr/bin/env node
// kappa-resolve.sec.witness.mjs — CONFORMANCE witness: holospaces SEC-1 (integrity), SEC-6 (reference resolved
// against the κ, not the reference), SEC-3 (cost/dedup — identical content resolves once), and L3 (the store is
// the memory), proven against the unified κ-resolver (forge/kappa-resolve.mjs).
//
// WHY: the audit found SEC-2/3/4/5/6/8 "declared but not locally witnessed." The resolver is the substrate seam
// where these become real: every promotion from an untrusted tier is re-derived and REFUSED on mismatch (SEC-1/
// SEC-6/L5), concurrent/repeat gets collapse to one fetch (SEC-3), and a resident κ serves from RAM with no net
// (L3). The resolver is hash-agnostic — it compares verify(bytes) to the requested κ — so we inject SHA-256 and
// test the LOGIC, not a specific digest.
//
// GPU-free, deterministic, fail-closed, opfs:false (pure Node). GREEN = the laws hold. RED = a law regressed.
// Authority: holospaces docs/13-Product-Security §13.5 SEC-1/SEC-3/SEC-6 · Architecture-Constraints §L3/§L5.

import { makeKappaResolver } from "./kappa-resolve.mjs";
import { createHash } from "node:crypto";

const K = (u8) => "sha256:" + createHash("sha256").update(u8).digest("hex");
const bytes = (s) => new TextEncoder().encode(s);

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); fails++; } else console.log("  ✓ " + msg); };

console.log("kappa-resolve SEC-1/3/6 · L3 conformance — the substrate re-derives, refuses tamper, dedups, resides.\n");

const good = bytes("hello κ-world — content-addressed");
const k = K(good);

// ── SEC-1 / SEC-6 / L5: an untrusted source that returns bytes NOT matching the requested κ is REFUSED.
{
  let netCalls = 0;
  const tamperNet = async () => { netCalls++; return bytes("TAMPERED — different bytes than the κ names"); };
  const r = await makeKappaResolver({ net: tamperNet, verify: K, opfs: false });
  let refused = false;
  try { await r.get(k); } catch (e) { refused = /REFUSE/i.test(e.message); }
  ok(refused, "SEC-6/SEC-1: bytes that don't re-derive to the requested κ are REFUSED (not trusted)");
  ok(r.stats.refused === 1, "SEC-1: the refusal is counted — real, not silently swallowed");
  ok(netCalls === 1, "SEC-6: refusal happens AFTER fetch, on re-derivation of the reference against its κ");
}

// ── SEC-6 (accept) + SEC-3 (dedup) + L3 (residency): correct bytes resolve; concurrent gets fetch ONCE; a
//    resident κ then serves from the hot tier with ZERO further net.
{
  let netCalls = 0;
  const goodNet = async () => { netCalls++; return good; };
  const r = await makeKappaResolver({ net: goodNet, verify: K, opfs: false });

  const [a, b] = await Promise.all([r.get(k), r.get(k)]);   // concurrent — must collapse to one fetch
  ok(a instanceof Uint8Array && K(a) === k, "SEC-6: correct bytes resolve and re-derive to the κ");
  ok(a === b, "SEC-3: concurrent gets return the SAME resolved object (inflight dedup)");
  ok(r.stats.netFetch === 1, "SEC-3: concurrent gets DEDUP to ONE network fetch");

  const beforeNet = r.stats.netFetch;
  await r.get(k);                                            // now resident
  ok(r.stats.netFetch === beforeNet, "SEC-3/L3: a resident κ serves with ZERO further net fetch");
  ok(r.stats.hotHit >= 1, "L3: the store is the memory — the hot tier serves the resident object");
  ok(r.stats.verified >= 1, "SEC-1: every trusted promotion was re-derived (verify count > 0)");
}

// ── Anti-vacuity: prove the witness can FAIL — assert a false claim under --self-test and confirm it's caught.
if (process.argv.includes("--self-test")) {
  const before = fails;
  const r = await makeKappaResolver({ net: async () => good, verify: K, opfs: false });
  await r.get(k);
  ok(r.stats.netFetch === 999, "SELF-TEST (expected RED): a wrong net-fetch count must be caught");
  if (fails === before + 1) { console.log("\n  self-test OK — the witness detects a violation (not vacuous)."); process.exit(0); }
  console.error("\n  self-test FAILED — planted violation not caught."); process.exit(2);
}

console.log(fails === 0
  ? "\n✅ GREEN — SEC-1 integrity · SEC-6 resolve-against-κ · SEC-3 dedup · L3 residency hold on the substrate."
  : `\n❌ RED — ${fails} conformance assertion(s) failed; a binding law regressed.`);
process.exit(fails === 0 ? 0 : 1);
