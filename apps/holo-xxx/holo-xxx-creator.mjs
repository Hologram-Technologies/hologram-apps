// holo-xxx-creator.mjs — SOVEREIGN CREATOR ROOMS (the κ-creator economy). The answer to "integrate OnlyFans":
// OnlyFans is walled, so we build the sovereign alternative instead. A creator publishes their OWNED scenes as a
// signed room manifest (a κ-object); a fan opens it by #k= invite, subscribes (a payment proof → a time-bound
// subscription CREDENTIAL), and the creator's peer serves the room's bytes ONLY against a valid credential. No
// platform, no central server, no cut, censorship-resistant, pseudonymous on both sides.
//
// THE INVARIANT THAT MAKES THIS LEGITIMATE: the no-rebroadcast rule was always scoped to third-party TUBE bytes.
// Content a creator AUTHORED and OWNS is theirs to serve — it qualifies as USER_OWNED under the peer rights gate
// (holo-xxx-peer SERVABLE), so creator content is fully, legitimately peer-shareable. That is the whole unlock.
//
// ENTITLEMENT, NOT DRM: access is gated by a verifiable, time-bound credential the creator's peer checks offline
// before serving — not by pretending bits can be made un-copyable. Honest model on the sovereign-credentials spine.
//
// DEP-INJECTED: the caller passes the credential + identity primitives (so the IDENTICAL protocol runs in the Node
// witness and the browser). canon/addressOf from holo-identity; issue/verify from holo-credential.
//
//   deps := { canon, addressOf, kappaOfPub, verifySig, issueCredential, verifyCredential, verifyDisclosure }

export function makeCreator(deps) {
  const { canon, addressOf, kappaOfPub, verifySig, issueCredential, verifyCredential, verifyDisclosure } = deps;
  const te = new TextEncoder();
  const PERIOD_30D = 30 * 24 * 3600 * 1000;

  // ── ROOM MANIFEST ──────────────────────────────────────────────────────────────────────────────────────────
  // A room is a creator-signed κ-object. scenes carry only the byte-free reference (sceneκ + title + cover κ) — the
  // segment bytes resolve by κ peer-to-peer (holo-xxx-peer), never copied into the manifest. policy is public.
  // `principal` = the creator's self-sovereign principal (holo-identity.ephemeral or enrolled); it signs.
  async function sealRoom(principal, { handle, profile = {}, scenes = [], policy = {}, createdAt = null } = {}) {
    if (!principal || !principal.kappa || !principal.sign) throw new Error("sealRoom needs a signing creator principal");
    if (!handle) throw new Error("a room needs a handle");
    const body = {
      "@type": "HoloCreatorRoom", handle,
      profile: { name: profile.name || handle, bio: profile.bio || "", avatar: profile.avatar || null },
      issuer: principal.kappa,
      // a scene MUST be owned by the creator — we record the byte-free ref + the MediaGraph RECIPE (κ lists, no
      // bytes) so a fan can stream it peer-to-peer by κ. The rights gate is enforced at serve time. The κ commits to
      // the recipe, so a tampered graph fails verifyRoom (tamper-proof manifest).
      scenes: scenes.map((s) => {
        const sc = s && s.scene ? s.scene : s;
        return { kappa: sc.kappa, title: (sc.work && sc.work.title) || s.title || "", cover: (sc.work && sc.work.cover) || s.cover || null, graph: sc.graph || s.graph || null };
      }),
      policy: {
        priceLabel: policy.priceLabel || "",                       // human label e.g. "5 USDT / month"
        periodMs: policy.periodMs || PERIOD_30D,                   // subscription validity window
        tipAddress: policy.tipAddress || "",                       // creator wallet address for tips/subs
        chain: policy.chain || "",
      },
      createdAt: createdAt || new Date().toISOString(),
    };
    const c = canon(body);
    const kappa = await addressOf(te.encode(c));                   // content address commits to the whole manifest
    const sig = await principal.sign(c);
    return { kappa, ...body, alg: principal.alg, pub: principal.pub, sig };
  }

  // verify a room manifest OFFLINE (Law L5, fail-closed): κ re-derives, issuer κ == address of its pubkey, sig holds.
  async function verifyRoom(room) {
    try {
      if (!room || !room.kappa || !room.sig) return null;
      const { kappa, alg, pub, sig, ...body } = room;
      const c = canon(body);
      if (await addressOf(te.encode(c)) !== kappa) return null;    // tamper → κ mismatch
      if (await kappaOfPub(pub) !== body.issuer) return null;      // issuer κ must be the address of the signing key
      if (!(await verifySig(pub, alg, sig, te.encode(c)))) return null;
      return body;
    } catch { return null; }
  }

  // ── INVITE LINK ────────────────────────────────────────────────────────────────────────────────────────────
  // A tiny #k= link carrying the signed room manifest (NOT bytes). Mirrors holo-collection.shareScene. The opener
  // verifies the manifest by κ + creator sig before trusting it; scene bytes resolve by κ afterward.
  const b64 = (u8) => (typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8)));
  const unb64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  function inviteLink(room) { return "holo://xxx/room#r=" + b64(te.encode(JSON.stringify(room))); }
  async function openInvite(link) {
    const i = String(link).indexOf("#r=");
    const room = i >= 0 ? JSON.parse(new TextDecoder().decode(unb64(link.slice(i + 3)))) : link;
    const body = await verifyRoom(room);                           // L5 verify-before-trust
    if (!body) throw new Error("creator: room manifest failed to verify (tamper / bad signature)");
    return room;
  }

  // ── SUBSCRIPTION (payment proof → time-bound credential) ───────────────────────────────────────────────────
  // The creator issues a subscription credential bound to the FAN's κ, claiming { subscribedTo: roomκ }, valid for
  // the room's period. Payment happens through the wallet (host-gated); the proof is recorded but the CREDENTIAL is
  // what gates access. Selective-disclosure: the fan later reveals ONLY the subscribedTo claim to the creator's peer.
  async function issueSubscription(creatorPrincipal, { fanKappa, room, paymentProof = null } = {}) {
    if (!fanKappa || !room || !room.kappa) throw new Error("issueSubscription needs a fan κ + a room");
    if (creatorPrincipal.kappa !== room.issuer) throw new Error("only the room's creator can issue its subscriptions");
    const periodMs = (room.policy && room.policy.periodMs) || PERIOD_30D;
    return issueCredential(creatorPrincipal, {
      subject: fanKappa,
      claims: { subscribedTo: room.kappa, paid: !!paymentProof },
      ttlMs: periodMs,
    });
  }

  // Verify a fan's presented subscription OFFLINE: creator-signed + unexpired + the disclosed claim re-derives to
  // subscribedTo == this room. Returns true/false (fail-closed). issuerKappa pins it to THIS creator (anti-forgery).
  async function verifySubscription(core, subscribedToDisclosure, { roomKappa, issuerKappa, now = null } = {}) {
    try {
      const body = await verifyCredential(core, { now });          // sig + κ + not-expired
      if (!body) return false;
      if (issuerKappa && body.issuer !== issuerKappa) return false; // must be signed by THIS room's creator
      const d = await verifyDisclosure(body, subscribedToDisclosure);
      return !!(d && d.key === "subscribedTo" && d.value === roomKappa);
    } catch { return false; }
  }

  return { sealRoom, verifyRoom, inviteLink, openInvite, issueSubscription, verifySubscription, PERIOD_30D };
}

export default { makeCreator };
