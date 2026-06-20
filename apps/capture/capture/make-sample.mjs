#!/usr/bin/env node
// make-sample.mjs — deterministic bundled sample capture for Holo Capture.
//
// Holo Capture's real capture source is the W3C Screen Capture API (getDisplayMedia),
// which needs a user gesture + permission, so it can't run in CI/headless. This emits a
// fixed, content-addressed sample frame (a clean desktop-window mock) that the `?demo=1`
// path loads and the witnesses annotate — proving the full editor → flatten → κ pipeline
// with zero permissions. Pure pixel math (no fonts, no timestamps, no randomness), so the
// PNG re-derives byte-for-byte to one κ on any machine.
//
// Writes capture/sample.png AND re-pins capture/capture-manifest.json together (so the file
// and its pin always match, exactly like hub/make-hub.mjs). Re-run: node capture/make-sample.mjs

import { writeFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const W = 1000, H = 640;
const buf = new Uint8Array(W * H * 3);                 // RGB24

const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 3; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; };
const rect = (x, y, w, h, [r, g, b]) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, r, g, b); };
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// wallpaper — a smooth diagonal gradient (deterministic)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const t = (x + y) / (W + H);
  put(x, y, lerp(18, 88, t), lerp(22, 30, t), lerp(54, 120, t));
}
// a soft vignette glow band
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = (x - W * 0.32) / W, dy = (y - H * 0.28) / H, d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.42) { const o = (y * W + x) * 3, k = (0.42 - d) * 0.5; buf[o] = Math.min(255, buf[o] + 80 * k); buf[o + 1] = Math.min(255, buf[o + 1] + 70 * k); buf[o + 2] = Math.min(255, buf[o + 2] + 60 * k); }
}

// an app window mock, centered
const wx = 150, wy = 120, ww = 700, wh = 420;
rect(wx - 4, wy - 4, ww + 8, wh + 8, [10, 12, 18]);         // window shadow/border
rect(wx, wy, ww, wh, [14, 19, 27]);                          // window body
rect(wx, wy, ww, 44, [22, 28, 38]);                          // title bar
rect(wx + 18, wy + 16, 12, 12, [248, 81, 73]);               // traffic lights
rect(wx + 40, wy + 16, 12, 12, [214, 160, 25]);
rect(wx + 62, wy + 16, 12, 12, [63, 185, 80]);
rect(wx + 120, wy + 18, 320, 9, [60, 70, 84]);               // title text bar
// sidebar
rect(wx, wy + 44, 180, wh - 44, [11, 15, 21]);
for (let i = 0; i < 7; i++) rect(wx + 18, wy + 70 + i * 40, 140, 14, i === 1 ? [70, 110, 220] : [30, 38, 50]);
// content: "code" lines of varying length + a hero card
rect(wx + 200, wy + 66, ww - 224, 120, [10, 14, 20]);        // hero
rect(wx + 220, wy + 86, 240, 20, [70, 110, 220]);
rect(wx + 220, wy + 120, 420, 10, [40, 50, 64]);
rect(wx + 220, wy + 140, 360, 10, [32, 40, 52]);
const cols = [[86, 156, 214], [197, 134, 192], [206, 145, 120], [78, 201, 176], [220, 220, 170]];
for (let i = 0; i < 11; i++) {
  const ly = wy + 210 + i * 18, lx = wx + 210 + (i % 3) * 14;
  const segs = 2 + (i * 7) % 4;
  let sx = lx;
  for (let s = 0; s < segs; s++) { const w = 40 + ((i * 13 + s * 29) % 120); rect(sx, ly, w, 9, cols[(i + s) % cols.length]); sx += w + 16; }
}
// a couple of UI buttons (annotation targets)
rect(wx + 470, wy + 360, 110, 34, [63, 185, 80]);
rect(wx + 590, wy + 360, 110, 34, [40, 50, 64]);

// dock / taskbar
rect(0, H - 56, W, 56, [10, 12, 18]);
for (let i = 0; i < 8; i++) rect(W / 2 - 200 + i * 50, H - 46, 36, 36, [
  [80, 120, 220], [60, 185, 120], [220, 120, 80], [200, 80, 160], [80, 180, 200], [220, 200, 90], [150, 120, 220], [90, 100, 120],
][i]);

// ── encode PNG (color type 2, 8-bit RGB; filter 0 per scanline; deterministic) ──
function png(width, height, rgb) {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1); }
  const idat = deflateSync(Buffer.from(raw), { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const out = png(W, H, buf);
writeFileSync(join(here, "sample.png"), out);
const kappa = "sha256:" + createHash("sha256").update(out).digest("hex");
const manifest = {
  _comment: "Holo Capture κ-manifest (Law L5). The bundled sample frame re-derives to this κ; capture.html?demo=1 and the witnesses verify it before use. Regenerate: node capture/make-sample.mjs",
  algo: "sha256",
  samples: { "capture/sample.png": kappa },
  meta: { "capture/sample.png": { width: W, height: H, type: "image/png" } },
};
writeFileSync(join(here, "capture-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`sample.png  ${W}×${H}  ${out.length} bytes  ${kappa}`);
console.log(`capture/capture-manifest.json re-pinned.`);
