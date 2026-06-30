// holo-xxx-creator-witness.mjs — proves the sovereign-creator-room protocol end to end, in Node, no browser.
// Run: node holo-xxx-creator-witness.mjs   →  prints PASS/FAIL per claim + a final tally.
import { canon, addressOf, ephemeral } from "../../../holo-os/system/os/usr/lib/holo/holo-identity.mjs";
import { issueCredential, verifyCredential, verifyDisclosure, credentialCore, kappaOfPub, verifySig } from "../../../holo-os/system/os/usr/lib/holo/holo-credential.mjs";
import { rootHex } from "../../../holo-os/system/os/usr/lib/holo/holo-bao.mjs";
import { makeCreator } from "./holo-xxx-creator.mjs";
import { loopbackTransportPair, makeServer, makePeer, authorizePeer } from "./holo-xxx-peer.mjs";

const C = makeCreator({ canon, addressOf, kappaOfPub, verifySig, issueCredential, verifyCredential, verifyDisclosure });
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "  PASS " : "  FAIL ") + n); c ? pass++ : fail++; };

// a tiny owned scene + its single segment bytes, with a matching Bao root (the peer's trust anchor).
function ownedSceneFixture(kappa = "did:holo:sha256:scene-fixture") {
  const bytes = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 255);
  const root = rootHex(bytes);
  const segKappa = "did:holo:blake3:" + root;
  const scene = { kappa, work: { title: "Demo Owned Scene", cover: null }, video: segKappa, rights: { class: "user-owned-source" } };
  const graph = { videos: [{ representations: [{ segments: [{ kappa: segKappa, bao: "did:holo:blake3:" + root }] }] }] };
  const served = [{ scene, bytesByKappa: new Map([[segKappa, bytes]]) }];
  return { scene, graph, served, segKappa, bytes };
}

