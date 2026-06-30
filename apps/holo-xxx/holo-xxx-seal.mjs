// holo-xxx-seal.mjs — the privacy spine, wired to the REAL OS seam (replaces the P0 PBKDF2 placeholder).
//
// The collection head is AES-GCM sealed under a key DERIVED FROM the operator's TEE secret — holospace-identity.
// sealState(stateBytes, operator, secret, deviceSalt). `secret` is the WebAuthn-PRF "It's me" assertion, never
// stored; so the collection opens ONLY under that operator's biometric, on this device. Opening a scene (and
// reveal/export) is a payload-bound step-up: the challenge IS the scene's κ (holo-stepup.buildStepUp), so the
// biometric the human approves is cryptographically tied to THAT exact scene — fail-closed if no TEE is present.
//
// This module imports the OS lib by relative path: it resolves for the Node witness and a repo-root server. In the
// native OS runtime it is loaded from /_shared and the same calls hold — no logic changes, only the mount point.
// It is deliberately NOT imported by index.html's main bundle (keeps the browser path free of the heavy TEE graph);
// the UI dynamic-imports it only when actually locking/unlocking in the OS.

import { sealState, openState, gateAction } from "../../../holo-os/system/os/usr/lib/holo/holospace-identity.mjs";
import { buildStepUp, challengeFor, needsStepUp, levelOf } from "../../../holo-os/system/os/usr/lib/holo/holo-stepup.mjs";

const te = new TextEncoder();

// SEAL the collection head at rest. `collection` is a holo-collection createCollection() (has serialize()).
// Returns iv‖ct — drops straight into the OS state store (same shape holospaces use).
export async function sealCollection(collection, { operator, secret, deviceSalt }) {
  if (!operator || !secret) throw new Error("holo-xxx-seal: sealCollection needs { operator, secret } (the TEE-derived key material)");
  const bytes = typeof collection.serialize === "function" ? collection.serialize() : te.encode(JSON.stringify(collection));
  return sealState(bytes, operator, secret, deviceSalt);
}

// OPEN the sealed head. openState returns null on wrong operator/secret or tamper (AES-GCM auth + L5) — we turn
// that into a thrown error so callers fail closed (cleartext is never produced from a bad unlock).
export async function openCollection(blob, { operator, secret, deviceSalt }) {
  const bytes = await openState(blob, operator, secret, deviceSalt);
  if (bytes == null) throw new Error("holo-xxx-seal: collection unlock failed (wrong operator/secret or tamper) — fail-closed");
  return JSON.parse(new TextDecoder().decode(bytes));
}

// STEP-UP bound to a scene: the challenge is sha256(canon(action)) over an action whose payload IS the scene κ.
// `signer` is an unlocked holo-login principal (sovereign axis). In the OS the WebAuthn assertion is attached as
// the second axis (attachWebAuthn) before verifyStepUp; here we produce the sovereign-signed token, which is what
// binds the ceremony to this scene. kind defaults to "everything.open" (authority-level → always steps up cold).
export async function stepUpForScene(sceneKappa, { operator, signer, appId = "holo-xxx", kind = "everything.open", reason = "Open scene", issuedAt, nonce }) {
  if (!sceneKappa) throw new Error("holo-xxx-seal: stepUpForScene needs the scene κ");
  const action = { "@type": "HoloStepUp", kind, appId, operator, reason, payload: sceneKappa,
                   issuedAt: issuedAt || "1970-01-01T00:00:00Z", nonce: nonce || "n0" };
  return buildStepUp(action, signer);
}

// the challenge a UI would display/commit for opening this scene — proves the binding without a signer.
export async function sceneChallenge(sceneKappa, { operator, appId = "holo-xxx", kind = "everything.open", reason = "Open scene", issuedAt = "1970-01-01T00:00:00Z", nonce = "n0" } = {}) {
  return challengeFor({ "@type": "HoloStepUp", kind, appId, operator, reason, payload: sceneKappa, issuedAt, nonce });
}

// OS-runtime helper: drive a REAL TEE step-up for opening a scene and return { token, secret }. The secret derives
// the seal key (gateAction → requireStepUp exposeSecret). Throws with no TEE present (fail-closed). Used by the UI
// in the native runtime; the witness exercises the pure pieces above instead (no hardware).
export async function gateOpenScene({ sceneKappa, operator, credentialId }) {
  return gateAction({ kind: "everything.open", holospaceKappa: sceneKappa, operator, reason: "Open scene" }, { credentialId });
}

export { needsStepUp, levelOf };
export default { sealCollection, openCollection, stepUpForScene, sceneChallenge, gateOpenScene, needsStepUp, levelOf };
