#!/usr/bin/env node
// holo-xxx-ingest.mjs — the Holo XXX ingest adapter + demo-catalogue builder (the swappable, off-substrate edge).
//
// Mirrors holo-tube-ingest: turns a video source into a MediaGraph (an init segment + ordered media segments, EACH
// sealed as a sha256 κ-object — the OS serving axis, resolvable at /.holo/sha256/<hex>). Segment bytes are bit-
// exact on the identity path (Law L2). What's new here: each scene carries a QUALITY LADDER (4K/60 → 1080/60), so
// holo-media.pickRepresentation streams the highest fidelity the device can decode and falls back cleanly.
//
//   node holo-xxx-ingest.mjs --demo
//       Generate self-made (no-copyright) 4K/60 + 1080/60 clips with ffmpeg → fMP4 → seal each segment by κ, and
//       write a demo catalogue (scenes with metadata + a quality ladder + a poster cover). The runnable path.
//
// Acquisition for REAL scenes is the user's call (owned files / yt-dlp) and out of scope here — the substrate is
// source-agnostic; once bytes are κ-sealed it doesn't know or care where they came from.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = "C:/Users/pavel/Desktop/HOLOGRAM/holo-os/system/os/usr/lib/holo";
const MEDIA = join(here, "media");

const { sha256hex } = await import(pathToFileURL(join(SHARED, "holo-uor.mjs")));
const { mediaGraphClosureKappa } = await import(pathToFileURL(join(SHARED, "holo-media.mjs")));
const { rootHex } = await import(pathToFileURL(join(SHARED, "holo-bao.mjs")));   // Bao root = blake3 verified-streaming axis
const baoOf = (bytes) => "did:holo:blake3:" + rootHex(bytes);

const SHA = "did:holo:sha256:";
const kappaOf = (bytes) => SHA + sha256hex(bytes);
const rel = (abs) => "media/" + abs.slice(MEDIA.length + 1).split("\\").join("/");
const rmrf = (p) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch (_) {} };

// yt-dlp: the vendored binary the rest of the OS uses, else PATH. Acquisition is the USER's call (ToS boundary).
const YTDLP = existsSync("C:/Users/pavel/Desktop/HOLOGRAM/holo-os/system/tools/bin/yt-dlp.exe")
  ? "C:/Users/pavel/Desktop/HOLOGRAM/holo-os/system/tools/bin/yt-dlp.exe" : "yt-dlp";

function ffmpeg(args, cwd) {
  const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"], cwd });
  if (r.status !== 0) throw new Error("ffmpeg failed (" + r.status + ")");
}
const haveFfmpeg = () => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

// read the exact RFC 6381 codec string from the fMP4 init's avcC box, so MSE.isTypeSupported accepts the rep.
function codecStringFromInit(initBytes) {
  for (let i = 0; i + 8 < initBytes.length; i++) {
    if (initBytes[i] === 0x61 && initBytes[i + 1] === 0x76 && initBytes[i + 2] === 0x63 && initBytes[i + 3] === 0x43) {
      const hx = (n) => n.toString(16).padStart(2, "0");
      return `video/mp4; codecs="avc1.${hx(initBytes[i + 5])}${hx(initBytes[i + 6])}${hx(initBytes[i + 7])}, mp4a.40.2"`;
    }
  }
  return 'video/mp4; codecs="avc1.640033, mp4a.40.2"';
}

// segment a muxed mp4 → HLS fMP4 (init.mp4 + segNNN.m4s), -c copy (bit-exact, container only). One dir per rep.
function segment(mp4, outDir, segDur) {
  mkdirSync(outDir, { recursive: true });
  ffmpeg(["-y", "-i", mp4, "-c", "copy", "-f", "hls", "-hls_time", String(segDur), "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", "seg%d.m4s", "out.m3u8"], outDir);
}

function sealRendition(dir, { height, fps, bitrate, segDur }) {
  rmrf(join(dir, "out.m3u8"));                              // the HLS playlist is scaffolding — the graph IS the playlist
  const files = readdirSync(dir);
  const initName = files.find((f) => /^init\.mp4$/i.test(f));
  const segNames = files.filter((f) => /\.m4s$/i.test(f)).sort((a, b) => (a.match(/\d+/)?.[0] | 0) - (b.match(/\d+/)?.[0] | 0));
  const initBytes = readFileSync(join(dir, initName));
  return {
    mime: codecStringFromInit(initBytes),
    height, fps, bitrate: bitrate || null, width: Math.round((height * 16) / 9),
    // Each segment carries BOTH axes: kappa (sha256, the serving address) AND bao (blake3 root, the verified-
    // streaming axis — lets a consumer/peer verify any 1024-byte chunk against the root in O(log n), Law L5).
    initSegment: kappaOf(initBytes), initBao: baoOf(initBytes), initLen: initBytes.length, initPath: rel(join(dir, initName)),
    segments: segNames.map((n) => { const b = readFileSync(join(dir, n)); return { kappa: kappaOf(b), bao: baoOf(b), dur: segDur, bytes: b.length, len: b.length, path: rel(join(dir, n)) }; }),
  };
}

