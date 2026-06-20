// resonator-geometry.js — the Atlas 96 Resonator's structure derivation. Pure + isomorphic
// (browser and Node 20+ via globalThis.crypto.subtle); imported by resonator.html, by the
// receipt generator (gen-atlas96-resonator.mjs) and by the witness, so all three derive the
// SAME bytes from the SAME rule.
//
// The rule — and the whole point (Law L5):
//
//   DNA(p, b) = SHA-256( atlasObjectId ‖ "|phi:" ‖ Φ(p,b) )[0..8)
//
// Every irregular artifact of the fiber structure (jitter, thickness, the holes in the weave)
// is a byte of a content address — a pure function of the sealed Φ-Atlas-12288 object's own
// did:holo and the cell's Φ-code. Zero free parameters, zero RNG, zero "style". Anyone can
// re-derive all 12,288 cells and compare κ(DNA) to the sealed receipt; tamper one byte of the
// object and every cell re-derives differently. The atlas invariants used here are verbatim
// from the vendored upstream (R96 = b % 96 · Φ(p,b) = (p << 8) | b · 48 × 256 = 12,288).

export const PAGES = 48;                      // ℤ₄₈ — verbatim
export const BYTES = 256;                     // ℤ₂₅₆ — verbatim
export const CELLS = PAGES * BYTES;           // 12,288 = 2¹² × 3 — verbatim
export const RCLASSES = 96;                   // R96 — verbatim
export const DNA_STRIDE = 8;                  // bytes of address material per cell
export const DROP_THRESHOLD = 26;             // dna byte < 26 ⇒ a hole in the weave (≈ 26/256)

export const phiEncode = (p, b) => (p << 8) | b;      // Φ(p,b) = (p << 8) | b — verbatim
export const phiPage = (c) => c >> 8;                  // verbatim
export const phiByte = (c) => c & 0xff;                // verbatim
export const classifyByte = (b) => b % 96;             // R96 — verbatim

// Sonification map (presentation, stated openly): the resonance circle ℤ₉₆ → one octave,
// 96 equal divisions (96-EDO). Class c sounds at 220 Hz · 2^(c/96).
export const classFreq = (c) => 220 * Math.pow(2, c / 96);

// ── the derivation: 12,288 individually-addressed cells ─────────────────────────────────────
export async function deriveDNA(atlasId, onProgress) {
  const enc = new TextEncoder();
  const dna = new Uint8Array(CELLS * DNA_STRIDE);
  const CHUNK = 512;
  for (let start = 0; start < CELLS; start += CHUNK) {
    const end = Math.min(CELLS, start + CHUNK);
    await Promise.all(Array.from({ length: end - start }, (_, k) => {
      const i = start + k;                               // i IS the Φ-code: Φ(p,b) = p·256 + b
      return globalThis.crypto.subtle.digest("SHA-256", enc.encode(atlasId + "|phi:" + i))
        .then((d) => dna.set(new Uint8Array(d).subarray(0, DNA_STRIDE), i * DNA_STRIDE));
    }));
    if (onProgress) onProgress(end / CELLS);
  }
  return dna;
}

// DNA layout per cell: [0..2] jitter xyz (signed, −128..127) · [3] fiber thickness ·
// [4] shimmer phase · [5] east-edge hole gate · [6] south-edge hole gate · [7] warmth tweak.

// ── the weave: torus-grid edges, holes decided by the address bytes ──────────────────────────
export function buildEdges(dna) {
  const render = [];                                     // structural fibers (drawn + simulated)
  const shear = [];                                      // diagonal stabilizers (simulated only)
  for (let i = 0; i < CELLS; i++) {
    const p = i >> 8, b = i & 0xff, o = i * DNA_STRIDE;
    if (dna[o + 5] >= DROP_THRESHOLD) render.push(i, (p << 8) | ((b + 1) & 0xff));        // east, wraps ℤ₂₅₆
    if (dna[o + 6] >= DROP_THRESHOLD) render.push(i, (((p + 1) % PAGES) << 8) | b);        // south, wraps ℤ₄₈
    shear.push(i, (((p + 1) % PAGES) << 8) | ((b + 1) & 0xff));
  }
  return { render: new Uint32Array(render), shear: new Uint32Array(shear) };
}

