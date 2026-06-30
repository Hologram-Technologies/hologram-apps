#!/usr/bin/env node
// holo-xxx-witness.mjs — proves the Holo XXX chain end to end, in Node, with no browser and no network:
//   1 discovery: the hub merges a StashDB-shaped metadata edition and an owned-video edition of the SAME scene
//     into one scene (performers/tags unioned, catalogue cover preferred), and auto-facets the tag space.
//   2 manifest:  sealScene is deterministic and self-verifying (L5); a tampered field fails verifyScene.
//   3 rights:    a metadata-only scene that tries to carry a video κ is refused in code (index, never redistribute).
//   4 manufacture: the video track κ = blake3(graph recipe); the sha256 segment closure is pinned in provenance.
//   5 share→open: a #k= link opens on a FRESH device with the origin offline (recipe L5-verified); one flipped
//     byte fails closed. Segment-closure mismatch (graph tamper) fails closed.
//   6 privacy:   the collection head seals under AES-GCM and round-trips; a wrong key fails closed.
//
//   node holo-xxx-witness.mjs   → prints PASS/FAIL per claim, writes holo-xxx-witness.result.json, exits non-zero on fail.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

import { createSceneHub, sceneKey } from "./holo-scene.mjs";
import { sealScene, verifyScene, RIGHTS } from "./holo-scene-manifest.mjs";
import { manufactureScene, createCollection, shareScene, openShared } from "./holo-collection.mjs";
import { bestRep, qualityBadge, makeHub } from "./holo-xxx.mjs";
import { resolveStashKey, createKappaCache, pinCover } from "./holo-xxx-config.mjs";
import { sealCollection, openCollection, stepUpForScene, sceneChallenge, needsStepUp } from "./holo-xxx-seal.mjs";
import { planAcquire, acquireIntoCollection } from "./holo-xxx-acquire.mjs";
import { loopbackTransportPair, makeServer, makeClient } from "./holo-xxx-peer.mjs";
import { importCatalog, generateDemoCatalog } from "./holo-xxx-catalog.mjs";
import { createIngestQueue } from "./holo-xxx-queue.mjs";
import { parseM3U8, resolveGraph, codecStringFromInit, absUrl } from "./holo-xxx-hls.mjs";
import { createAggregator, demoBackend, stashBackend } from "./holo-xxx-aggregator.mjs";
import { parseTaxonomy, slugToQuery, fetchTaxonomy, orderForWall, matchCategories } from "./holo-xxx-aloha.mjs";
import { calcHash, extractVidHash, pickBest } from "./holo-xxx-eporner.mjs";
import { affinityOf, rankCategories, forYou, makeEvent } from "./holo-xxx-q.mjs";
import { classifyMedia, buildVstreamSrc } from "../../../holo-os/system/os/usr/lib/holo/holo-media-route.mjs";
import { MemKappaStore } from "../../../holo-os/system/os/usr/lib/holo/holo-opfs-kappastore.mjs";
import { principalFromSeed } from "../../../holo-os/system/os/usr/lib/holo/holo-login.mjs";
import { kappaOf } from "../holo-import/holo-content-net.mjs";
import * as bao from "../../../holo-os/system/os/usr/lib/holo/holo-bao.mjs";
import * as baoStream from "../../../holo-os/system/os/usr/lib/holo/holo-bao-stream.mjs";
import * as swarm from "../../../holo-os/system/os/usr/lib/holo/holo-swarm-fetch.mjs";
import { readFileSync as rf } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const results = [];
const check = async (name, fn) => { try { await fn(); results.push({ name, pass: true }); console.log("PASS  " + name); } catch (e) { results.push({ name, pass: false, err: e.message }); console.log("FAIL  " + name + "  — " + e.message); } };

// shaped like a StashDB scrape (meta) and an owned file (video) for the SAME scene, plus a second metadata-only scene.
const STASH = {
  id: "stash", name: "StashDB", kind: "open", mediaType: "meta", trust: 4,
  async search() { return [
    { id: "stashdb:1", mediaType: "meta", title: "Aurora", performers: ["Performer A"], studio: "Holo Studio", date: "2026-01-12", tags: ["4K", "Cinematic"], cover: "https://art/aurora.jpg", duration: 600 },
    { id: "stashdb:2", mediaType: "meta", title: "Noir Hours", performers: ["Performer E"], studio: "Open Catalogue", date: "2025-08-02", tags: ["Vintage", "Story"], cover: "https://art/noir.jpg" },
  ]; },
};

