// resonator-spectrum.js — the ATLAS sound→light map, rooted end to end. Nothing here is
// invented; every step is either already sealed in this holospace or published physics:
//
//   1. R96[c] ≙ f(c) = base · 2^(c/96) Hz        — the sonification map this holospace already
//                                                  seals (resonator-geometry.js: ℤ₉₆ → 96-EDO).
//   2. The visible band is one octave of light:   400–800 THz (750–375 nm). So octave
//      equivalence — the same identification that makes ℤ₉₆ a pitch-class CIRCLE — gives every
//      class a UNIQUE representative in visible light: f · 2^k ∈ [400, 800) THz.
//   3. Light frequency → wavelength:               λ = c / f  (c = 299,792,458 m/s exactly, SI).
//   4. Wavelength → color:                         CIE 1931 standard observer (the multi-lobe
//      Gaussian fits of Wyman, Sloan & Shirley 2013, JCGT 2:2) → XYZ → linear sRGB
//      (IEC 61966-2-1 matrix, D65) → sRGB transfer curve.
//
// The ONE free parameter that honestly exists is the tuning of class 0 (the base pitch); it
// rotates the spectrum around the visible octave — the single degree of freedom of a circle
// isomorphism. Per-class luminance is normalized for display (stated, not hidden: hue is
// physics; a screen cannot emit single-wavelength light at equal brightness).

export const C_LIGHT = 299792458;                  // m/s, exact (SI definition)
export const VISIBLE_LO = 400e12;                  // Hz — the visible octave [400, 800) THz
export const VISIBLE_HI = 800e12;

// 1+2: class → its unique octave-equivalent visible-light frequency (Hz)
export function lightFreq(c, baseHz = 220) {
  let f = baseHz * Math.pow(2, c / 96);
  while (f < VISIBLE_LO) f *= 2;
  while (f >= VISIBLE_HI) f /= 2;
  return f;
}
// 3: light frequency → wavelength in nm
export const wavelengthNm = (lightHz) => (C_LIGHT / lightHz) * 1e9;

// 4a: CIE 1931 2° standard observer — piecewise-Gaussian fits (Wyman/Sloan/Shirley 2013, table 3)
const g = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
const cieX = (l) => 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
const cieY = (l) => 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
const cieZ = (l) => 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);

// 4b: XYZ → linear sRGB (IEC 61966-2-1, D65) → gamma; out-of-gamut spectral colors clip at 0,
// then the class is normalized to unit peak (display luminance normalization, see header).
const srgb = (u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
export function spectralRGB(nm) {
  const X = cieX(nm), Y = cieY(nm), Z = cieZ(nm);
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  r = Math.max(0, r); gg = Math.max(0, gg); b = Math.max(0, b);
  const m = Math.max(r, gg, b, 1e-9);
  return [srgb(r / m), srgb(gg / m), srgb(b / m)];
}

// the whole chain: resonance class → sRGB (plus the intermediate facts, for display)
export function classColor(c, baseHz = 220) {
  const audioHz = baseHz * Math.pow(2, c / 96);
  const fL = lightFreq(c, baseHz);
  const nm = wavelengthNm(fL);
  return { rgb: spectralRGB(nm), audioHz, thz: fL / 1e12, nm };
}
