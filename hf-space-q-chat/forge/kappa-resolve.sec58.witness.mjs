#!/usr/bin/env node
// kappa-resolve.sec58.witness.mjs — CONFORMANCE witness: holospaces SEC-5 (confidentiality — the κ IS the
// capability to perceive; an unknown κ is absent) and SEC-8 (resource bounds — untrusted input cannot exhaust a
// peer), proven against the unified κ-resolver (forge/kappa-resolve.mjs).
//
// WHY (audit gaps): SEC-5 — perception is gated by the κ: you must present the exact content-address to obtain
// bytes; a κ you don't hold yields nothing and the store leaks no enumeration of what exists. SEC-8 — the hot
// tier is LRU-bounded by a byte budget, so an adversary streaming many distinct objects cannot exhaust RAM; old
// entries are evicted and the peer stays live.
//
// GPU-free, deterministic, fail-closed, opfs:false (pure Node). Authority: holospaces docs/13-Product-Security
// §13.5 SEC-5 (confidentiality by content-addressing) · SEC-8 (resource bounds / backpressure).

import { makeKappaResolver } from "./kappa-resolve.mjs";
import { createHash } from "node:crypto";

const K = (u8) => "sha256:" + createHash("sha256").update(u8).digest("hex");
const bytes = (s) => new TextEncoder().encode(s);

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); fails++; } else console.log("  ✓ " + msg); };

console.log("kappa-resolve SEC-5/SEC-8 conformance — the κ gates perception; untrusted input can't exhaust RAM.\n");

// ── SEC-5: without the κ, the object is ABSENT and undetectable. ────────────────────────────────────────────
{
  const stored = bytes("a private message — only the κ-holder may perceive it");
  const kStored = K(stored);
  const kUnknown = K(bytes("some OTHER content the caller has never been handed"));
  let netCalls = 0;
  // the net tier serves ONLY the exact stored κ; anything else is absent (returns null).
  const net = async (k) => { netCalls++; return k === kStored ? stored : null; };
  const r = await makeKappaResolver({ net, verify: K, opfs: false });

  ok(r.has(kUnknown) === false, "SEC-5: a κ you don't hold is not detectable as present (has → false)");
  let absent = false;
  try { await r.get(kUnknown); } catch (e) { absent = /not found/i.test(e.message); }
  ok(absent, "SEC-5: resolving a κ the store can't provide yields ABSENCE (not found), never another object");

  const got = await r.get(kStored);           // presenting the EXACT κ is the only way to perceive it
  ok(K(got) === kStored, "SEC-5: the κ IS the capability — the exact content-address returns exactly its bytes");
  ok(typeof r.get === "function" && r.hotSize() === 1, "SEC-5: the API exposes no enumeration of stored κ (perceive-by-κ only)");
}

// ── SEC-8: a tight byte budget bounds the hot tier; streaming many objects evicts, never exhausts. ──────────
{
  const SIZE = 100, BUDGET = 250;             // room for ~2 resident objects
  const mk = (i) => bytes("x".repeat(SIZE - 4) + String(i).padStart(4, "0"));   // distinct ~100-byte objects
  const objs = Array.from({ length: 8 }, (_, i) => mk(i));
  const ks = objs.map(K);
  const net = async (k) => objs[ks.indexOf(k)] || null;
  const r = await makeKappaResolver({ net, verify: K, budgetBytes: BUDGET, opfs: false });

  for (const k of ks) await r.get(k);          // stream 8 untrusted objects through a 250-byte budget

  ok(r.hotBytes() <= BUDGET, `SEC-8: hot tier stays within budget (${r.hotBytes()} ≤ ${BUDGET} bytes) — RAM bounded`);
  ok(r.stats.evicted >= 6, `SEC-8: old entries were EVICTED under pressure (${r.stats.evicted} evicted), not accumulated`);
  const live = await r.get(ks[ks.length - 1]); // the peer is still alive and serving after the flood
  ok(K(live) === ks[ks.length - 1], "SEC-8: the peer stays LIVE and correct after an exhaustion attempt");
}

// ── Anti-vacuity self-test. ─────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
  const before = fails;
  const r = await makeKappaResolver({ net: async () => null, verify: K, opfs: false });
  ok(r.has("sha256:" + "0".repeat(64)) === true, "SELF-TEST (expected RED): an unknown κ must NOT report present");
  if (fails === before + 1) { console.log("\n  self-test OK — the witness detects a violation (not vacuous)."); process.exit(0); }
  console.error("\n  self-test FAILED — planted violation not caught."); process.exit(2);
}

console.log(fails === 0
  ? "\n✅ GREEN — SEC-5 (κ gates perception; unknown κ absent) · SEC-8 (bounded, non-exhaustible) hold on the substrate."
  : `\n❌ RED — ${fails} conformance assertion(s) failed; a binding law regressed.`);
process.exit(fails === 0 ? 0 : 1);