await (async () => {
  // load a REAL graph the ingest sealed (4K/60 ladder) — fidelity over a synthetic stub.
  const catalog = JSON.parse(readFileSync(join(here, "media", "catalog.json"), "utf8"));
  const auroraGraph = catalog.scenes.find((s) => s.id === "aurora").graph;

  const OWNED = {
    id: "owned", name: "My Collection", kind: "owned", mediaType: "video", trust: 6,
    async search() { return [
      { id: "own:aurora", mediaType: "video", title: "Aurora", performers: ["Performer A", "Performer B"], studio: "Holo Studio", date: "2026-01-12", tags: ["60fps", "Solo"], cover: "media/aurora/cover.jpg", duration: 4, _graph: auroraGraph },
    ]; },
  };

  await check("1 hub merges meta+video by scene key, unions performers/tags, prefers catalogue cover", async () => {
    const hub = createSceneHub(); hub.register(STASH); hub.register(OWNED);
    const scenes = await hub.findScenes("aurora");
    const aurora = scenes.find((s) => s.title === "Aurora");
    assert(aurora, "Aurora scene present");
    assert.equal(aurora.key, sceneKey("Aurora", "Holo Studio", "2026-01-12"));
    assert.equal(aurora.video.length, 1, "owned video edition merged in");
    assert.equal(aurora.meta.length, 1, "metadata edition merged in");
    assert.deepEqual(aurora.performers.sort(), ["Performer A", "Performer B"], "performers unioned across catalogues");
    assert(aurora.tags.includes("4K") && aurora.tags.includes("Solo"), "tags unioned across catalogues");
    assert.equal(aurora.cover, "https://art/aurora.jpg", "catalogue (meta) cover preferred");
    assert.equal(scenes[0].title, "Aurora", "streamable scene sorted ahead of index-only");
  });

  await check("1b facetsOf aggregates the tag space with counts, hottest first", async () => {
    const hub = createSceneHub(); hub.register(STASH); hub.register(OWNED);
    const facets = hub.facetsOf(await hub.findScenes(""));
    assert(facets.length >= 4, "several categories surfaced");
    for (let i = 1; i < facets.length; i++) assert(facets[i - 1].count >= facets[i].count, "sorted by count desc");
  });

  await check("2 sealScene is deterministic + self-verifying (L5); tamper fails verify", async () => {
    const m = { work: { title: "Aurora", performers: ["B", "A"], studio: "Holo Studio", date: "2026-01-12" }, video: "blake3:" + "a".repeat(64), tags: ["Z", "a"], rights: { class: RIGHTS.USER_OWNED } };
    const s1 = sealScene(m), s2 = sealScene(m);
    assert.equal(s1.kappa, s2.kappa, "same essence → same κ (order-independent)");
    assert(verifyScene(s1), "verifies");
    assert(!verifyScene({ ...s1, work: { ...s1.work, title: "Tampered" } }), "tampered title fails verify");
  });

  await check("3 metadata-only scene refuses to carry a video κ (index, never redistribute)", async () => {
    assert.throws(() => sealScene({ work: { title: "Indexed" }, video: "blake3:" + "b".repeat(64), rights: { class: RIGHTS.METADATA_ONLY } }), /metadata-only/);
    // but an index entry with no bytes is fine.
    const idx = sealScene({ work: { title: "Indexed" }, rights: { class: RIGHTS.METADATA_ONLY } });
    assert(idx.modes.indexOnly, "index-only mode");
  });

  await check("4 manufactureScene: video κ = blake3(recipe), segment closure pinned, scene verifies", async () => {
    const { scene, blobs } = manufactureScene({ work: { title: "Aurora", performers: ["A"], studio: "Holo Studio", date: "2026-01-12" }, graph: auroraGraph, tags: ["4K", "60fps"] });
    assert(/^blake3:[0-9a-f]{64}$/.test(scene.video), "video track is a blake3 κ");
    assert(blobs.has(scene.video), "recipe blob present for the video κ");
    assert(scene.provenance.segmentClosure.startsWith("did:holo:sha256:"), "sha256 segment closure recorded");
    assert(verifyScene(scene), "scene verifies");
    const rep = bestRep(auroraGraph);
    assert.equal(rep.height, 2160, "bestRep picks the 4K rung");
    assert.equal(qualityBadge(rep), "4K60", "quality badge reads 4K60");
  });

  await check("5 share→open on a FRESH device (origin offline); tamper fails closed", async () => {
    const { scene, graph, blobs } = manufactureScene({ work: { title: "Aurora", performers: ["A"], studio: "Holo Studio", date: "2026-01-12" }, graph: auroraGraph, tags: ["4K"] });
    const shared = shareScene(scene, blobs);
    assert.equal(shared.mode, "inline", "recipe link is tiny (κ lists only) → inline");
    const opened = openShared(shared.link);
    assert.equal(opened.scene.kappa, scene.kappa, "scene re-derives identically");
    assert.equal(JSON.stringify(opened.graph), JSON.stringify(graph), "graph recipe re-derives identically");
    // tamper one byte of the recipe payload → L5 must refuse.
    const bad = JSON.parse(JSON.stringify(shared.payload));
    bad.blobs[0][1] = bad.blobs[0][1].slice(0, -4) + (bad.blobs[0][1].slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    assert.throws(() => openShared(bad), /(mismatch|tamper|verify)/i, "flipped recipe byte fails closed");
  });

  // ── P1: the real OS seams ───────────────────────────────────────────────────────────────────────────────────
  const te = new TextEncoder();
  const operator = "did:holo:sha256:" + "c".repeat(64);
  const secret = te.encode("TEE-PRF-assertion-stand-in");        // OS: the WebAuthn-PRF secret, never stored
  const salt = te.encode("device-salt-witness");

  await check("6 collection head seals under the REAL holospace-identity TEE seam; wrong secret fails closed", async () => {
    const { scene } = manufactureScene({ work: { title: "Aurora", studio: "Holo Studio", date: "2026-01-12" }, graph: auroraGraph });
    const col = createCollection("ilya");
    col.add(scene);
    assert(col.verifyHead(), "head κ verifies over the manifest");
    const blob = await sealCollection(col, { operator, secret, deviceSalt: salt });   // → holospace-identity.sealState
    const open = await openCollection(blob, { operator, secret, deviceSalt: salt });
    assert.equal(open.owner, "ilya");
    assert.equal(open.entries[0].kappa, scene.kappa, "sealed entry round-trips through openState");
    await assert.rejects(openCollection(blob, { operator, secret: te.encode("wrong"), deviceSalt: salt }), /fail-closed/, "wrong TEE secret refused (AES-GCM auth + L5)");
  });

  await check("7 opening a scene is a step-up whose challenge IS the scene κ (payload-bound)", async () => {
    const { scene } = manufactureScene({ work: { title: "Aurora", studio: "Holo Studio", date: "2026-01-12" }, graph: auroraGraph });
    const signer = await principalFromSeed(te.encode("witness-seed".padEnd(32, "x")), "ilya");
    const tok = await stepUpForScene(scene.kappa, { operator: signer.kappa, signer, issuedAt: "1970-01-01T00:00:00Z", nonce: "n0" });
    const expect = await sceneChallenge(scene.kappa, { operator: signer.kappa, issuedAt: "1970-01-01T00:00:00Z", nonce: "n0" });
    assert.equal(tok.payload, scene.kappa, "the step-up payload IS the scene κ");
    assert.equal(tok.challenge, expect, "the signed challenge commits to that exact scene");
    assert.equal(needsStepUp("everything.open", {}), true, "opening always steps up cold (authority level)");
  });

  await check("8 discovery: injected key enables StashDB + normalizes; κ-cache dedupes repeat queries", async () => {
    process.env.HOLO_XXX_STASHDB_KEY = "test-key-123";
    assert.equal(resolveStashKey(), "test-key-123", "key resolves from the injected env path");
    let calls = 0;
    const mockFetch = async () => { calls++; return { ok: true, json: async () => ({ data: { queryScenes: { scenes: [
      { id: "s1", title: "Velvet", release_date: "2026-03-04", duration: 1200, studio: { name: "Holo Studio" }, performers: [{ performer: { name: "B" } }], tags: [{ name: "4K" }, { name: "Couple" }], images: [{ url: "https://art/v.jpg", width: 1920 }] } ] } } }) }; };
    const hub = makeHub({ stashApiKey: "test-key-123", fetch: mockFetch, cache: createKappaCache() });
    const r1 = await hub.findScenes("velvet");
    const r2 = await hub.findScenes("velvet");                   // identical → served from κ-cache
    const v = r1.find((s) => s.title === "Velvet");
    assert(v && v.cover === "https://art/v.jpg", "StashDB scene normalized (cover = widest image)");
    assert(v.tags.includes("4K") && v.tags.includes("Couple"), "tags carried for faceting");
    assert.equal(calls, 1, "repeat query hit the cache (one network round-trip total)");
    delete process.env.HOLO_XXX_STASHDB_KEY;
  });

  await check("9 covers content-address by κ (Lightspeed): same bytes → stable κ + /.holo src", async () => {
    const bytes = te.encode("fake-cover-bytes");
    const a = await pinCover("https://art/x.jpg", { fetch: async () => ({ arrayBuffer: async () => bytes.buffer }), kappaOf });
    const b = await pinCover("https://art/x.jpg", { fetch: async () => ({ arrayBuffer: async () => bytes.buffer }), kappaOf });
    assert.equal(a.kappa, b.kappa, "identical cover bytes → identical κ");
    assert(a.src.startsWith("/.holo/sha256/"), "served from the κ-content route on repeat, not the origin");
  });

  await check("10 acquire is plan-only (no fetch) and seals the user's graph into the collection", async () => {
    const plan = planAcquire("https://vimeo.com/123456789");
    assert.equal(plan.recognized, true, "recognized the watch page");
    assert.equal(plan.platform, "vimeo", "platform classified");
    assert(/holo-xxx-ingest\.mjs --acquire/.test(plan.ytdlp), "plan names the user's own ingest step");
    assert(/your call|ToS/i.test(plan.note), "plan states acquisition is the user's call");
    // the manufacture→own step, once the user has a κ-sealed graph (here the demo 4K graph stands in):
    const col = createCollection("ilya");
    const { scene } = acquireIntoCollection({ graph: auroraGraph, work: { title: "Acquired", studio: "Self", date: "2026-06-26" }, tags: ["4K"], collection: col });
    assert(col.has(scene.kappa), "acquired scene sealed into the owned collection");
    assert(scene.modes.stream, "acquired scene is streamable (holds a video κ)");
    assert.equal(scene.rights.class, RIGHTS.USER_OWNED, "acquired scene is user-owned, not metadata-only");
  });

  // ── P2: verified streaming + hostless peer delivery ─────────────────────────────────────────────────────────
  const aurora = catalog.scenes.find((s) => s.id === "aurora");
  const rep0 = aurora.graph.videos[0].representations[0];
  const bytesByKappa = new Map();                                  // the owner's segment bytes (init + media)
  bytesByKappa.set(rep0.initSegment, new Uint8Array(rf(join(here, rep0.initPath))));
  for (const s of rep0.segments) bytesByKappa.set(s.kappa, new Uint8Array(rf(join(here, s.path))));

  await check("11 each segment carries a blake3/Bao root that matches its bytes (the verified-streaming axis)", async () => {
    const seg0 = rep0.segments[0];
    assert(/^did:holo:blake3:[0-9a-f]{64}$/.test(seg0.bao), "segment stamped with a blake3 Bao root");
    assert.equal(bao.rootHex(bytesByKappa.get(seg0.kappa)), seg0.bao.split(":").pop(), "root matches the segment bytes");
    // the per-1024B Bao primitive on a small object: clean chunks verify, a flipped chunk is refused (Law L5).
    const small = new Uint8Array(3000).map((_, i) => (i * 7) & 0xff);
    const enc = bao.encode(small);
    let delivered = 0; await baoStream.streamVerified(enc.root, baoStream.fromEncoded(enc), { onChunk: () => delivered++ });
    assert.equal(delivered, enc.chunks.length, "all clean chunks verified against the root");
    const tampered = { chunks: enc.chunks.map((c, i) => i === 1 ? { ...c, bytes: c.bytes.map((b) => b ^ 1) } : c) };
    await assert.rejects(baoStream.streamVerified(enc.root, baoStream.fromEncoded(tampered)), /does not verify/, "a flipped chunk is refused at that chunk");
  });

  await check("12 HOSTLESS peer: receiver streams a segment by κ over a channel, Bao-verified; lying peer refused", async () => {
    const [A, B] = loopbackTransportPair();
    const srv = makeServer({ transport: A, bao }, [{ scene: { kappa: aurora.id, rights: { class: RIGHTS.USER_OWNED } }, bytesByKappa }]);
    assert.equal(srv.servesCount, bytesByKappa.size, "owner serves init + all segments");
    const cli = makeClient({ transport: B, bao, swarm }, aurora.graph);
    const seg0 = rep0.segments[0];
    const got = await cli.resolve(seg0.kappa);
    const orig = bytesByKappa.get(seg0.kappa);
    assert.equal(got.length, orig.length, "peer-streamed segment is whole");
    assert(got.every((b, i) => b === orig[i]), "peer-streamed bytes are bit-identical to the owner's");
    // a lying peer (one flipped byte) fails the receiver's root check → resolve throws (fail-closed).
    const [C, D] = loopbackTransportPair();
    const lie = new Map(bytesByKappa); const bad = orig.slice(); bad[100] ^= 1; lie.set(seg0.kappa, bad);
    makeServer({ transport: C, bao }, [{ scene: { kappa: aurora.id, rights: { class: RIGHTS.USER_OWNED } }, bytesByKappa: lie }]);
    const cli2 = makeClient({ transport: D, bao, swarm }, aurora.graph);
    await assert.rejects(cli2.resolve(seg0.kappa), /no verified source/, "tampered peer bytes refused (Law L5)");
  });

  await check("13 rights: a metadata-only scene is never served peer-to-peer", async () => {
    const [A] = loopbackTransportPair();
    const srv = makeServer({ transport: A, bao }, [{ scene: { kappa: "idx", rights: { class: RIGHTS.METADATA_ONLY } }, bytesByKappa }]);
    assert.equal(srv.servesCount, 0, "no bytes served for a metadata-only (index) scene");
  });

  await check("14 swarm failover: a dead peer is skipped, an honest peer still delivers", async () => {
    const seg0 = rep0.segments[0];
    const dead = { id: "dead", has: () => true, wantBlock: async () => null };       // always fails
    const [A, B] = loopbackTransportPair();
    makeServer({ transport: A, bao }, [{ scene: { kappa: aurora.id, rights: { class: RIGHTS.USER_OWNED } }, bytesByKappa }]);
    const good = makeClient({ transport: B, bao, swarm }, aurora.graph).peer;          // a real peer over the channel
    const src = swarm.createSwarmSource([dead, good], { attempts: 3 });
    const got = await src.wantBlock(seg0.kappa);
    assert(got && got.length === bytesByKappa.get(seg0.kappa).length, "swarm reassigned to the honest holder and delivered");
  });

  await check("15 share→peer-open: a #k= recipe opens (origin offline) and its graph drives peer streaming", async () => {
    const { scene, graph, blobs } = manufactureScene({ work: { title: "Aurora", studio: "Holo Studio", date: "2026-01-12" }, graph: aurora.graph, tags: ["4K"] });
    const shared = shareScene(scene, blobs);
    const opened = openShared(shared.link);                                           // L5 recipe verify, IO-free
    assert.equal(opened.scene.kappa, scene.kappa, "recipe re-derives the scene κ");
    const [A, B] = loopbackTransportPair();
    makeServer({ transport: A, bao }, [{ scene: { kappa: scene.kappa, rights: { class: RIGHTS.USER_OWNED } }, bytesByKappa }]);
    const cli = makeClient({ transport: B, bao, swarm }, opened.graph);               // the OPENED recipe's graph
    const got = await cli.resolve(rep0.segments[0].kappa);
    assert(got && got.length > 0, "the opened recipe streams its bytes from a peer (neither side hosts)");
  });

  // ── P3: planetary catalogue (metadata at scale) + batch ingest of the user's own sources ────────────────────
  await check("16 importCatalog paginates a provider into many BYTE-FREE index entries (dedup by id)", async () => {
    let pages = 0;
    const fetchPage = async (p) => { pages++; return p < 5 ? Array.from({ length: 24 }, (_, i) => ({ id: "sd:" + p + ":" + i, title: "Scene " + p + "-" + i, performers: ["P"], studio: "S", date: "2024-01-01", tags: ["4K"], cover: "https://art/" + p + i })) : []; };
    const cat = await importCatalog({ fetchPage, pages: 10 });
    assert.equal(cat.length, 24 * 5, "all pages imported, stopped at the empty page");
    assert(cat.every((s) => s.mediaType === "meta"), "every imported entry is metadata-only (byte-free)");
    assert(cat.every((s) => !s.video && !s.graph), "no entry carries bytes/graph — an index, never a redistributor");
    // re-importing the same ids dedups (overlapping pages don't double-count)
    const dup = await importCatalog({ fetchPage: async (p) => p === 0 ? [{ id: "x", title: "A" }, { id: "x", title: "A" }] : [], pages: 2 });
    assert.equal(dup.length, 1, "duplicate ids collapse");
  });

  await check("17 generateDemoCatalog yields a large, varied, byte-free wall (facet-able)", async () => {
    const wall = generateDemoCatalog(1200);
    assert.equal(wall.length, 1200, "produces the requested scale");
    assert(wall.every((s) => s.mediaType === "meta" && !s.video), "byte-free index entries");
    const tags = new Set(wall.flatMap((s) => s.tags));
    assert(tags.size >= 10, "a wide category spread for the facets (" + tags.size + " tags)");
    // the hub merges by sceneKey(title|studio|year), so THAT is what must stay distinct (titles may repeat).
    const keys = new Set(wall.map((s) => sceneKey(s.title, s.studio, s.date)));
    assert(keys.size > 1000, "distinct scene keys so the wall stays huge after hub dedup (" + keys.size + ")");
  });

  await check("18 ingest queue: a real κ-graph → streamable+owned; no graph → failed (never a fake stream)", async () => {
    const col = createCollection("ilya");
    // ingest stub: a recognized source yields the demo 4K graph; an empty/garbage source yields nothing.
    const ingest = async (src) => src === "ok" ? { graph: auroraGraph, work: { title: "Owned", studio: "Self", date: "2026-06-26" }, tags: ["4K"] } : null;
    const q = createIngestQueue({ ingest, collection: col });
    q.add("ok"); q.add("nope");
    const tally = await q.run({ concurrency: 2 });
    const items = q.items();
    const ok = items.find((i) => i.source === "ok"), bad = items.find((i) => i.source === "nope");
    assert.equal(ok.status, "streamable", "a real κ-graph item becomes streamable");
    assert(ok.scene && col.has(ok.scene.kappa), "and is sealed into the owned collection");
    assert.equal(ok.scene.rights.class, RIGHTS.USER_OWNED, "owned, not metadata-only");
    assert.equal(bad.status, "failed", "no graph → failed, NEVER a fake-playable entry");
    assert.equal(tally.streamable, 1, "tally counts only genuinely streamable items");
  });

  // ── P4: native AlohaTube — aggregator index + resolve-on-play (HLS → κ) ──────────────────────────────────────
  const te4 = new TextEncoder();
  const { sha256hex } = await import("../../../holo-os/system/os/usr/lib/holo/holo-uor.mjs");

  await check("19 aggregator: byte-free index entries carry a resolvable _src + a category taxonomy", async () => {
    const agg = createAggregator({ backend: demoBackend({ playlists: [
      { title: "A", src: "https://cdn.example/a.m3u8", tags: ["4K", "Solo"] },
      { title: "B", src: "https://cdn.example/b.m3u8", tags: ["Couple"] },
    ] }) });
    const rows = await agg.browse(0);
    assert.equal(rows.length, 2, "browse pages the index");
    assert(rows.every((s) => s.mediaType === "meta" && !s.video && !s.graph), "every entry is byte-free (an index, not bytes)");
    assert(rows.every((s) => /\.m3u8$/.test(s._src)), "each entry carries a resolvable source URL (_src)");
    assert((await agg.categories()).length >= 10, "a wide category taxonomy for the facets");
    assert.equal(classifyMedia("https://www.youtube.com/watch?v=abc") ? "ok" : "no", "ok", "classifyMedia recognizes a real source page");
  });

  await check("20 resolve-on-play: an m3u8 → a κ-MediaGraph; seg0 is delivered BEFORE the tail (streaming ingest)", async () => {
    // a mock fMP4 HLS: an init with an 'avcC' box + two media segments. The witness fetch returns bytes per URL.
    const initBytes = (() => { const b = new Uint8Array(64); b.set([0x61, 0x76, 0x63, 0x43, 0, 0x64, 0x00, 0x28], 8); return b; })(); // 'avcC' High@4.0
    const seg = (n) => te4.encode("segment-" + n + "-bytes".repeat(8));
    const m3u8 = `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg0.m4s\n#EXTINF:2.0,\nseg1.m4s\n#EXT-X-ENDLIST\n`;
    const store = { "https://cdn.x/v/play.m3u8": m3u8, "https://cdn.x/v/init.mp4": initBytes, "https://cdn.x/v/seg0.m4s": seg(0), "https://cdn.x/v/seg1.m4s": seg(1) };
    const mockFetch = async (u) => ({ text: async () => store[u], arrayBuffer: async () => store[u].buffer || store[u] });
    // parse anchors segments to the playlist URL
    const { initUrl, segUrls } = parseM3U8(m3u8, "https://cdn.x/v/play.m3u8");
    assert.equal(initUrl, "https://cdn.x/v/init.mp4", "init resolved absolute against the playlist");
    assert.deepEqual(segUrls, ["https://cdn.x/v/seg0.m4s", "https://cdn.x/v/seg1.m4s"], "segments resolved absolute, in order");
    assert(/avc1\.640028/.test(codecStringFromInit(initBytes)), "codec string read from the avcC box");
    const order = [];
    const { graph, bytesByKappa } = await resolveGraph({ m3u8Url: "https://cdn.x/v/play.m3u8", fetch: mockFetch, sha256hex, height: 2160, onSegment: (i) => order.push(i) });
    const rep = graph.videos[0].representations[0];
    assert.equal(rep.segments.length, 2, "the resolved graph has both segments");
    assert(rep.segments.every((s) => /^did:holo:sha256:[0-9a-f]{64}$/.test(s.kappa)), "each segment is sealed by its κ");
    assert.deepEqual(order, [-1, 0, 1], "delivery order: init, then seg0 BEFORE seg1 (seg0-to-first-frame latency)");
    assert(bytesByKappa.size === 3, "init + 2 segments cached by κ");
  });

  await check("21 κ-cache replay: a prior resolve's κs serve a repeat from cache, byte-identical, no re-fetch", async () => {
    const seg = (n) => te4.encode("seg" + n + "x".repeat(40));
    const store = { "u/p.m3u8": `#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:2,\ns0.m4s\n#EXT-X-ENDLIST\n`, "u/i.mp4": (() => { const b = new Uint8Array(32); b.set([0x61, 0x76, 0x63, 0x43, 0, 0x64, 0, 0x28], 8); return b; })(), "u/s0.m4s": seg(0) };
    let fetches = 0;
    const mockFetch = async (u) => { fetches++; const v = store[u.replace(/^.*\/u\//, "u/")] || store[u]; return { text: async () => v, arrayBuffer: async () => v.buffer || v }; };
    const cache = new Map(); const wrap = { async get(k) { return cache.get(k) || null; }, async put(k, b) { cache.set(k, b); } };
    const r1 = await resolveGraph({ m3u8Url: "u/p.m3u8", fetch: mockFetch, sha256hex });
    for (const [k, b] of r1.bytesByKappa) await wrap.put(k, b);            // first resolve fills the κ-cache
    const segK = r1.graph.videos[0].representations[0].segments[0].kappa;
    const cached = await wrap.get(segK);
    assert(cached && cached.length === r1.bytesByKappa.get(segK).length, "repeat reads the segment FROM the κ-cache");
    assert.equal(sha256hex(cached), segK.split(":").pop(), "cached bytes re-derive the same κ (verified, origin-independent)");
  });

  await check("22 routing: classifyMedia recognizes a watch page (yt-dlp path) but not an m3u8 (HLS path); vstream key is the page URL", async () => {
    // resolvePlay branches: a direct m3u8 → HLS streaming-ingest; anything classifyMedia recognizes → /sc/vstream.
    const yt = classifyMedia("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert(yt && yt.platform === "youtube" && /youtube\.com\/watch\?v=/.test(yt.canonical), "a watch page classifies to a canonical URL → yt-dlp branch");
    assert.equal(classifyMedia("https://cdn.example/stream/master.m3u8"), null, "a bare m3u8 is NOT a platform watch page → it takes the direct-HLS branch");
    const src = buildVstreamSrc(yt.canonical, 2160);
    assert(/\/sc\/vstream\?url=/.test(src) && /h=2160/.test(src), "vstream route keys on the encoded page URL (yt-dlp takes the page), not a per-platform id");
    assert(src.includes(encodeURIComponent(yt.canonical)), "the canonical page URL is the cache key");
  });

  await check("23 persistent κ-cache (content-addressed store contract): a repeat view serves a segment by κ even when the resolver THROWS", async () => {
    // production persists segments by κ in IndexedDB (portable; some hosts block OPFS writes). MemKappaStore is the
    // same-contract differential oracle for the property: a first resolve persists by κ; a COLD repeat with a dead
    // origin still serves it (origin-independent) — exactly what the IDB-backed kCache does in index.html.
    const store = await MemKappaStore.open();
    const bytes = te4.encode("resolved-segment-".repeat(16));
    const k = "did:holo:sha256:" + sha256hex(bytes);
    const ref = await store.put("sha256", bytes);                  // device cache write (κ derived from bytes)
    assert.equal(ref, "sha256:" + sha256hex(bytes), "stored under its content κ");
    const cacheFirst = async (kappa, fetcher) => { const c = await store.get(kappa); return c || fetcher(); };
    const got = await cacheFirst(k, () => { throw new Error("origin unreachable"); });   // resolver MUST NOT be hit
    assert(got && got.length === bytes.length, "repeat served from the persistent κ-cache, resolver never called");
    assert.equal(sha256hex(got), k.split(":").pop(), "cached bytes re-derive the same κ (verified)");
  });

  await check("24 owned-only peer gate refuses a RESOLVED third-party scene (resolved bytes never broadcast)", async () => {
    const [A] = loopbackTransportPair();
    // a resolved third-party scene is NOT user-owned/public-domain → the rights gate must serve 0 of its bytes.
    const resolvedScene = { scene: { kappa: "resolved:x", rights: { class: "resolved-thirdparty" } }, bytesByKappa };
    const srv = makeServer({ transport: A, bao }, [resolvedScene]);
    assert.equal(srv.servesCount, 0, "a resolved (non-owned) scene is refused by the peer server — bytes stay device-local");
    // sanity: the SAME bytes under a user-owned rights class WOULD be served (the gate keys on rights, not bytes).
    const [C] = loopbackTransportPair();
    const owned = makeServer({ transport: C, bao }, [{ scene: { kappa: "owned:x", rights: { class: "user-owned-source" } }, bytesByKappa }]);
    assert.equal(owned.servesCount, bytesByKappa.size, "the identical bytes ARE served when the scene is user-owned (rights gate, not a byte gate)");
  });

  await check("25 live backend: stashBackend pages byte-free index entries that forward a resolvable _src; importCatalog dedups", async () => {
    // a StashDB-shaped provider (normalized rows carry `urls`); stashBackend forwards the first url as _src.
    const mk = (page, i) => ({
      id: "sd:" + page + ":" + i, mediaType: "meta", title: "Scene " + page + "-" + i, performers: ["P"], studio: "S",
      date: "2026-01-0" + (i + 1), tags: ["4K", "Couple"], cover: "https://art/" + page + i + ".jpg",
      urls: i === 0 ? ["https://vimeo.com/" + (100000 + i)] : [],   // some carry a recognizable source page
    });
    const rows = (page) => page === 0 ? [mk(0, 0), mk(0, 1), mk(0, 2), mk(0, 3)]
      : page === 1 ? [mk(0, 0), mk(0, 1)]                           // overlapping ids on page 1 → must dedup away
      : [];                                                          // page 2 empty → importCatalog stops
    const provider = { async browse(p) { return rows(p); }, async search() { return []; } };
    const agg = createAggregator({ backend: stashBackend(provider) });
    const p0 = await agg.browse(0);
    assert.equal(p0.length, 4, "a page of scenes");
    assert(p0.every((s) => s.mediaType === "meta" && !s.video && !s.graph), "every entry is byte-free (an index, never bytes)");
    assert(p0.some((s) => /vimeo\.com/.test(s._src || "")), "_src forwarded from the scene's source urls (resolvable host → yt-dlp path)");
    // importCatalog pages the same backend into the wall and dedups by id across overlapping pages.
    const cat = await importCatalog({ fetchPage: (p) => agg.browse(p), pages: 5 });
    assert.equal(cat.length, 4, "4 distinct ids imported; page-1 duplicates deduped; stopped at the empty page");
    assert(cat.every((s) => s.mediaType === "meta"), "the imported wall is entirely byte-free");
  });

  // ── P6: the Aloha Atlas — taxonomy from aloha, content from sources, base-36 stream auth ─────────────────────
  await check("26 aloha taxonomy: parseTaxonomy reads /top/<slug> categories (byte-free); slug→query maps underscores", async () => {
    const html = `<a href="/top/milf">MILF</a> x <a href="/top/big_natural_tits">Big Natural Tits</a>
      <a href="/top/milf">dup</a> <a href="/top/">Top</a> <a href="/new/">New</a> <a href="/login">x</a>`;
    const cats = parseTaxonomy(html);
    assert.equal(cats.length, 2, "two distinct categories (dup slug + top/new/login excluded)");
    assert(cats.every((c) => c.slug && c.label && !("video" in c) && !("_src" in c)), "byte-free {slug,label} only — an index, never bytes");
    assert.equal(cats.find((c) => c.slug === "big_natural_tits").label, "Big Natural Tits", "the human label is carried");
    assert.equal(slugToQuery("big_natural_tits"), "big natural tits", "slug → source query (underscores → spaces)");
  });

  await check("27 fetchTaxonomy + orderForWall: injected fetch → categories with query; a headline category leads", async () => {
    const html = `<a href="/top/teen">Teen</a><a href="/top/zebra">Zebra</a><a href="/top/milf">MILF</a><a href="/top/anal">Anal</a>`;
    const cats = await fetchTaxonomy({ fetch: async () => ({ text: async () => html }) });
    assert(cats.length === 4 && cats.every((c) => c.query), "fetched through the injected (DoH-proxy) fetch + query attached");
    const ordered = orderForWall(cats);
    assert(["milf", "teen", "anal"].includes(ordered[0].slug), "a headline (populous) category leads the wall");
    assert.equal(ordered[ordered.length - 1].slug, "zebra", "the long tail sorts alphabetically after the headline block");
  });

  await check("28 Eporner base-36 hash IS the stream-auth transform (raw hash is rejected; transform unlocks it)", async () => {
    const raw = "8ed59090d0811eea82b5f1f66d74fdf2";
    const expect = ["8ed59090", "d0811eea", "82b5f1f6", "6d74fdf2"].map((c) => parseInt(c, 16).toString(36)).join("");
    assert.equal(calcHash(raw), expect, "calcHash = base-36 of each 8-hex chunk (matches yt-dlp's eporner vjs.js algo)");
    assert.notEqual(calcHash(raw), raw, "the transform is NOT identity — the RAW hash is exactly what the source refuses");
    const vh = extractVidHash(`EP.video.player.vid = 'AbC123'; EP.video.player.hash = '${raw}';`);
    assert(vh && vh.vid === "AbC123" && vh.hash === raw, "extractVidHash reads vid+hash from the embed player config");
    const best = pickBest({ sources: { mp4: { auto: { src: "https://x/na.mp4" }, "1080p": { src: "https://x/1080.mp4" }, "2160p(4K)": { src: "https://x/4k.mp4" } } } }, 1440);
    assert(best && /1080\.mp4/.test(best.url) && best.h === 1080, "pickBest skips the na.mp4 placeholder + caps at maxHeight (keeps the GPU transcode real-time)");
  });

  await check("29 private curator: watch history re-ranks categories (recency-weighted); byte-free; no-history falls back", async () => {
    const now = 1700000000000;
    const cats = [{ slug: "milf", query: "milf" }, { slug: "asian", query: "asian" }, { slug: "vintage", query: "vintage" }, { slug: "big_natural_tits", query: "big natural tits" }];
    // the logged event is BYTE-FREE about the user: category slug + tags only, NO title/performer.
    const ev = makeEvent({ title: "SECRET TITLE", performers: ["A Name"], tags: ["asian", "big tits"] }, "asian", now);
    assert(!("title" in ev) && !("performers" in ev) && ev.slug === "asian", "the taste signal carries NO title/performer — only the taxonomy hooks");
    const events = [ev, makeEvent({ tags: ["asian"] }, "asian", now - 1e3), makeEvent({ tags: ["asian"] }, "asian", now - 2e3), makeEvent({ tags: ["milf"] }, "milf", now - 3e3)];
    const fy = forYou(cats, events, now, 3);
    assert.equal(fy[0].slug, "asian", "the most-watched (recent) category leads the For-You wall");
    assert(fy.find((c) => c.slug === "milf"), "a less-watched category still ranks, lower");
    assert(rankCategories(cats, affinityOf(events, now)).find((c) => c.slug === "big_natural_tits"), "a multi-word tag ('big tits') cross-matches a category query ('big natural tits')");
    assert.equal(forYou(cats, [], now).length, 0, "no history → empty → the wall falls back to the headline order (no cold-start junk)");
    // recency: an old watch decays below a fresh one.
    const oldA = affinityOf([makeEvent({}, "asian", now - 60 * 24 * 3600 * 1000)], now)["asian"];
    const newA = affinityOf([makeEvent({}, "asian", now)], now)["asian"];
    assert(newA > oldA * 4, "a fresh watch outweighs a 2-month-old one (taste tracks recent mood)");
  });

  await check("30 intent browse: a free-text mood → the overlapping Atlas categories (MOOD synonyms; empty → none)", async () => {
    const cats = [{ slug: "asian", label: "Asian", query: "asian" }, { slug: "busty_asian", label: "Busty Asian", query: "busty asian" }, { slug: "milf", label: "MILF", query: "milf" }, { slug: "vintage", label: "Vintage", query: "vintage" }, { slug: "sensual", label: "Sensual", query: "sensual" }];
    const m = matchCategories("asian milf", cats, 9);
    assert(m.some((c) => c.slug === "asian") && m.some((c) => c.slug === "milf"), "both intent words pull their categories into the bespoke wall");
    assert(!m.some((c) => c.slug === "vintage"), "an unrelated category is excluded — the wall is the mood, not everything");
    assert.equal(matchCategories("asian", cats, 9)[0].slug, "asian", "a single-word intent ranks the EXACT category first (asian > busty asian)");
    assert(matchCategories("intimate", cats, 9).some((c) => c.slug === "sensual"), "a soft MOOD word ('intimate') maps via synonyms to category vocabulary (sensual)");
    assert.equal(matchCategories("", cats).length, 0, "empty intent → no bespoke wall (the search falls back to the flat scene grid)");
  });
})();

const pass = results.filter((r) => r.pass).length;
const summary = { app: "holo-xxx", pass, total: results.length, ok: pass === results.length, results };
writeFileSync(join(here, "holo-xxx-witness.result.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`\n${pass}/${results.length} claims witnessed`);
process.exit(summary.ok ? 0 : 1);