(async () => {
  const creator = await ephemeral({ label: "Creator" });
  const fan = await ephemeral({ label: "Fan" });
  const stranger = await ephemeral({ label: "Stranger" });
  const { scene } = ownedSceneFixture();

  // 1 — room manifest signs + verifies
  const room = await C.sealRoom(creator, { handle: "aurora", profile: { name: "Aurora", bio: "cinematic" }, scenes: [{ scene }], policy: { priceLabel: "5 USDT / mo", periodMs: 60000, tipAddress: "0xabc", chain: "base-sepolia" } });
  ok("room manifest verifies (creator-signed, κ commits)", !!(await C.verifyRoom(room)));
  ok("room binds issuer == creator κ", room.issuer === creator.kappa);
  ok("room carries byte-free scene refs only (no bytes)", Array.isArray(room.scenes) && room.scenes.length === 1 && !!room.scenes[0].kappa && !("bytes" in room.scenes[0]));

  // 2 — tamper refusal
  const tampered = { ...room, handle: "not-aurora" };
  ok("tampered room → verifyRoom null (κ mismatch)", (await C.verifyRoom(tampered)) === null);
  const forged = { ...room, sig: room.sig.slice(0, -2) + (room.sig.endsWith("AA") ? "BB" : "AA") };
  ok("forged signature → verifyRoom null", (await C.verifyRoom(forged)) === null);

  // 3 — invite link round-trips + tamper-throws
  const link = C.inviteLink(room);
  let opened = null; try { opened = await C.openInvite(link); } catch (_) {}
  ok("invite #r= link opens + verifies on a fresh side", !!opened && opened.kappa === room.kappa);
  const ci = link.indexOf("#r=") + 3, mid = ci + Math.floor((link.length - ci) / 2);   // flip one char inside the encoded manifest
  const badLink = link.slice(0, mid) + (link[mid] === "A" ? "B" : "A") + link.slice(mid + 1);
  let threw = false; try { await C.openInvite(badLink); } catch { threw = true; }
  ok("tampered invite link → openInvite throws (fail-closed)", threw);

  // 4 — subscription issues + verifies (valid, unexpired, right room, right issuer)
  const sub = await C.issueSubscription(creator, { fanKappa: fan.kappa, room, paymentProof: { tx: "0xtest" } });
  const present = { core: credentialCore(sub), disclosure: sub.disclosures.subscribedTo };
  ok("valid subscription verifies", await C.verifySubscription(present.core, present.disclosure, { roomKappa: room.kappa, issuerKappa: room.issuer }));

  // 5 — expired subscription → false
  const shortSub = await C.issueSubscription(creator, { fanKappa: fan.kappa, room: { ...room, policy: { ...room.policy, periodMs: 1 } } });
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  ok("expired subscription → false (time-bound, fail-closed)", !(await C.verifySubscription(credentialCore(shortSub), shortSub.disclosures.subscribedTo, { roomKappa: room.kappa, issuerKappa: room.issuer, now: future })));

  // 6 — wrong-room credential → false
  const room2 = await C.sealRoom(creator, { handle: "other", scenes: [{ scene }] });
  ok("subscription for room A does NOT unlock room B", !(await C.verifySubscription(present.core, present.disclosure, { roomKappa: room2.kappa, issuerKappa: room2.issuer })));

  // 7 — wrong-issuer (forged by a stranger) → false
  const fakeSub = await issueCredential(stranger, { subject: fan.kappa, claims: { subscribedTo: room.kappa, paid: true }, ttlMs: 60000 });
  ok("subscription signed by a stranger → false (issuer pinned)", !(await C.verifySubscription(credentialCore(fakeSub), fakeSub.disclosures.subscribedTo, { roomKappa: room.kappa, issuerKappa: room.issuer })));

  // 8/9/10 — GATED PEER DELIVERY (the whole point): bytes served ONLY against a valid subscription
  const gateFn = (authMsg) => C.verifySubscription(authMsg.core, authMsg.disclosure, { roomKappa: room.kappa, issuerKappa: room.issuer });

  // 8 — no auth → want denied
  {
    const fx = ownedSceneFixture();
    const [A, B] = loopbackTransportPair();
    makeServer({ transport: A, bao: { rootHex } }, fx.served, { gate: gateFn });
    const peer = makePeer({ transport: B, bao: { rootHex } }, fx.graph);
    const bytes = await peer.wantBlock(fx.segKappa);
    ok("gated server REFUSES bytes with no subscription", bytes === null);
  }
  // 9 — valid auth → bytes delivered + L5-verified
  {
    const fx = ownedSceneFixture();
    const [A, B] = loopbackTransportPair();
    makeServer({ transport: A, bao: { rootHex } }, fx.served, { gate: gateFn });
    const authedOk = await authorizePeer(B, present);                 // present the valid subscription FIRST
    const peer = makePeer({ transport: B, bao: { rootHex } }, fx.graph);   // then wire the byte channel
    const bytes = authedOk ? await peer.wantBlock(fx.segKappa) : null;
    ok("valid subscription unlocks delivery (authres ok)", authedOk === true);
    ok("delivered bytes match (L5 Bao-verified)", !!bytes && bytes.length === fx.bytes.length && bytes[0] === fx.bytes[0]);
  }
  // 10 — expired auth → server stays locked
  {
    const fx = ownedSceneFixture();
    const [A, B] = loopbackTransportPair();
    makeServer({ transport: A, bao: { rootHex } }, fx.served, { gate: (m) => C.verifySubscription(m.core, m.disclosure, { roomKappa: room.kappa, issuerKappa: room.issuer, now: future }) });
    const authedOk = await authorizePeer(B, { core: credentialCore(shortSub), disclosure: shortSub.disclosures.subscribedTo });
    ok("expired subscription → authres NOT ok (delivery stays locked)", authedOk === false);
  }
  // 12 — only-owned scenes are servable (a non-owned scene is never served, even post-auth)
  {
    const bytes = new Uint8Array(32).map((_, i) => i);
    const root = rootHex(bytes); const segKappa = "did:holo:blake3:" + root;
    const indexScene = { kappa: "did:holo:sha256:index", work: { title: "Index only" }, rights: { class: "metadata-only" } };
    const [A, B] = loopbackTransportPair();
    const srv = makeServer({ transport: A, bao: { rootHex } }, [{ scene: indexScene, bytesByKappa: new Map([[segKappa, bytes]]) }], { gate: () => true });
    const peer = makePeer({ transport: B, bao: { rootHex } }, { videos: [{ representations: [{ segments: [{ kappa: segKappa, bao: "did:holo:blake3:" + root }] }] }] });
    await authorizePeer(B, present);
    const got = await peer.wantBlock(segKappa);
    ok("non-owned (metadata-only) scene is NEVER served (rights gate)", got === null && srv.servesCount === 0);
  }

  // 13 — a subscribed fan is STILL protected: a server that passes the gate but serves WRONG bytes is refused at the
  // decoder (Law L5 — the receiver verifies vs the root it holds from the recipe, never trusts the peer).
  {
    const fx = ownedSceneFixture();
    const corrupted = fx.bytes.slice(); corrupted[0] ^= 0xff;        // flip a byte AFTER it would be served
    const served = [{ scene: fx.scene, bytesByKappa: new Map([[fx.segKappa, corrupted]]) }];
    const [A, B] = loopbackTransportPair();
    makeServer({ transport: A, bao: { rootHex } }, served, { gate: gateFn });
    const authedOk = await authorizePeer(B, present);
    const peer = makePeer({ transport: B, bao: { rootHex } }, fx.graph);
    const got = authedOk ? await peer.wantBlock(fx.segKappa) : null;
    ok("subscribed fan STILL refuses tampered bytes (L5 at the decoder)", authedOk === true && got === null);
  }

  console.log(`\n  creator-witness: ${pass}/${pass + fail} claims green` + (fail ? `  (${fail} FAILED)` : ""));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("witness crashed:", e); process.exit(2); });