// ── projections of T² = ℤ₄₈ × ℤ₂₅₆ into 1D · 2D · 3D · 4D ──────────────────────────────────
// 1D: the boundary as one 12,288-cell cycle (Φ-code order — the canonical linear order).
// 2D: the 48×256 page-byte sheet.
// 3D: the embedded torus (byte → major circle, page → minor circle).
// 4D: the CLIFFORD torus — the flat torus on S³ ⊂ ℝ⁴ where BOTH cycles are perfect circles
//     (arguably T²'s true home), double-rotated in the (x,w) and (y,z) planes, then
//     stereographically projected to 3D.
const TAU = Math.PI * 2;
export const JITTER_AMP = 2.6;                           // px of world per 127 units of address byte
export const TORUS_R = 152, TORUS_r = 60;
export const RING_R = 300, SHEET_SX = 2.2, SHEET_SZ = 6.0;
export const CLIFF_D = 1.25, CLIFF_S = 170;

export function makeProjector(dna) {
  const cosB = new Float32Array(BYTES), sinB = new Float32Array(BYTES);
  const cosP = new Float32Array(PAGES), sinP = new Float32Array(PAGES);
  for (let b = 0; b < BYTES; b++) { cosB[b] = Math.cos(TAU * b / BYTES); sinB[b] = Math.sin(TAU * b / BYTES); }
  for (let p = 0; p < PAGES; p++) { cosP[p] = Math.cos(TAU * p / PAGES); sinP[p] = Math.sin(TAU * p / PAGES); }
  const cosI = new Float32Array(CELLS), sinI = new Float32Array(CELLS);
  for (let i = 0; i < CELLS; i++) { cosI[i] = Math.cos(TAU * i / CELLS); sinI[i] = Math.sin(TAU * i / CELLS); }

  // write one pure dimension into out[3i..]
  function dim1(out, i) { out[i * 3] = cosI[i] * RING_R; out[i * 3 + 1] = 0; out[i * 3 + 2] = sinI[i] * RING_R; }
  function dim2(out, i) { const p = i >> 8, b = i & 0xff;
    out[i * 3] = (b - (BYTES - 1) / 2) * SHEET_SX; out[i * 3 + 1] = 0; out[i * 3 + 2] = (p - (PAGES - 1) / 2) * SHEET_SZ; }
  function dim3(out, i) { const p = i >> 8, b = i & 0xff, w = TORUS_R + TORUS_r * cosP[p];
    out[i * 3] = w * cosB[b]; out[i * 3 + 1] = TORUS_r * sinP[p]; out[i * 3 + 2] = w * sinB[b]; }
  function dim4(out, i, c1, s1, c2, s2) { const p = i >> 8, b = i & 0xff, q = Math.SQRT1_2;
    let x = cosB[b] * q, y = sinB[b] * q, z = cosP[p] * q, w = sinP[p] * q;
    const x2 = x * c1 - w * s1, w2 = x * s1 + w * c1;     // rotate (x,w) plane
    const y2 = y * c2 - z * s2, z2 = y * s2 + z * c2;     // rotate (y,z) plane
    const k = CLIFF_S / (CLIFF_D - w2);                   // stereographic, pole outside S³
    out[i * 3] = x2 * k; out[i * 3 + 1] = y2 * k; out[i * 3 + 2] = z2 * k; }

  const DIMS = [dim1, dim2, dim3, dim4];
  const scratch = new Float32Array(CELLS * 3);

  // rest positions for a continuous dim ∈ [1,4]; a1/a2 = the 4D double-rotation angles.
  // withJitter=false gives the IDEAL parametric surface (the ghost the proof panel compares against).
  return function restInto(out, dim, a1 = 0, a2 = 0, withJitter = true) {
    const d = Math.min(4, Math.max(1, dim));
    const k0 = Math.min(3, Math.floor(d) - 1), f0 = d - 1 - k0;
    const f = f0 <= 0 ? 0 : f0 * f0 * (3 - 2 * f0);       // smoothstep between adjacent dims
    const c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2);
    const A = DIMS[k0], B = DIMS[Math.min(3, k0 + 1)];
    for (let i = 0; i < CELLS; i++) {
      A === dim4 ? A(out, i, c1, s1, c2, s2) : A(out, i);
      if (f > 0) {
        B === dim4 ? B(scratch, i, c1, s1, c2, s2) : B(scratch, i);
        out[i * 3] += (scratch[i * 3] - out[i * 3]) * f;
        out[i * 3 + 1] += (scratch[i * 3 + 1] - out[i * 3 + 1]) * f;
        out[i * 3 + 2] += (scratch[i * 3 + 2] - out[i * 3 + 2]) * f;
      }
      if (withJitter) {
        const o = i * DNA_STRIDE;
        out[i * 3] += (dna[o] - 128) / 127 * JITTER_AMP;
        out[i * 3 + 1] += (dna[o + 1] - 128) / 127 * JITTER_AMP;
        out[i * 3 + 2] += (dna[o + 2] - 128) / 127 * JITTER_AMP;
      }
    }
  };
}
