// resonator-detail.js — fiber-level detail, read (not invented) from the sealed structure.
//
// The Resonator's receipt seals 8 DNA bytes per cell: DNA(p,b) = SHA-256(κ ‖ Φ(p,b))[0..8).
// The base geometry consumes bytes 0–4 (jitter xyz · thickness · phase) and uses bytes 5–6 only
// as one-bit hole gates. The REMAINING ENTROPY of bytes 5, 6, 7 is sealed but unread — so the
// fiber curvature below costs ZERO new derivation and stays byte-covered by the existing
// receipt: each fiber (a,b) is subdivided into 4 segments through 3 interior control points,
// whose perpendicular offsets are bytes 5,6,7 of endpoint a (one normal) and of endpoint b
// (the other normal), windowed by sin(πt) so fibers stay pinned to their cells. The address
// already contains the detail; at this tier we simply read more of it.
//
// Bytes 5 and 6 belong to edges that SURVIVED the hole gate, so their values lie in
// [DROP_THRESHOLD, 255] — they are normalized over that range (stated, not hidden).

import { DNA_STRIDE, DROP_THRESHOLD } from "./resonator-geometry.js";

export const SUBDIV = 4;                                   // segments per fiber
export const CURL_AMP = 1.25;                              // world units of sag (spacing ≈ 3.7)

// per-endpoint control values from the sealed bytes (3 per cell)
function ctl(dna, cell, k) {                                // k = 0,1,2 ← bytes 5,6,7
  const v = dna[cell * DNA_STRIDE + 5 + k];
  if (k < 2) return (v - (DROP_THRESHOLD + 255) / 2) / ((255 - DROP_THRESHOLD) / 2);  // survivor range
  return (v - 128) / 127;
}

// rest positions + edges + dna → curved-fiber segment soup.
// returns { segs: Float32Array(E·SUBDIV·6), parent: Uint32Array(E·SUBDIV) }
export function buildFiberGeometry(rest, edges, dna) {
  const E = edges.length / 2;
  const segs = new Float32Array(E * SUBDIV * 6);
  const parent = new Uint32Array(E * SUBDIV);
  const P = new Float32Array((SUBDIV + 1) * 3);
  for (let e = 0; e < E; e++) {
    const a = edges[e * 2], b = edges[e * 2 + 1];
    const ax = rest[a * 3], ay = rest[a * 3 + 1], az = rest[a * 3 + 2];
    const bx = rest[b * 3], by = rest[b * 3 + 1], bz = rest[b * 3 + 2];
    // orthonormal frame around the fiber
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dy, dz) || 1e-6; dx /= L; dy /= L; dz /= L;
    let n1x = -dz, n1y = 0, n1z = dx;                       // d × ŷ
    const n1l = Math.hypot(n1x, n1y, n1z);
    if (n1l < 1e-4) { n1x = 1; n1y = 0; n1z = 0; } else { n1x /= n1l; n1z /= n1l; }
    const n2x = dy * n1z - dz * n1y, n2y = dz * n1x - dx * n1z, n2z = dx * n1y - dy * n1x;
    // the polyline: ends pinned to the cells, interior points offset by the sealed bytes
    P[0] = ax; P[1] = ay; P[2] = az;
    P[SUBDIV * 3] = bx; P[SUBDIV * 3 + 1] = by; P[SUBDIV * 3 + 2] = bz;
    for (let k = 1; k < SUBDIV; k++) {
      const t = k / SUBDIV, w = Math.sin(Math.PI * t) * CURL_AMP;
      const u = ctl(dna, a, k - 1) * w, v = ctl(dna, b, k - 1) * w;
      P[k * 3] = ax + (bx - ax) * t + n1x * u + n2x * v;
      P[k * 3 + 1] = ay + (by - ay) * t + n1y * u + n2y * v;
      P[k * 3 + 2] = az + (bz - az) * t + n1z * u + n2z * v;
    }
    for (let s = 0; s < SUBDIV; s++) {
      const o = (e * SUBDIV + s) * 6;
      segs[o] = P[s * 3]; segs[o + 1] = P[s * 3 + 1]; segs[o + 2] = P[s * 3 + 2];
      segs[o + 3] = P[s * 3 + 3]; segs[o + 4] = P[s * 3 + 4]; segs[o + 5] = P[s * 3 + 5];
      parent[e * SUBDIV + s] = e;
    }
  }
  return { segs, parent };
}
