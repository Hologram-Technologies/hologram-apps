// Witness for verify-before-trust on game saves — the security property the live front door enforces:
// a save whose κ-claim fails is refused on EVERY hand-off (resume, load-slot, roam, share/import),
// so a poisoned roam peer or share link cannot inject arbitrary emulator state. Tests the ACTUAL
// predicate the app imports.
// Run: node holo-save-trust.test.mjs
import { createHash } from "node:crypto";
import { saveVerifies, trustedStateOf } from "./holo-save-trust.mjs";

const hash = async (b) => createHash("sha256").update(Buffer.from(b.buffer, b.byteOffset, b.byteLength)).digest("hex");
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.error("  ✗", m)));

const state = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
const saveKappa = await hash(state);
const clean = { state, saveKappa };
const tampered = { state: Uint8Array.from(state, (v, i) => (i === 0 ? v ^ 0xff : v)), saveKappa }; // bytes changed, κ-claim unchanged
const legacy = { state };                       // pre-κ save: no claim
const stateless = { saveKappa };                // a claim with no bytes

// ── the predicate ──
ok((await saveVerifies(clean, hash)) === true, "a save whose bytes re-hash to its κ VERIFIES");
ok((await saveVerifies(tampered, hash)) === false, "a tampered save (κ-claim fails) is REFUSED");
ok((await saveVerifies(legacy, hash)) === true, "a legacy save (no κ-claim) loads as unverified (old data still works)");
ok((await saveVerifies(stateless, hash)) === false, "a record with no state to load is refused");

// ── the load sites (resume / load-slot) ──
ok((await trustedStateOf(clean, hash)) === clean.state, "resume/load returns the state for a verified save");
ok((await trustedStateOf(tampered, hash)) === false, "resume/load returns false (→ \"refused\") for a tampered save");
ok((await trustedStateOf(null, hash)) === null, "resume/load returns null when there is no save");

// ── roam: a poisoned save from another device is dropped before it ever reaches the store ──
const roamPoisoned = { type: "save", key: "k#auto", rec: tampered };
ok(!(await saveVerifies(roamPoisoned.rec, hash)), "a poisoned ROAM save is dropped (verify-before-trust)");
ok(await saveVerifies({ type: "save", rec: clean }.rec, hash), "a clean roam save is accepted");

// ── share/import: a tampered embedded playthrough is refused; the clean one imports ──
const shareTampered = { state: tampered.state, saveKappa };
ok(!(await saveVerifies(shareTampered, hash)), "a tampered SHARED playthrough is refused on import");
ok(await saveVerifies({ state, saveKappa }, hash), "a clean shared playthrough imports");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — verify-before-trust on saves (resume/slot/roam/share)  (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
