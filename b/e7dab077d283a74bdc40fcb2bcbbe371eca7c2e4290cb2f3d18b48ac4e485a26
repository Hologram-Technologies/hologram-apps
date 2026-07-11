#!/usr/bin/env node
// holo-media-index-witness.mjs — Gate K0 (HOLO-TV-KAPPA-NATIVE-PROMPT.md).
// Proves: (1) resolve(indexκ) → rows of cards, EVERY card + art re-derived; (2) a single flipped
// byte anywhere → REFUSED, never served; (3) warm re-resolve is µs-tier with zero loads.
// Runs pure-Node against the on-disk b/ store — the same module the browser hub imports.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeMediaIndex } from "./holo-media-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BDIR = path.resolve(HERE, "../../b");
const pointer = JSON.parse(readFileSync(path.join(HERE, "media-index.json"), "utf8"));
const diskLoad = async (hex) => { const p = path.join(BDIR, hex.replace(/^sha256:/, "")); return existsSync(p) ? new Uint8Array(readFileSync(p)) : null; };

const R = { pass: 0, fail: 0 };
const check = (name, ok, note = "") => { R[ok ? "pass" : "fail"]++; console.log(`${ok ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`); };

// ── 1. resolve index → every card + art verified ─────────────────────────────────────────────
const MI = makeMediaIndex({ load: diskLoad, pointer });
await MI.open();
const rows = MI.rows();
check("index resolves by κ", rows.length >= 4, rows.map((r) => `${r.label}=${r.cards.length}`).join(" · "));
let cards = 0, arts = 0, missingArt = 0;
for (const row of rows) for (const hex of row.cards) {
  const c = await MI.card(hex);
  if (!c || !c.title || !c.kind) { check(`card ${hex.slice(0, 8)}`, false, "unverified/malformed"); continue; }
  cards++;
  if (c.art && c.art.kappa) { const a = await MI.artBytes(c); if (a) arts++; else check(`art of "${c.title}"`, false, "REFUSED/missing"); }
  else missingArt++;
}
check("all cards verify", cards === rows.reduce((n, r) => n + r.cards.length, 0), `${cards} cards`);
check("all present art verifies", arts + missingArt === cards, `${arts} art blobs · ${missingArt} artless`);

// ── 2. tamper → REFUSE (flip one byte in a card, then in an art blob) ────────────────────────
const anyCardHex = rows[0].cards[0];
const tamper = (hex) => async (h) => { const b = await diskLoad(h); if (b && h.replace(/^sha256:/, "") === hex.replace(/^sha256:/, "")) b[b.length >> 1] ^= 1; return b; };
{
  const T = makeMediaIndex({ load: tamper(anyCardHex), pointer });
  await T.open().catch(() => null);
  const c = await T.card(anyCardHex);
  check("tampered card REFUSED", c === null, anyCardHex.slice(0, 12) + "… (1 bit flipped)");
}
{
  const good = await MI.card(anyCardHex);
  const artHex = good.art && good.art.kappa;
  if (artHex) {
    const T = makeMediaIndex({ load: tamper(artHex), pointer });
    await T.open();
    const a = await T.artBytes(await T.card(anyCardHex));
    check("tampered art REFUSED", a === null, String(artHex).slice(0, 19) + "…");
  }
}
{
  const T = makeMediaIndex({ load: tamper(pointer.kappa), pointer });
  const ok = await T.open().then(() => true).catch(() => false);
  check("tampered INDEX refused at open()", !ok);
}

// ── 3. warm tier: µs re-resolve, zero loads ──────────────────────────────────────────────────
const all = rows.flatMap((r) => r.cards);
for (const h of all) await MI.card(h);                       // prime
const s0 = MI.stats();
const N = 20000;
const t0 = performance.now();
for (let i = 0; i < N; i++) await MI.card(all[i % all.length]);
const usPer = ((performance.now() - t0) * 1000) / N;
const s1 = MI.stats();
check("warm re-resolve is µs-tier", usPer < 50, usPer.toFixed(2) + " µs/resolve (N=" + N + ")");
check("warm tier does ZERO loads", s1.loads === s0.loads, `loads ${s0.loads} → ${s1.loads}`);

console.log(`\nK0 ${R.fail === 0 ? "GREEN" : "RED"} — ${R.pass}/${R.pass + R.fail} · index κ ${pointer.kappa.slice(0, 20)}… · ${cards} cards · warm ${usPer.toFixed(2)}µs`);
process.exit(R.fail === 0 ? 0 : 1);
