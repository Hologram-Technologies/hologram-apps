#!/usr/bin/env node
// make-tracks.mjs — generate the bundled, content-addressed default playlist.
//
// These are ORIGINAL, royalty-free chiptune tracks synthesized DETERMINISTICALLY
// (no randomness, no external sample) — so they re-derive to a fixed κ on any box
// (Law L5). PCM 16-bit WAV (RIFF/WAVE, the canonical uncompressed audio container),
// which every browser decodes via HTMLMediaElement, and whose square/triangle voices
// give the Winamp spectrum analyzer + oscilloscope something real to draw.
//
// Run:  node winamp/make-tracks.mjs   → writes the .wav files + winamp-manifest.json.
// The witness (winamp-witness.mjs) re-derives each file's sha256 against that manifest.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SR = 44100; // sample rate

// ── note table (equal temperament, A4 = 440) ──────────────────────────────────
const NOTE = (() => {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const t = { rest: 0 };
  for (let oct = 1; oct <= 6; oct++)
    for (let i = 0; i < 12; i++) t[names[i] + oct] = 440 * Math.pow(2, (oct * 12 + i - 57) / 12);
  return t;
})();

// ── voices ────────────────────────────────────────────────────────────────────
const square = (ph) => (ph % 1 < 0.5 ? 1 : -1);
const triangle = (ph) => 2 * Math.abs(2 * (ph % 1) - 1) - 1;

// One monophonic line → Float32 samples, with a short ADSR so notes don't click.
function line(seq, { bpm = 132, voice = square, gain = 0.22 } = {}) {
  const spb = 60 / bpm; // seconds per beat
  const total = seq.reduce((n, [, beats]) => n + Math.round(beats * spb * SR), 0);
  const out = new Float32Array(total);
  let p = 0;
  for (const [note, beats] of seq) {
    const n = Math.round(beats * spb * SR);
    const f = NOTE[note] || 0;
    const a = Math.min(n, (SR * 0.005) | 0), r = Math.min(n, (SR * 0.04) | 0);
    for (let i = 0; i < n; i++) {
      let env = 1;
      if (i < a) env = i / a;
      else if (i > n - r) env = (n - i) / r;
      out[p + i] = f ? voice((f * (p + i)) / SR) * gain * env : 0;
    }
    p += n;
  }
  return out;
}

// Mix several lines (truncating to the shortest) into one master Float32 buffer.
function mix(...lines) {
  const n = Math.min(...lines.map((l) => l.length));
  const out = new Float32Array(n);
  for (const l of lines) for (let i = 0; i < n; i++) out[i] += l[i];
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i])); // hard clip guard
  return out;
}

// Float32 [-1,1] → 16-bit PCM WAV (RIFF/WAVE), mono.
function wav(samples) {
  const n = samples.length, hdr = 44, buf = Buffer.alloc(hdr + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(samples[i] * 32767), hdr + i * 2);
  return buf;
}

// ── the two original tunes ──────────────────────────────────────────────────────
// 1 · "Kappa Groove" — a driving square-bass + triangle-lead arpeggio loop.
const bass = line([
  ["A2", 1], ["A2", 1], ["E2", 1], ["E2", 1], ["F2", 1], ["F2", 1], ["G2", 1], ["G2", 1],
  ["A2", 1], ["A2", 1], ["E2", 1], ["E2", 1], ["F2", 1], ["C3", 1], ["G2", 1], ["G2", 1],
], { voice: square, gain: 0.26 });
const lead = line([
  ["A4", 0.5], ["C5", 0.5], ["E5", 0.5], ["C5", 0.5], ["A4", 0.5], ["C5", 0.5], ["E5", 0.5], ["A5", 0.5],
  ["E5", 0.5], ["B4", 0.5], ["G4", 0.5], ["B4", 0.5], ["E5", 0.5], ["G5", 0.5], ["E5", 0.5], ["B4", 0.5],
  ["F4", 0.5], ["A4", 0.5], ["C5", 0.5], ["A4", 0.5], ["F5", 0.5], ["A5", 0.5], ["F5", 0.5], ["C5", 0.5],
  ["G4", 0.5], ["B4", 0.5], ["D5", 0.5], ["G5", 0.5], ["D5", 0.5], ["B4", 0.5], ["G4", 0.5], ["D4", 0.5],
], { voice: triangle, gain: 0.20 });
const kappaGroove = mix(bass, lead);

// 2 · "Boot Chime" — a calm triangle pad rising arpeggio (the holospace boot sound).
const chime = mix(
  line([
    ["A3", 2], ["E4", 2], ["A4", 2], ["C5", 2], ["E5", 2], ["A5", 4],
  ], { bpm: 96, voice: triangle, gain: 0.24 }),
  line([
    ["A2", 4], ["F2", 4], ["C3", 4], ["E3", 2],
  ], { bpm: 96, voice: square, gain: 0.16 }),
);

const tracks = [
  { file: "kappa-groove.wav", title: "Kappa Groove", artist: "Hologram OS", samples: kappaGroove },
  { file: "boot-chime.wav", title: "Boot Chime", artist: "Hologram OS", samples: chime },
];

const manifest = {};
for (const t of tracks) {
  const buf = wav(t.samples);
  writeFileSync(join(here, t.file), buf);
  manifest[t.file] = "sha256:" + createHash("sha256").update(buf).digest("hex");
  console.log(`${t.file}  ${(buf.length / 1024).toFixed(0)} KB  ${(t.samples.length / SR).toFixed(1)}s  ${manifest[t.file]}`);
}
writeFileSync(join(here, "winamp-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("wrote winamp-manifest.json");