// one self-made clip → a {4K60, 1080p60} ladder. src is an ffmpeg lavfi source string (no copyright).
const LADDER = [
  { height: 2160, w: 3840, bitrate: 18000000, level: "5.2" },
  { height: 1080, w: 1920, bitrate: 6000000, level: "4.2" },
];
function buildClip(id, label, src, tone) {
  const work = join(MEDIA, "_work", id); mkdirSync(work, { recursive: true });
  const out = join(MEDIA, id); mkdirSync(out, { recursive: true });
  const SECS = 4, FPS = 60, SEG = 2;
  const reps = [];
  for (const q of LADDER) {
    const mp4 = join(work, `src${q.height}.mp4`);
    // generate (or downscale) a muxed H.264/AAC mp4 at this rung, 60fps, 2s GOP. ultrafast keeps the demo snappy.
    ffmpeg(["-y",
      "-f", "lavfi", "-i", `${src}=size=${q.w}x${q.height}:rate=${FPS}:duration=${SECS}`,
      "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${SECS}`,
      "-vf", `drawtext=text='${label} ${q.height}p${FPS}':x=40:y=40:fontsize=${Math.round(q.height / 18)}:fontcolor=white@0.85:box=1:boxcolor=black@0.4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high", "-level", q.level, "-pix_fmt", "yuv420p",
      "-g", String(SEG * FPS), "-keyint_min", String(SEG * FPS), "-sc_threshold", "0", "-b:v", String(q.bitrate),
      "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", "-shortest", mp4]);
    const repDir = join(out, q.height + "p");
    segment(mp4, repDir, SEG);
    reps.push(sealRendition(repDir, { height: q.height, fps: FPS, bitrate: q.bitrate, segDur: SEG }));
  }
  // poster cover: one frame of the 1080 source, scaled to a tile.
  const cover = join(out, "cover.jpg");
  ffmpeg(["-y", "-i", join(work, "src1080.mp4"), "-frames:v", "1", "-vf", "scale=640:-1", cover]);
  rmrf(work);
  const graph = {
    "@context": { holo: "https://hologram.os/ns#", schema: "http://schema.org/" },
    "@type": "holo:MediaGraph", kind: "video", live: false,
    videos: [{ id, "schema:name": label, "schema:duration": `PT${SECS}S`, representations: reps }],
  };
  graph["holo:segmentClosure"] = mediaGraphClosureKappa(graph);
  return { graph, coverPath: rel(cover), duration: SECS };
}

// demo catalogue: 2 self-made STREAMABLE 4K/60 scenes (test patterns standing in for owned files) + 2 index-only
// metadata scenes (no bytes), with a wide spread of demo tags so the category facets look real.
function genDemo() {
  if (!haveFfmpeg()) throw new Error("ffmpeg not found on PATH");
  rmrf(MEDIA); mkdirSync(MEDIA, { recursive: true });

  const owned = [
    { id: "aurora", label: "Aurora", src: "testsrc2", tone: 432, performers: ["Demo Performer A"], studio: "Holo Studio", date: "2026-01-12", tags: ["4K", "60fps", "Solo", "Cinematic", "Studio"] },
    { id: "velvet", label: "Velvet", src: "smptehdbars", tone: 528, performers: ["Demo Performer B", "Demo Performer C"], studio: "Holo Studio", date: "2026-03-04", tags: ["4K", "60fps", "Couple", "POV", "Studio"] },
  ];
  const scenes = [];
  for (const o of owned) {
    const { graph, coverPath, duration } = buildClip(o.id, o.label, o.src, o.tone);
    scenes.push({ id: o.id, mediaType: "video", title: o.label, performers: o.performers, studio: o.studio, date: o.date, tags: o.tags, cover: coverPath, duration, graph });
  }
  // index-only entries: discovery shows them with a "stream/acquire" affordance; they carry NO bytes (ToS line).
  scenes.push(
    { id: "idx-amber", mediaType: "meta", title: "Amber Tide", performers: ["Demo Performer D"], studio: "Open Catalogue", date: "2025-11-20", tags: ["Vintage", "Amateur", "Outdoor"], cover: null, duration: 1380 },
    { id: "idx-noir", mediaType: "meta", title: "Noir Hours", performers: ["Demo Performer E", "Demo Performer F"], studio: "Open Catalogue", date: "2025-08-02", tags: ["Vintage", "Couple", "Story", "HD"], cover: null, duration: 2100 },
  );

  rmrf(join(MEDIA, "_work"));
  const catalog = { v: 1, generated: "demo", scenes };
  writeFileSync(join(MEDIA, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  const segs = scenes.filter((s) => s.graph).reduce((n, s) => n + s.graph.videos[0].representations.reduce((m, r) => m + 1 + r.segments.length, 0), 0);
  console.log(`✓ catalogue → media/catalog.json`);
  console.log(`  scenes: ${scenes.length} (${scenes.filter((s) => s.graph).length} streamable 4K/60 · ${scenes.filter((s) => !s.graph).length} index-only)  ·  κ-segments: ${segs}`);
  for (const s of scenes.filter((x) => x.graph)) console.log(`  ${s.id}: ${s.graph.videos[0].representations.map((r) => r.height + "p" + r.fps).join(" / ")}  segmentClosure ${s.graph["holo:segmentClosure"].slice(0, 28)}…`);
}

// ── --acquire <url> : the user's own acquisition. yt-dlp resolves the page → avc1≤maxH + m4a → remux (-c copy,
// bit-exact) → fMP4 κ-segments → a one-scene MediaGraph at media/acquired/<id>.mediagraph.json. The user then
// seals it into their collection (holo-xxx-acquire.acquireIntoCollection). The OS does NOT do this for you; this
// runs ONLY when YOU invoke it, with a source YOU are entitled to. HOLO_XXX_CLIP bounds the pull (default 90s).
function genAcquire(url) {
  if (spawnSync(YTDLP, ["--version"], { stdio: "ignore" }).status !== 0) throw new Error("yt-dlp not found (expected tools/bin/yt-dlp.exe or on PATH)");
  if (!haveFfmpeg()) throw new Error("ffmpeg not found on PATH");
  const maxH = parseInt(process.env.HOLO_XXX_MAXH || "2160", 10);
  const clip = parseInt(process.env.HOLO_XXX_CLIP || "90", 10);
  const id = "acq-" + sha256hex(new TextEncoder().encode(url)).slice(0, 12);
  const out = join(MEDIA, "acquired", id); mkdirSync(out, { recursive: true });
  const dl = join(MEDIA, "_dl"); mkdirSync(dl, { recursive: true });
  const mp4 = join(dl, id + ".mp4");
  let title = id, dur = null;
  try { const meta = spawnSync(YTDLP, ["--no-warnings", "--print", "%(title)s\t%(duration)s", url], { encoding: "utf8" }).stdout.trim().split("\t"); title = meta[0] || id; dur = parseInt(meta[1], 10) || null; } catch (_) {}
  const fmt = `bv*[vcodec^=avc1][height<=${maxH}]+ba[acodec^=mp4a]/b[ext=mp4][height<=${maxH}]/b[ext=mp4]`;
  const dlArgs = ["-f", fmt, "--no-warnings", "--merge-output-format", "mp4"];
  if (clip > 0) dlArgs.push("--download-sections", `*0-${clip}`);
  console.log(`acquiring ${title} — ${clip > 0 ? "first " + clip + "s" : "full"} (avc1≤${maxH}p + m4a)…`);
  const r = spawnSync(YTDLP, [...dlArgs, "-o", mp4, url], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0 || !existsSync(mp4)) throw new Error("yt-dlp produced no mp4 for " + url);
  segment(mp4, out, 4);
  const repr = sealRendition(out, { height: maxH, fps: null, bitrate: null, segDur: 4 });
  const graph = { "@context": { holo: "https://hologram.os/ns#", schema: "http://schema.org/" }, "@type": "holo:MediaGraph", kind: "video", live: false,
    videos: [{ id, "schema:name": title, ...(dur ? { "schema:duration": `PT${Math.min(clip || dur, dur)}S` } : {}), representations: [repr] }] };
  graph["holo:segmentClosure"] = mediaGraphClosureKappa(graph);
  rmrf(dl);
  const gpath = join(MEDIA, "acquired", id + ".mediagraph.json");
  writeFileSync(gpath, JSON.stringify(graph, null, 2) + "\n");
  console.log(`✓ acquired → media/acquired/${id}.mediagraph.json  ·  ${repr.segments.length} κ-segments  ·  closure ${graph["holo:segmentClosure"].slice(0, 28)}…`);
  console.log(`next: seal into your collection via holo-xxx-acquire.acquireIntoCollection({ graph, work, collection }), then relock-app.`);
}

const arg = process.argv[2];
try {
  if (arg === "--demo") genDemo();
  else if (arg === "--acquire") { if (!process.argv[3]) throw new Error("usage: --acquire <url>"); genAcquire(process.argv[3]); }
  else { console.error("usage: node holo-xxx-ingest.mjs (--demo | --acquire <url>)"); process.exit(2); }
} catch (e) { console.error("ingest failed:", e.message || e); process.exit(1); }
