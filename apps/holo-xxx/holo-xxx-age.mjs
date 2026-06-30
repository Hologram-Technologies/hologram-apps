// holo-xxx-age.mjs — zero-knowledge-style age proof for Holo XXX (AURA Phase D), on the sovereign-credentials spine.
//
// A one-time, DEVICE-BOUND age attestation: a self-sovereign principal signs a credential whose ONLY claim is
// {ageOver18:true}; the holder later reveals just that one claim by SELECTIVE DISCLOSURE. Verification is OFFLINE,
// by re-derivation (Law L5) — no server, no issuer contact, no birthdate, no identity. The proof is stored
// device-local and NEVER egressed; the only fact it ever asserts is "over 18". The SAME path accepts a real
// third-party age-verification issuer later (any issuer κ) — the storage + UX don't change, only who signs.

import { ephemeral } from "/_shared/holo-identity.mjs";
import { issueCredential, credentialCore, verifyCredential, verifyDisclosure } from "/_shared/holo-credential.mjs";

const AGE_KEY = "holo.xxx.age.proof";
const load = () => { try { return JSON.parse(localStorage.getItem(AGE_KEY) || "null"); } catch { return null; } };
const save = (o) => { try { localStorage.setItem(AGE_KEY, JSON.stringify(o)); } catch (_) {} };

export function clearAgeProof() { try { localStorage.removeItem(AGE_KEY); } catch (_) {} }

// Verify the stored proof OFFLINE: signature + κ commitment + not-expired (verifyCredential), then the disclosed
// claim re-derives into the signed _sd and equals ageOver18:true (verifyDisclosure). Anything off → false (fail-closed).
export async function hasValidAgeProof() {
  const p = load(); if (!p || !p.core || !p.ageDisclosure) return false;
  try {
    const body = await verifyCredential(p.core);
    if (!body) return false;
    const d = await verifyDisclosure(body, p.ageDisclosure);
    return !!(d && d.key === "ageOver18" && d.value === true);
  } catch { return false; }
}

// Mint the device-bound age attestation — call ONLY after the user affirms 18+ (and, on the host, passes the
// biometric step-up). The principal's private key is non-extractable + in-memory; the signed credential is
// self-verifying forever (pub + sig embedded), so we persist only the core + the single ageOver18 disclosure.
export async function issueAgeProof() {
  const principal = await ephemeral({ label: "age" });
  const cred = await issueCredential(principal, { subject: principal.kappa, claims: { ageOver18: true } });
  save({ core: credentialCore(cred), ageDisclosure: cred.disclosures.ageOver18, at: Date.now() });
  return true;
}
