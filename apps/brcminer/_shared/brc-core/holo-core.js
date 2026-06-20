const ze = "0123456789abcdef";
function k(t) {
  let e = "";
  for (let r = 0; r < t.length; r++) {
    const n = t[r];
    e += ze[n >>> 4] + ze[n & 15];
  }
  return e;
}
function Er(t) {
  if (t.startsWith("0x") && (t = t.slice(2)), t.length % 2 !== 0) throw new Error("invalid hex length");
  const e = new Uint8Array(t.length / 2);
  for (let r = 0; r < e.length; r++) {
    const n = parseInt(t.slice(r * 2, r * 2 + 2), 16);
    if (Number.isNaN(n)) throw new Error("invalid hex char");
    e[r] = n;
  }
  return e;
}
function Et(...t) {
  let e = 0;
  for (const o of t) e += o.length;
  const r = new Uint8Array(e);
  let n = 0;
  for (const o of t)
    r.set(o, n), n += o.length;
  return r;
}
function it(t) {
  const e = new Uint8Array(4);
  return e[0] = t >>> 24 & 255, e[1] = t >>> 16 & 255, e[2] = t >>> 8 & 255, e[3] = t & 255, e;
}
function It(t, e) {
  return (t[e] << 24 | t[e + 1] << 16 | t[e + 2] << 8 | t[e + 3]) >>> 0;
}
function _t(t) {
  const e = new Uint8Array(8);
  for (let r = 7; r >= 0; r--)
    e[r] = Number(t & 0xffn), t >>= 8n;
  return e;
}
function Se(t, e) {
  let r = 0n;
  for (let n = 0; n < 8; n++) r = r << 8n | BigInt(t[e + n]);
  return r;
}
function mt(t) {
  const e = t >>> 24 & 255, r = BigInt(t & 16777215);
  return e <= 3 ? r >> BigInt(8 * (3 - e)) : r << BigInt(8 * (e - 3));
}
function Xe(t) {
  if (t <= 0n) return 0;
  let e = 0, r = t;
  for (; r > 0xffffffn; )
    r >>= 8n, e++;
  let n = Number(r);
  return e += 3, n & 8388608 && (n >>= 8, e += 1), (e & 255) << 24 | n & 16777215;
}
function Ze(t, e) {
  const r = Math.min(t.length, e.length);
  for (let n = 0; n < r; n++)
    if (t[n] !== e[n]) return t[n] < e[n] ? -1 : 1;
  return t.length - e.length;
}
function Cr(t, e) {
  let r = 0n;
  for (let n = 0; n < t.length; n++) r = r << 8n | BigInt(t[n]);
  return r < e;
}
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function wr(t) {
  return t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array";
}
function Fe(t, ...e) {
  if (!wr(t))
    throw new Error("Uint8Array expected");
  if (e.length > 0 && !e.includes(t.length))
    throw new Error("Uint8Array expected of length " + e + ", got length=" + t.length);
}
function We(t, e = !0) {
  if (t.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (e && t.finished)
    throw new Error("Hash#digest() has already been called");
}
function Qr(t, e) {
  Fe(t);
  const r = e.outputLen;
  if (t.length < r)
    throw new Error("digestInto() expects output buffer of length at least " + r);
}
function bt(...t) {
  for (let e = 0; e < t.length; e++)
    t[e].fill(0);
}
function $t(t) {
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
}
function K(t, e) {
  return t << 32 - e | t >>> e;
}
function yr(t) {
  if (typeof t != "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(t));
}
function Jn(t) {
  return typeof t == "string" && (t = yr(t)), Fe(t), t;
}
class br {
}
function Yn(t) {
  const e = (n) => t().update(Jn(n)).digest(), r = t();
  return e.outputLen = r.outputLen, e.blockLen = r.blockLen, e.create = () => t(), e;
}
function pr(t, e, r, n) {
  if (typeof t.setBigUint64 == "function")
    return t.setBigUint64(e, r, n);
  const o = BigInt(32), i = BigInt(4294967295), s = Number(r >> o & i), c = Number(r & i), A = n ? 4 : 0, f = n ? 0 : 4;
  t.setUint32(e + A, s, n), t.setUint32(e + f, c, n);
}
function Dr(t, e, r) {
  return t & e ^ ~t & r;
}
function mr(t, e, r) {
  return t & e ^ t & r ^ e & r;
}
class On extends br {
  constructor(e, r, n, o) {
    super(), this.finished = !1, this.length = 0, this.pos = 0, this.destroyed = !1, this.blockLen = e, this.outputLen = r, this.padOffset = n, this.isLE = o, this.buffer = new Uint8Array(e), this.view = $t(this.buffer);
  }
  update(e) {
    We(this), e = Jn(e), Fe(e);
    const { view: r, buffer: n, blockLen: o } = this, i = e.length;
    for (let s = 0; s < i; ) {
      const c = Math.min(o - this.pos, i - s);
      if (c === o) {
        const A = $t(e);
        for (; o <= i - s; s += o)
          this.process(A, s);
        continue;
      }
      n.set(e.subarray(s, s + c), this.pos), this.pos += c, s += c, this.pos === o && (this.process(r, 0), this.pos = 0);
    }
    return this.length += e.length, this.roundClean(), this;
  }
  digestInto(e) {
    We(this), Qr(e, this), this.finished = !0;
    const { buffer: r, view: n, blockLen: o, isLE: i } = this;
    let { pos: s } = this;
    r[s++] = 128, bt(this.buffer.subarray(s)), this.padOffset > o - s && (this.process(n, 0), s = 0);
    for (let a = s; a < o; a++)
      r[a] = 0;
    pr(n, o - 8, BigInt(this.length * 8), i), this.process(n, 0);
    const c = $t(e), A = this.outputLen;
    if (A % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const f = A / 4, g = this.get();
    if (f > g.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let a = 0; a < f; a++)
      c.setUint32(4 * a, g[a], i);
  }
  digest() {
    const { buffer: e, outputLen: r } = this;
    this.digestInto(e);
    const n = e.slice(0, r);
    return this.destroy(), n;
  }
  _cloneInto(e) {
    e || (e = new this.constructor()), e.set(...this.get());
    const { blockLen: r, buffer: n, length: o, finished: i, destroyed: s, pos: c } = this;
    return e.destroyed = s, e.finished = i, e.length = o, e.pos = c, o % r && e.buffer.set(n), e;
  }
  clone() {
    return this._cloneInto();
  }
}
const W = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), F = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]), xt = /* @__PURE__ */ BigInt(2 ** 32 - 1), je = /* @__PURE__ */ BigInt(32);
function Sr(t, e = !1) {
  return e ? { h: Number(t & xt), l: Number(t >> je & xt) } : { h: Number(t >> je & xt) | 0, l: Number(t & xt) | 0 };
}
function Mr(t, e = !1) {
  const r = t.length;
  let n = new Uint32Array(r), o = new Uint32Array(r);
  for (let i = 0; i < r; i++) {
    const { h: s, l: c } = Sr(t[i], e);
    [n[i], o[i]] = [s, c];
  }
  return [n, o];
}
const $e = (t, e, r) => t >>> r, tn = (t, e, r) => t << 32 - r | e >>> r, gt = (t, e, r) => t >>> r | e << 32 - r, ut = (t, e, r) => t << 32 - r | e >>> r, Nt = (t, e, r) => t << 64 - r | e >>> r - 32, kt = (t, e, r) => t >>> r - 32 | e << 64 - r;
function V(t, e, r, n) {
  const o = (e >>> 0) + (n >>> 0);
  return { h: t + r + (o / 2 ** 32 | 0) | 0, l: o | 0 };
}
const Rr = (t, e, r) => (t >>> 0) + (e >>> 0) + (r >>> 0), xr = (t, e, r, n) => e + r + n + (t / 2 ** 32 | 0) | 0, Nr = (t, e, r, n) => (t >>> 0) + (e >>> 0) + (r >>> 0) + (n >>> 0), kr = (t, e, r, n, o) => e + r + n + o + (t / 2 ** 32 | 0) | 0, Fr = (t, e, r, n, o) => (t >>> 0) + (e >>> 0) + (r >>> 0) + (n >>> 0) + (o >>> 0), Ur = (t, e, r, n, o, i) => e + r + n + o + i + (t / 2 ** 32 | 0) | 0, Hr = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]), j = /* @__PURE__ */ new Uint32Array(64);
class Lr extends On {
  constructor(e = 32) {
    super(64, e, 8, !1), this.A = W[0] | 0, this.B = W[1] | 0, this.C = W[2] | 0, this.D = W[3] | 0, this.E = W[4] | 0, this.F = W[5] | 0, this.G = W[6] | 0, this.H = W[7] | 0;
  }
  get() {
    const { A: e, B: r, C: n, D: o, E: i, F: s, G: c, H: A } = this;
    return [e, r, n, o, i, s, c, A];
  }
  // prettier-ignore
  set(e, r, n, o, i, s, c, A) {
    this.A = e | 0, this.B = r | 0, this.C = n | 0, this.D = o | 0, this.E = i | 0, this.F = s | 0, this.G = c | 0, this.H = A | 0;
  }
  process(e, r) {
    for (let a = 0; a < 16; a++, r += 4)
      j[a] = e.getUint32(r, !1);
    for (let a = 16; a < 64; a++) {
      const u = j[a - 15], l = j[a - 2], d = K(u, 7) ^ K(u, 18) ^ u >>> 3, w = K(l, 17) ^ K(l, 19) ^ l >>> 10;
      j[a] = w + j[a - 7] + d + j[a - 16] | 0;
    }
    let { A: n, B: o, C: i, D: s, E: c, F: A, G: f, H: g } = this;
    for (let a = 0; a < 64; a++) {
      const u = K(c, 6) ^ K(c, 11) ^ K(c, 25), l = g + u + Dr(c, A, f) + Hr[a] + j[a] | 0, w = (K(n, 2) ^ K(n, 13) ^ K(n, 22)) + mr(n, o, i) | 0;
      g = f, f = A, A = c, c = s + l | 0, s = i, i = o, o = n, n = l + w | 0;
    }
    n = n + this.A | 0, o = o + this.B | 0, i = i + this.C | 0, s = s + this.D | 0, c = c + this.E | 0, A = A + this.F | 0, f = f + this.G | 0, g = g + this.H | 0, this.set(n, o, i, s, c, A, f, g);
  }
  roundClean() {
    bt(j);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), bt(this.buffer);
  }
}
const qn = Mr([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((t) => BigInt(t))), Tr = qn[0], Pr = qn[1], $ = /* @__PURE__ */ new Uint32Array(80), tt = /* @__PURE__ */ new Uint32Array(80);
class Gr extends On {
  constructor(e = 64) {
    super(128, e, 16, !1), this.Ah = F[0] | 0, this.Al = F[1] | 0, this.Bh = F[2] | 0, this.Bl = F[3] | 0, this.Ch = F[4] | 0, this.Cl = F[5] | 0, this.Dh = F[6] | 0, this.Dl = F[7] | 0, this.Eh = F[8] | 0, this.El = F[9] | 0, this.Fh = F[10] | 0, this.Fl = F[11] | 0, this.Gh = F[12] | 0, this.Gl = F[13] | 0, this.Hh = F[14] | 0, this.Hl = F[15] | 0;
  }
  // prettier-ignore
  get() {
    const { Ah: e, Al: r, Bh: n, Bl: o, Ch: i, Cl: s, Dh: c, Dl: A, Eh: f, El: g, Fh: a, Fl: u, Gh: l, Gl: d, Hh: w, Hl: x } = this;
    return [e, r, n, o, i, s, c, A, f, g, a, u, l, d, w, x];
  }
  // prettier-ignore
  set(e, r, n, o, i, s, c, A, f, g, a, u, l, d, w, x) {
    this.Ah = e | 0, this.Al = r | 0, this.Bh = n | 0, this.Bl = o | 0, this.Ch = i | 0, this.Cl = s | 0, this.Dh = c | 0, this.Dl = A | 0, this.Eh = f | 0, this.El = g | 0, this.Fh = a | 0, this.Fl = u | 0, this.Gh = l | 0, this.Gl = d | 0, this.Hh = w | 0, this.Hl = x | 0;
  }
  process(e, r) {
    for (let h = 0; h < 16; h++, r += 4)
      $[h] = e.getUint32(r), tt[h] = e.getUint32(r += 4);
    for (let h = 16; h < 80; h++) {
      const E = $[h - 15] | 0, N = tt[h - 15] | 0, Q = gt(E, N, 1) ^ gt(E, N, 8) ^ $e(E, N, 7), m = ut(E, N, 1) ^ ut(E, N, 8) ^ tn(E, N, 7), p = $[h - 2] | 0, C = tt[h - 2] | 0, I = gt(p, C, 19) ^ Nt(p, C, 61) ^ $e(p, C, 6), B = ut(p, C, 19) ^ kt(p, C, 61) ^ tn(p, C, 6), S = Nr(m, B, tt[h - 7], tt[h - 16]), y = kr(S, Q, I, $[h - 7], $[h - 16]);
      $[h] = y | 0, tt[h] = S | 0;
    }
    let { Ah: n, Al: o, Bh: i, Bl: s, Ch: c, Cl: A, Dh: f, Dl: g, Eh: a, El: u, Fh: l, Fl: d, Gh: w, Gl: x, Hh: D, Hl: M } = this;
    for (let h = 0; h < 80; h++) {
      const E = gt(a, u, 14) ^ gt(a, u, 18) ^ Nt(a, u, 41), N = ut(a, u, 14) ^ ut(a, u, 18) ^ kt(a, u, 41), Q = a & l ^ ~a & w, m = u & d ^ ~u & x, p = Fr(M, N, m, Pr[h], tt[h]), C = Ur(p, D, E, Q, Tr[h], $[h]), I = p | 0, B = gt(n, o, 28) ^ Nt(n, o, 34) ^ Nt(n, o, 39), S = ut(n, o, 28) ^ kt(n, o, 34) ^ kt(n, o, 39), y = n & i ^ n & c ^ i & c, R = o & s ^ o & A ^ s & A;
      D = w | 0, M = x | 0, w = l | 0, x = d | 0, l = a | 0, d = u | 0, { h: a, l: u } = V(f | 0, g | 0, C | 0, I | 0), f = c | 0, g = A | 0, c = i | 0, A = s | 0, i = n | 0, s = o | 0;
      const P = Rr(I, S, R);
      n = xr(P, C, B, y), o = P | 0;
    }
    ({ h: n, l: o } = V(this.Ah | 0, this.Al | 0, n | 0, o | 0)), { h: i, l: s } = V(this.Bh | 0, this.Bl | 0, i | 0, s | 0), { h: c, l: A } = V(this.Ch | 0, this.Cl | 0, c | 0, A | 0), { h: f, l: g } = V(this.Dh | 0, this.Dl | 0, f | 0, g | 0), { h: a, l: u } = V(this.Eh | 0, this.El | 0, a | 0, u | 0), { h: l, l: d } = V(this.Fh | 0, this.Fl | 0, l | 0, d | 0), { h: w, l: x } = V(this.Gh | 0, this.Gl | 0, w | 0, x | 0), { h: D, l: M } = V(this.Hh | 0, this.Hl | 0, D | 0, M | 0), this.set(n, o, i, s, c, A, f, g, a, u, l, d, w, x, D, M);
  }
  roundClean() {
    bt($, tt);
  }
  destroy() {
    bt(this.buffer), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}
const _r = /* @__PURE__ */ Yn(() => new Lr()), Kr = /* @__PURE__ */ Yn(() => new Gr());
function Bt(t) {
  return _r(t);
}
function Vn(t) {
  if (t.length === 0) return new Uint8Array(32);
  if (t.length === 1) return Bt(t[0]);
  let e = t.map((r) => Bt(r));
  for (; e.length > 1; ) {
    const r = [];
    for (let n = 0; n < e.length; n += 2) {
      const o = e[n], i = n + 1 < e.length ? e[n + 1] : e[n];
      r.push(Bt(Et(o, i)));
    }
    e = r;
  }
  return e[0];
}
/*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
const vr = {
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
}, { p: H, n: Tt, Gx: en, Gy: nn, a: te, d: ee } = vr, Jr = 8n, Y = 32, pt = 64, G = (t = "") => {
  throw new Error(t);
}, Yr = (t) => typeof t == "bigint", zn = (t) => typeof t == "string", Or = (t) => t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array", At = (t, e) => !Or(t) || typeof e == "number" && e > 0 && t.length !== e ? G("Uint8Array expected") : t, qt = (t) => new Uint8Array(t), Ue = (t) => Uint8Array.from(t), Xn = (t, e) => t.toString(16).padStart(e, "0"), He = (t) => Array.from(At(t)).map((e) => Xn(e, 2)).join(""), z = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 }, rn = (t) => {
  if (t >= z._0 && t <= z._9)
    return t - z._0;
  if (t >= z.A && t <= z.F)
    return t - (z.A - 10);
  if (t >= z.a && t <= z.f)
    return t - (z.a - 10);
}, Le = (t) => {
  const e = "hex invalid";
  if (!zn(t))
    return G(e);
  const r = t.length, n = r / 2;
  if (r % 2)
    return G(e);
  const o = qt(n);
  for (let i = 0, s = 0; i < n; i++, s += 2) {
    const c = rn(t.charCodeAt(s)), A = rn(t.charCodeAt(s + 1));
    if (c === void 0 || A === void 0)
      return G(e);
    o[i] = c * 16 + A;
  }
  return o;
}, st = (t, e) => At(zn(t) ? Le(t) : Ue(At(t)), e), Zn = () => globalThis?.crypto, qr = () => Zn()?.subtle ?? G("crypto.subtle must be defined"), Dt = (...t) => {
  const e = qt(t.reduce((n, o) => n + At(o).length, 0));
  let r = 0;
  return t.forEach((n) => {
    e.set(n, r), r += n.length;
  }), e;
}, Wn = (t = Y) => Zn().getRandomValues(qt(t)), Kt = BigInt, ot = (t, e, r, n = "bad number: out of range") => Yr(t) && e <= t && t < r ? t : G(n), b = (t, e = H) => {
  const r = t % e;
  return r >= 0n ? r : e + r;
}, jn = (t) => b(t, Tt), $n = (t, e) => {
  (t === 0n || e <= 0n) && G("no inverse n=" + t + " mod=" + e);
  let r = b(t, e), n = e, o = 0n, i = 1n;
  for (; r !== 0n; ) {
    const s = n / r, c = n % r, A = o - i * s;
    n = r, r = c, o = i, i = A;
  }
  return n === 1n ? b(o, e) : G("no inverse");
}, Vr = (t) => {
  const e = Jt[t];
  return typeof e != "function" && G("hashes." + t + " not set"), e;
}, on = (t) => t instanceof T ? t : G("Point expected"), Me = 2n ** 256n;
class T {
  static BASE;
  static ZERO;
  ex;
  ey;
  ez;
  et;
  constructor(e, r, n, o) {
    const i = Me;
    this.ex = ot(e, 0n, i), this.ey = ot(r, 0n, i), this.ez = ot(n, 1n, i), this.et = ot(o, 0n, i), Object.freeze(this);
  }
  static fromAffine(e) {
    return new T(e.x, e.y, 1n, b(e.x * e.y));
  }
  /** RFC8032 5.1.3: Uint8Array to Point. */
  static fromBytes(e, r = !1) {
    const n = ee, o = Ue(At(e, Y)), i = e[31];
    o[31] = i & -129;
    const s = Te(o);
    ot(s, 0n, r ? Me : H);
    const A = b(s * s), f = b(A - 1n), g = b(n * A + 1n);
    let { isValid: a, value: u } = Xr(f, g);
    a || G("bad point: y not sqrt");
    const l = (u & 1n) === 1n, d = (i & 128) !== 0;
    return !r && u === 0n && d && G("bad point: x==0, isLastByteOdd"), d !== l && (u = b(-u)), new T(u, s, 1n, b(u * s));
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const e = te, r = ee, n = this;
    if (n.is0())
      throw new Error("bad point: ZERO");
    const { ex: o, ey: i, ez: s, et: c } = n, A = b(o * o), f = b(i * i), g = b(s * s), a = b(g * g), u = b(A * e), l = b(g * b(u + f)), d = b(a + b(r * b(A * f)));
    if (l !== d)
      throw new Error("bad point: equation left != right (1)");
    const w = b(o * i), x = b(s * c);
    if (w !== x)
      throw new Error("bad point: equation left != right (2)");
    return this;
  }
  /** Equality check: compare points P&Q. */
  equals(e) {
    const { ex: r, ey: n, ez: o } = this, { ex: i, ey: s, ez: c } = on(e), A = b(r * c), f = b(i * o), g = b(n * c), a = b(s * o);
    return A === f && g === a;
  }
  is0() {
    return this.equals(dt);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new T(b(-this.ex), this.ey, this.ez, b(-this.et));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { ex: e, ey: r, ez: n } = this, o = te, i = b(e * e), s = b(r * r), c = b(2n * b(n * n)), A = b(o * i), f = e + r, g = b(b(f * f) - i - s), a = A + s, u = a - c, l = A - s, d = b(g * u), w = b(a * l), x = b(g * l), D = b(u * a);
    return new T(d, w, D, x);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(e) {
    const { ex: r, ey: n, ez: o, et: i } = this, { ex: s, ey: c, ez: A, et: f } = on(e), g = te, a = ee, u = b(r * s), l = b(n * c), d = b(i * a * f), w = b(o * A), x = b((r + n) * (s + c) - u - l), D = b(w - d), M = b(w + d), h = b(l - g * u), E = b(x * D), N = b(M * h), Q = b(x * h), m = b(D * M);
    return new T(E, N, m, Q);
  }
  /**
   * Point-by-scalar multiplication. Scalar must be in range 1 <= n < CURVE.n.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n scalar by which point is multiplied
   * @param safe safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(e, r = !0) {
    if (!r && (e === 0n || this.is0()))
      return dt;
    if (ot(e, 1n, Tt), e === 1n)
      return this;
    if (this.equals(Z))
      return io(e).p;
    let n = dt, o = Z;
    for (let i = this; e > 0n; i = i.double(), e >>= 1n)
      e & 1n ? n = n.add(i) : r && (o = o.add(i));
    return n;
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { ex: e, ey: r, ez: n } = this;
    if (this.equals(dt))
      return { x: 0n, y: 1n };
    const o = $n(n, H);
    return b(n * o) !== 1n && G("invalid inverse"), { x: b(e * o), y: b(r * o) };
  }
  toBytes() {
    const { x: e, y: r } = this.assertValidity().toAffine(), n = tr(r);
    return n[31] |= e & 1n ? 128 : 0, n;
  }
  toHex() {
    return He(this.toBytes());
  }
  // encode to hex string
  clearCofactor() {
    return this.multiply(Kt(Jr), !1);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let e = this.multiply(Tt / 2n, !1).double();
    return Tt % 2n && (e = e.add(this)), e.is0();
  }
  static fromHex(e, r) {
    return T.fromBytes(st(e), r);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  toRawBytes() {
    return this.toBytes();
  }
}
const Z = new T(en, nn, 1n, b(en * nn)), dt = new T(0n, 1n, 1n, 0n);
T.BASE = Z;
T.ZERO = dt;
const tr = (t) => Le(Xn(ot(t, 0n, Me), pt)).reverse(), Te = (t) => Kt("0x" + He(Ue(At(t)).reverse())), v = (t, e) => {
  let r = t;
  for (; e-- > 0n; )
    r *= r, r %= H;
  return r;
}, zr = (t) => {
  const r = t * t % H * t % H, n = v(r, 2n) * r % H, o = v(n, 1n) * t % H, i = v(o, 5n) * o % H, s = v(i, 10n) * i % H, c = v(s, 20n) * s % H, A = v(c, 40n) * c % H, f = v(A, 80n) * A % H, g = v(f, 80n) * A % H, a = v(g, 10n) * i % H;
  return { pow_p_5_8: v(a, 2n) * t % H, b2: r };
}, sn = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n, Xr = (t, e) => {
  const r = b(e * e * e), n = b(r * r * e), o = zr(t * n).pow_p_5_8;
  let i = b(t * r * o);
  const s = b(e * i * i), c = i, A = b(i * sn), f = s === t, g = s === b(-t), a = s === b(-t * sn);
  return f && (i = c), (g || a) && (i = A), (b(i) & 1n) === 1n && (i = b(-i)), { isValid: f || g, value: i };
}, vt = (t) => jn(Te(t)), Zr = (...t) => Jt.sha512Async(...t), Pe = (...t) => Vr("sha512Sync")(...t), er = (t) => {
  const e = t.slice(0, Y);
  e[0] &= 248, e[31] &= 127, e[31] |= 64;
  const r = t.slice(Y, pt), n = vt(e), o = Z.multiply(n), i = o.toBytes();
  return { head: e, prefix: r, scalar: n, point: o, pointBytes: i };
}, Wr = (t) => Zr(st(t, Y)).then(er), Ge = (t) => er(Pe(st(t, Y))), nr = (t) => Ge(t).pointBytes, rr = (t) => t.finish(Pe(t.hashable)), jr = (t, e, r) => {
  const { pointBytes: n, scalar: o } = t, i = vt(e), s = Z.multiply(i).toBytes();
  return { hashable: Dt(s, n, r), finish: (f) => {
    const g = jn(i + vt(f) * o);
    return At(Dt(s, tr(g)), pt);
  } };
}, $r = (t, e) => {
  const r = st(t), n = Ge(e), o = Pe(n.prefix, r);
  return rr(jr(n, o, r));
}, or = { zip215: !0 }, to = (t, e, r, n = or) => {
  t = st(t, pt), e = st(e), r = st(r, Y);
  const { zip215: o } = n;
  let i, s, c, A, f = Uint8Array.of();
  try {
    i = T.fromHex(r, o), s = T.fromHex(t.slice(0, Y), o), c = Te(t.slice(Y, pt)), A = Z.multiply(c, !1), f = Dt(s.toBytes(), i.toBytes(), e);
  } catch {
  }
  return { hashable: f, finish: (a) => {
    if (A == null || !o && i.isSmallOrder())
      return !1;
    const u = vt(a);
    return s.add(i.multiply(u, !1)).add(A.negate()).clearCofactor().is0();
  } };
}, eo = (t, e, r, n = or) => rr(to(t, e, r, n)), Jt = {
  sha512Async: async (...t) => {
    const e = qr(), r = Dt(...t);
    return qt(await e.digest("SHA-512", r.buffer));
  },
  sha512Sync: void 0,
  bytesToHex: He,
  hexToBytes: Le,
  concatBytes: Dt,
  mod: b,
  invert: $n,
  randomBytes: Wn
}, no = {
  getExtendedPublicKeyAsync: Wr,
  getExtendedPublicKey: Ge,
  randomPrivateKey: () => Wn(Y),
  precompute: (t = 8, e = Z) => (e.multiply(3n), e)
  // no-op
}, Yt = 8, ro = 256, ir = Math.ceil(ro / Yt) + 1, Re = 2 ** (Yt - 1), oo = () => {
  const t = [];
  let e = Z, r = e;
  for (let n = 0; n < ir; n++) {
    r = e, t.push(r);
    for (let o = 1; o < Re; o++)
      r = r.add(e), t.push(r);
    e = r.double();
  }
  return t;
};
let An;
const cn = (t, e) => {
  const r = e.negate();
  return t ? r : e;
}, io = (t) => {
  const e = An || (An = oo());
  let r = dt, n = Z;
  const o = 2 ** Yt, i = o, s = Kt(o - 1), c = Kt(Yt);
  for (let A = 0; A < ir; A++) {
    let f = Number(t & s);
    t >>= c, f > Re && (f -= i, t += 1n);
    const g = A * Re, a = g, u = g + Math.abs(f) - 1, l = A % 2 !== 0, d = f < 0;
    f === 0 ? n = n.add(cn(l, e[a])) : r = r.add(cn(d, e[u]));
  }
  return { p: r, f: n };
};
Jt.sha512Sync = (...t) => Kr(Jt.concatBytes(...t));
function Hi() {
  const t = no.randomPrivateKey(), e = nr(t);
  return {
    privateKey: t,
    publicKey: e,
    address: k(e)
  };
}
function Li(t) {
  if (t.length !== 32) throw new Error("private key must be 32 bytes");
  const e = nr(t);
  return { privateKey: t, publicKey: e, address: k(e) };
}
function so(t, e) {
  return $r(t, e);
}
function Ao(t, e, r) {
  try {
    return eo(t, e, r);
  } catch {
    return !1;
  }
}
function Ti(t) {
  return k(Bt(t).slice(0, 8));
}
function Pi(t) {
  const e = Er(t);
  if (e.length !== 32) throw new Error("address must be 32 bytes");
  return e;
}
const sr = 3223191277, Ar = 100000000n, co = 50n * Ar, fo = 21e4, ne = 21000000n * Ar, xe = 150, ao = 50, _e = 11, go = 600, fn = 6, uo = 600, lo = 256 * 1024, Gi = 1n, Vt = 537001984, ho = (1n << 256n) - 1n;
function Io(t) {
  const e = Math.floor(t / fo);
  return e >= 64 ? 0n : co >> BigInt(e);
}
const Pt = {
  header: {
    height: 0,
    prevHash: new Uint8Array(32),
    txRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(32),
    timestamp: 17797e5,
    // ~2026-05-24 19:06 UTC — far enough in the past that test clocks and deploy clocks both run forward from it
    difficulty: Vt,
    nonce: 0,
    miner: new Uint8Array(32)
  },
  transactions: []
}, Bo = Pt.header.timestamp, Eo = 88, cr = Eo + 64;
function Ke(t) {
  return Et(
    it(sr),
    t.from,
    t.to,
    _t(t.amount),
    _t(t.fee),
    it(t.nonce)
  );
}
function ve(t) {
  return Et(Ke(t), t.signature);
}
function Co(t, e = 0) {
  if (t.length - e < cr) throw new Error("tx truncated");
  const r = It(t, e);
  if (r !== sr) throw new Error(`tx chain id mismatch (got ${r})`);
  let n = e + 4;
  const o = t.slice(n, n + 32);
  n += 32;
  const i = t.slice(n, n + 32);
  n += 32;
  const s = Se(t, n);
  n += 8;
  const c = Se(t, n);
  n += 8;
  const A = It(t, n);
  n += 4;
  const f = t.slice(n, n + 64);
  return n += 64, { tx: { from: o, to: i, amount: s, fee: c, nonce: A, signature: f }, next: n };
}
function _i(t) {
  return Bt(ve(t));
}
function Ki(t, e) {
  const r = so(Ke(t), e);
  return { ...t, signature: r };
}
function wo(t) {
  return t.from.length !== 32 || t.to.length !== 32 || t.signature.length !== 64 ? !1 : Ao(t.signature, Ke(t), t.from);
}
function Qo(t) {
  return t.amount < 0n ? "amount negative" : t.fee < 0n ? "fee negative" : t.amount > ne ? "amount exceeds MAX_MONEY" : t.fee > ne ? "fee exceeds MAX_MONEY" : t.amount + t.fee > ne ? "amount + fee exceeds MAX_MONEY" : t.amount === 0n && t.fee === 0n ? "tx has no value" : t.nonce < 0 || !Number.isInteger(t.nonce) ? "nonce invalid" : k(t.from) === k(t.to) ? "self-send forbidden" : wo(t) ? null : "bad signature";
}
const Je = 148;
function zt(t) {
  return Et(
    it(t.height),
    t.prevHash,
    t.txRoot,
    t.stateRoot,
    _t(BigInt(t.timestamp)),
    it(t.difficulty),
    it(t.nonce),
    t.miner
  );
}
function yo(t, e = 0) {
  if (t.length - e < Je) throw new Error("header truncated");
  let r = e;
  const n = It(t, r);
  r += 4;
  const o = t.slice(r, r + 32);
  r += 32;
  const i = t.slice(r, r + 32);
  r += 32;
  const s = t.slice(r, r + 32);
  r += 32;
  const c = Number(Se(t, r));
  r += 8;
  const A = It(t, r);
  r += 4;
  const f = It(t, r);
  r += 4;
  const g = t.slice(r, r + 32);
  return r += 32, { height: n, prevHash: o, txRoot: i, stateRoot: s, timestamp: c, difficulty: A, nonce: f, miner: g };
}
function yt(t) {
  return Bt(zt(t));
}
function vi(t) {
  const e = yt(t);
  let r = "";
  for (let n = 0; n < e.length; n++) r += e[n].toString(16).padStart(2, "0");
  return r;
}
function bo(t) {
  return Vn(t.map((e) => ve(e)));
}
function Ji(t) {
  const e = t.transactions.length, r = [zt(t.header), it(e)];
  for (const n of t.transactions) r.push(ve(n));
  return Et(...r);
}
function Yi(t) {
  const e = yo(t, 0);
  let r = Je;
  const n = It(t, r);
  r += 4;
  const o = [];
  for (let i = 0; i < n; i++) {
    const { tx: s, next: c } = Co(t, r);
    o.push(s), r = c;
  }
  if (r !== t.length) throw new Error("trailing bytes in block");
  return { header: e, transactions: o };
}
function po(t) {
  return Je + 4 + t.transactions.length * cr;
}
function lt(t, e, r, n) {
  t[e] += r[n], t[e + 1] += r[n + 1] + (t[e] < r[n]);
}
function an(t, e) {
  t[0] += e, t[1] += t[0] < e;
}
function et(t, e, r, n, o, i, s, c) {
  lt(t, r, t, n), lt(t, r, e, s);
  let A = t[i] ^ t[r], f = t[i + 1] ^ t[r + 1];
  t[i] = f, t[i + 1] = A, lt(t, o, t, i), A = t[n] ^ t[o], f = t[n + 1] ^ t[o + 1], t[n] = A >>> 24 ^ f << 8, t[n + 1] = f >>> 24 ^ A << 8, lt(t, r, t, n), lt(t, r, e, c), A = t[i] ^ t[r], f = t[i + 1] ^ t[r + 1], t[i] = A >>> 16 ^ f << 16, t[i + 1] = f >>> 16 ^ A << 16, lt(t, o, t, i), A = t[n] ^ t[o], f = t[n + 1] ^ t[o + 1], t[n] = f >>> 31 ^ A << 1, t[n + 1] = A >>> 31 ^ f << 1;
}
const fr = new Uint32Array([
  4089235720,
  1779033703,
  2227873595,
  3144134277,
  4271175723,
  1013904242,
  1595750129,
  2773480762,
  2917565137,
  1359893119,
  725511199,
  2600822924,
  4215389547,
  528734635,
  327033209,
  1541459225
]), U = new Uint8Array([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3,
  11,
  8,
  12,
  0,
  5,
  2,
  15,
  13,
  10,
  14,
  3,
  6,
  7,
  1,
  9,
  4,
  7,
  9,
  3,
  1,
  13,
  12,
  11,
  14,
  2,
  6,
  5,
  10,
  4,
  0,
  15,
  8,
  9,
  0,
  5,
  7,
  2,
  4,
  10,
  15,
  14,
  1,
  11,
  12,
  6,
  8,
  3,
  13,
  2,
  12,
  6,
  10,
  0,
  11,
  8,
  3,
  4,
  13,
  7,
  5,
  15,
  14,
  1,
  9,
  12,
  5,
  1,
  15,
  14,
  13,
  4,
  10,
  0,
  7,
  6,
  3,
  9,
  2,
  8,
  11,
  13,
  11,
  7,
  14,
  12,
  1,
  3,
  9,
  5,
  0,
  15,
  4,
  8,
  6,
  2,
  10,
  6,
  15,
  14,
  9,
  11,
  3,
  0,
  8,
  12,
  2,
  13,
  7,
  1,
  4,
  10,
  5,
  10,
  2,
  8,
  4,
  7,
  6,
  1,
  5,
  15,
  11,
  9,
  14,
  3,
  12,
  13,
  0,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3
].map((t) => t * 2));
function gn(t, e) {
  const r = new Uint32Array(32), n = new Uint32Array(t.b.buffer, t.b.byteOffset, 32);
  for (let i = 0; i < 16; i++)
    r[i] = t.h[i], r[i + 16] = fr[i];
  r[24] ^= t.t0[0], r[25] ^= t.t0[1];
  const o = e ? 4294967295 : 0;
  r[28] ^= o, r[29] ^= o;
  for (let i = 0; i < 12; i++) {
    const s = i << 4;
    et(r, n, 0, 8, 16, 24, U[s + 0], U[s + 1]), et(r, n, 2, 10, 18, 26, U[s + 2], U[s + 3]), et(r, n, 4, 12, 20, 28, U[s + 4], U[s + 5]), et(r, n, 6, 14, 22, 30, U[s + 6], U[s + 7]), et(r, n, 0, 10, 20, 30, U[s + 8], U[s + 9]), et(r, n, 2, 12, 22, 24, U[s + 10], U[s + 11]), et(r, n, 4, 14, 16, 26, U[s + 12], U[s + 13]), et(r, n, 6, 8, 18, 28, U[s + 14], U[s + 15]);
  }
  for (let i = 0; i < 16; i++)
    t.h[i] ^= r[i] ^ r[i + 16];
}
class Do {
  constructor(e, r, n, o) {
    const i = new Uint8Array(64);
    this.S = {
      b: new Uint8Array(wt),
      h: new Uint32Array(Ne / 4),
      t0: new Uint32Array(2),
      // input counter `t`, lower 64-bits only
      c: 0,
      // `fill`, pointer within buffer, up to `BLOCKBYTES`
      outlen: e
      // output length in bytes
    }, i[0] = e, r && (i[1] = r.length), i[2] = 1, i[3] = 1, n && i.set(n, 32), o && i.set(o, 48);
    const s = new Uint32Array(i.buffer, i.byteOffset, i.length / Uint32Array.BYTES_PER_ELEMENT);
    for (let c = 0; c < 16; c++)
      this.S.h[c] = fr[c] ^ s[c];
    if (r) {
      const c = new Uint8Array(wt);
      c.set(r), this.update(c);
    }
  }
  // Updates a BLAKE2b streaming hash
  // Requires Uint8Array (byte array)
  update(e) {
    if (!(e instanceof Uint8Array)) throw new Error("Input must be Uint8Array or Buffer");
    let r = 0;
    for (; r < e.length; ) {
      this.S.c === wt && (an(this.S.t0, this.S.c), gn(this.S, !1), this.S.c = 0);
      let n = wt - this.S.c;
      this.S.b.set(e.subarray(r, r + n), this.S.c);
      const o = Math.min(n, e.length - r);
      this.S.c += o, r += o;
    }
    return this;
  }
  /**
   * Return a BLAKE2b hash, either filling the given Uint8Array or allocating a new one
   * @param {Uint8Array} [prealloc] - optional preallocated buffer
   * @returns {ArrayBuffer} message digest
   */
  digest(e) {
    an(this.S.t0, this.S.c), this.S.b.fill(0, this.S.c), this.S.c = wt, gn(this.S, !0);
    const r = e || new Uint8Array(this.S.outlen);
    for (let n = 0; n < this.S.outlen; n++)
      r[n] = this.S.h[n >> 2] >> 8 * (n & 3);
    return this.S.h = null, r.buffer;
  }
}
function Gt(t, e, r, n) {
  if (t > Ne) throw new Error(`outlen must be at most ${Ne} (given: ${t})`);
  return new Do(t, e, r, n);
}
const Ne = 64, wt = 128, Ye = 2, ar = 19, mo = 4294967295, So = 4, Mo = 4294967295, Ro = 8, xo = 4294967295, No = 8, ko = 4294967295, Fo = 4294967295, Uo = 32, X = 1024, Ho = 64, Lo = new Uint8Array(new Uint16Array([43981]).buffer)[0] === 205;
function L(t, e, r) {
  return t[r + 0] = e, t[r + 1] = e >> 8, t[r + 2] = e >> 16, t[r + 3] = e >> 24, t;
}
function rt(t, e, r) {
  if (e > Number.MAX_SAFE_INTEGER) throw new Error("LE64: large numbers unsupported");
  let n = e;
  for (let o = r; o < r + 7; o++)
    t[o] = n, n = (n - t[o]) / 256;
  return t;
}
function re(t, e, r) {
  const n = new Uint8Array(64), o = new Uint8Array(4 + e.length);
  if (L(o, t, 0), o.set(e, 4), t <= 64)
    return Gt(t).update(o).digest(r), r;
  const i = Math.ceil(t / 32) - 2;
  for (let c = 0; c < i; c++)
    Gt(64).update(c === 0 ? o : n).digest(n), r.set(n.subarray(0, 32), c * 32);
  const s = new Uint8Array(Gt(t - 32 * i).update(n).digest());
  return r.set(s, i * 32), r;
}
function un(t, e, r, n) {
  return t.fn.XOR(
    e.byteOffset,
    r.byteOffset,
    n.byteOffset
  ), e;
}
function To(t, e, r, n) {
  return t.fn.G(
    e.byteOffset,
    r.byteOffset,
    n.byteOffset,
    t.refs.gZ.byteOffset
  ), n;
}
function Po(t, e, r, n) {
  return t.fn.G2(
    e.byteOffset,
    r.byteOffset,
    n.byteOffset,
    t.refs.gZ.byteOffset
  ), n;
}
function* Go(t, e, r, n, o, i, s, c) {
  t.refs.prngTmp.fill(0);
  const A = t.refs.prngTmp.subarray(0, 48);
  rt(A, e, 0), rt(A, r, 8), rt(A, n, 16), rt(A, o, 24), rt(A, i, 32), rt(A, Ye, 40);
  for (let f = 1; f <= s; f++) {
    rt(t.refs.prngTmp, f, A.length);
    const g = Po(t, t.refs.ZERO1024, t.refs.prngTmp, t.refs.prngR);
    for (let a = f === 1 ? c * 8 : 0; a < g.length; a += 8)
      yield g.subarray(a, a + 8);
  }
  return [];
}
function _o({ type: t, version: e, tagLength: r, password: n, salt: o, ad: i, secret: s, parallelism: c, memorySize: A, passes: f }) {
  const g = (a, u, l, d) => {
    if (u < l || u > d)
      throw new Error(`${a} size should be between ${l} and ${d} bytes`);
  };
  if (t !== Ye || e !== ar) throw new Error("Unsupported type or version");
  return g("password", n, No, xo), g("salt", o, Ro, Mo), g("tag", r, So, mo), g("memory", A, 8 * c, ko), i && g("associated data", i, 0, Fo), s && g("secret", s, 0, Uo), { type: t, version: e, tagLength: r, password: n, salt: o, ad: i, secret: s, lanes: c, memorySize: A, passes: f };
}
const gr = 1024, Ko = 64 * gr;
function vo(t, { memory: e, instance: r }) {
  if (!Lo) throw new Error("BigEndian system not supported");
  const n = _o({ type: Ye, version: ar, ...t }), { G: o, G2: i, xor: s, getLZ: c } = r.exports, A = {}, f = {};
  f.G = o, f.G2 = i, f.XOR = s;
  const g = 4 * n.lanes * Math.floor(n.memorySize / (4 * n.lanes)), a = g * X + 10 * gr;
  if (e.buffer.byteLength < a) {
    const I = Math.ceil((a - e.buffer.byteLength) / Ko);
    e.grow(I);
  }
  let u = 0;
  A.gZ = new Uint8Array(e.buffer, u, X), u += A.gZ.length, A.prngR = new Uint8Array(e.buffer, u, X), u += A.prngR.length, A.prngTmp = new Uint8Array(e.buffer, u, X), u += A.prngTmp.length, A.ZERO1024 = new Uint8Array(e.buffer, u, 1024), u += A.ZERO1024.length;
  const l = new Uint32Array(e.buffer, u, 2);
  u += l.length * Uint32Array.BYTES_PER_ELEMENT;
  const d = { fn: f, refs: A }, w = new Uint8Array(e.buffer, u, X);
  u += w.length;
  const x = new Uint8Array(e.buffer, u, n.memorySize * X), D = new Uint8Array(e.buffer, 0, u), M = Jo(n), h = g / n.lanes, E = new Array(n.lanes).fill(null).map(() => new Array(h)), N = (I, B) => (E[I][B] = x.subarray(I * h * 1024 + B * 1024, I * h * 1024 + B * 1024 + X), E[I][B]);
  for (let I = 0; I < n.lanes; I++) {
    const B = new Uint8Array(M.length + 8);
    B.set(M), L(B, 0, M.length), L(B, I, M.length + 4), re(X, B, N(I, 0)), L(B, 1, M.length), re(X, B, N(I, 1));
  }
  const Q = 4, m = h / Q;
  for (let I = 0; I < n.passes; I++)
    for (let B = 0; B < Q; B++) {
      const S = I === 0 && B <= 1;
      for (let y = 0; y < n.lanes; y++) {
        let R = B === 0 && I === 0 ? 2 : 0;
        const P = S ? Go(d, I, y, B, g, n.passes, m, R) : null;
        for (R; R < m; R++) {
          const _ = B * m + R, St = _ > 0 ? E[y][_ - 1] : E[y][h - 1], Mt = S ? P.next().value : St;
          c(l.byteOffset, Mt.byteOffset, y, n.lanes, I, B, R, Q, m);
          const Xt = l[0], Ct = l[1];
          I === 0 && N(y, _), To(d, St, E[Xt][Ct], I > 0 ? w : E[y][_]), I > 0 && un(d, E[y][_], w, E[y][_]);
        }
      }
    }
  const p = E[0][h - 1];
  for (let I = 1; I < n.lanes; I++)
    un(d, p, p, E[I][h - 1]);
  const C = re(n.tagLength, p, new Uint8Array(n.tagLength));
  return D.fill(0), e.grow(0), C;
}
function Jo(t) {
  const e = Gt(Ho), r = new Uint8Array(4), n = new Uint8Array(24);
  L(n, t.lanes, 0), L(n, t.tagLength, 4), L(n, t.memorySize, 8), L(n, t.passes, 12), L(n, t.version, 16), L(n, t.type, 20);
  const o = [n];
  t.password ? (o.push(L(new Uint8Array(4), t.password.length, 0)), o.push(t.password)) : o.push(r), t.salt ? (o.push(L(new Uint8Array(4), t.salt.length, 0)), o.push(t.salt)) : o.push(r), t.secret ? (o.push(L(new Uint8Array(4), t.secret.length, 0)), o.push(t.secret)) : o.push(r), t.ad ? (o.push(L(new Uint8Array(4), t.ad.length, 0)), o.push(t.ad)) : o.push(r), e.update(Yo(o));
  const i = e.digest();
  return new Uint8Array(i);
}
function Yo(t) {
  if (t.length === 1) return t[0];
  let e = 0;
  for (let o = 0; o < t.length; o++) {
    if (!(t[o] instanceof Uint8Array))
      throw new Error("concatArrays: Data must be in the form of a Uint8Array");
    e += t[o].length;
  }
  const r = new Uint8Array(e);
  let n = 0;
  return t.forEach((o) => {
    r.set(o, n), n += o.length;
  }), r;
}
let Ft;
async function Oo(t, e, r) {
  const n = { env: { memory: t } };
  if (Ft === void 0)
    try {
      const i = await e(n);
      return Ft = !0, i;
    } catch {
      Ft = !1;
    }
  return (Ft ? e : r)(n);
}
async function qo(t, e) {
  const r = new WebAssembly.Memory({
    // in pages of 64KiB each
    // these values need to be compatible with those declared when building in `build-wasm`
    initial: 1040,
    // 65MB
    maximum: 65536
    // 4GB
  }), n = await Oo(r, t, e);
  return (i) => vo(i, { instance: n.instance, memory: r });
}
const Vo = "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", zo = "AGFzbQEAAAABPwhgBH9/f38AYAABf2AAAGADf39/AGARf39/f39/f39/f39/f39/f38AYAl/f39/f39/f38Bf2ABfwBgAX8BfwITAQNlbnYGbWVtb3J5AgGQCICABAMLCgIDBAAABQEGBwEEBQFwAQICBgkBfwFBkIjAAgsHfQoDeG9yAAEBRwADAkcyAAQFZ2V0TFoABRlfX2luZGlyZWN0X2Z1bmN0aW9uX3RhYmxlAQALX2luaXRpYWxpemUAABBfX2Vycm5vX2xvY2F0aW9uAAkJc3RhY2tTYXZlAAYMc3RhY2tSZXN0b3JlAAcKc3RhY2tBbGxvYwAICQcBAEEBCwEACssaCgMAAQtQAQJ/A0AgACAEQQN0IgNqIAIgA2opAwAgASADaikDAIU3AwAgACADQQhyIgNqIAIgA2opAwAgASADaikDAIU3AwAgBEECaiIEQYABRw0ACwveDwICfgF/IAAgAUEDdGoiEyATKQMAIhEgACAFQQN0aiIBKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIA1BA3RqIgUgESAFKQMAhUIgiSIRNwMAIAAgCUEDdGoiCSARIAkpAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAEgESABKQMAhUIoiSIRNwMAIBMgESATKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAFIBEgBSkDAIVCMIkiETcDACAJIBEgCSkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgASARIAEpAwCFQgGJNwMAIAAgAkEDdGoiDSANKQMAIhEgACAGQQN0aiICKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIA5BA3RqIgYgESAGKQMAhUIgiSIRNwMAIAAgCkEDdGoiCiARIAopAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAIgESACKQMAhUIoiSIRNwMAIA0gESANKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAGIBEgBikDAIVCMIkiETcDACAKIBEgCikDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgAiARIAIpAwCFQgGJNwMAIAAgA0EDdGoiDiAOKQMAIhEgACAHQQN0aiIDKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIA9BA3RqIgcgESAHKQMAhUIgiSIRNwMAIAAgC0EDdGoiCyARIAspAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAMgESADKQMAhUIoiSIRNwMAIA4gESAOKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAHIBEgBykDAIVCMIkiETcDACALIBEgCykDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgAyARIAMpAwCFQgGJNwMAIAAgBEEDdGoiDyAPKQMAIhEgACAIQQN0aiIEKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIBBBA3RqIgggESAIKQMAhUIgiSIRNwMAIAAgDEEDdGoiACARIAApAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAQgESAEKQMAhUIoiSIRNwMAIA8gESAPKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAIIBEgCCkDAIVCMIkiETcDACAAIBEgACkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgBCARIAQpAwCFQgGJNwMAIBMgEykDACIRIAIpAwAiEnwgEUIBhkL+////H4MgEkL/////D4N+fCIRNwMAIAggESAIKQMAhUIgiSIRNwMAIAsgESALKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACACIBEgAikDAIVCKIkiETcDACATIBEgEykDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgCCARIAgpAwCFQjCJIhE3AwAgCyARIAspAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAIgESACKQMAhUIBiTcDACANIA0pAwAiESADKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAFIBEgBSkDAIVCIIkiETcDACAAIBEgACkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgAyARIAMpAwCFQiiJIhE3AwAgDSARIA0pAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAUgESAFKQMAhUIwiSIRNwMAIAAgESAAKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACADIBEgAykDAIVCAYk3AwAgDiAOKQMAIhEgBCkDACISfCARQgGGQv7///8fgyASQv////8Pg358IhE3AwAgBiARIAYpAwCFQiCJIhE3AwAgCSARIAkpAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAQgESAEKQMAhUIoiSIRNwMAIA4gESAOKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAGIBEgBikDAIVCMIkiETcDACAJIBEgCSkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgBCARIAQpAwCFQgGJNwMAIA8gDykDACIRIAEpAwAiEnwgEUIBhkL+////H4MgEkL/////D4N+fCIRNwMAIAcgESAHKQMAhUIgiSIRNwMAIAogESAKKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACABIBEgASkDAIVCKIkiETcDACAPIBEgDykDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgByARIAcpAwCFQjCJIhE3AwAgCiARIAopAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAEgESABKQMAhUIBiTcDAAvdCAEPfwNAIAIgBUEDdCIGaiABIAZqKQMAIAAgBmopAwCFNwMAIAIgBkEIciIGaiABIAZqKQMAIAAgBmopAwCFNwMAIAVBAmoiBUGAAUcNAAsDQCADIARBA3QiAGogACACaikDADcDACADIARBAXIiAEEDdCIBaiABIAJqKQMANwMAIAMgBEECciIBQQN0IgVqIAIgBWopAwA3AwAgAyAEQQNyIgVBA3QiBmogAiAGaikDADcDACADIARBBHIiBkEDdCIHaiACIAdqKQMANwMAIAMgBEEFciIHQQN0IghqIAIgCGopAwA3AwAgAyAEQQZyIghBA3QiCWogAiAJaikDADcDACADIARBB3IiCUEDdCIKaiACIApqKQMANwMAIAMgBEEIciIKQQN0IgtqIAIgC2opAwA3AwAgAyAEQQlyIgtBA3QiDGogAiAMaikDADcDACADIARBCnIiDEEDdCINaiACIA1qKQMANwMAIAMgBEELciINQQN0Ig5qIAIgDmopAwA3AwAgAyAEQQxyIg5BA3QiD2ogAiAPaikDADcDACADIARBDXIiD0EDdCIQaiACIBBqKQMANwMAIAMgBEEOciIQQQN0IhFqIAIgEWopAwA3AwAgAyAEQQ9yIhFBA3QiEmogAiASaikDADcDACADIARB//8DcSAAQf//A3EgAUH//wNxIAVB//8DcSAGQf//A3EgB0H//wNxIAhB//8DcSAJQf//A3EgCkH//wNxIAtB//8DcSAMQf//A3EgDUH//wNxIA5B//8DcSAPQf//A3EgEEH//wNxIBFB//8DcRACIARB8ABJIQAgBEEQaiEEIAANAAtBACEBIANBAEEBQRBBEUEgQSFBMEExQcAAQcEAQdAAQdEAQeAAQeEAQfAAQfEAEAIgA0ECQQNBEkETQSJBI0EyQTNBwgBBwwBB0gBB0wBB4gBB4wBB8gBB8wAQAiADQQRBBUEUQRVBJEElQTRBNUHEAEHFAEHUAEHVAEHkAEHlAEH0AEH1ABACIANBBkEHQRZBF0EmQSdBNkE3QcYAQccAQdYAQdcAQeYAQecAQfYAQfcAEAIgA0EIQQlBGEEZQShBKUE4QTlByABByQBB2ABB2QBB6ABB6QBB+ABB+QAQAiADQQpBC0EaQRtBKkErQTpBO0HKAEHLAEHaAEHbAEHqAEHrAEH6AEH7ABACIANBDEENQRxBHUEsQS1BPEE9QcwAQc0AQdwAQd0AQewAQe0AQfwAQf0AEAIgA0EOQQ9BHkEfQS5BL0E+QT9BzgBBzwBB3gBB3wBB7gBB7wBB/gBB/wAQAgNAIAIgAUEDdCIAaiIEIAAgA2opAwAgBCkDAIU3AwAgAiAAQQhyIgRqIgUgAyAEaikDACAFKQMAhTcDACACIABBEHIiBGoiBSADIARqKQMAIAUpAwCFNwMAIAIgAEEYciIAaiIEIAAgA2opAwAgBCkDAIU3AwAgAUEEaiIBQYABRw0ACwsWACAAIAEgAiADEAMgACACIAIgAxADC3sCAX8BfiACIQkgATUCACEKIAQgBXIEQCABKAIEIANwIQkLIAAgCTYCACAAIAdBAWsgBSAEGyAIbCAGQQFrQQBBfyAGGyACIAlGG2oiASAFQQFqIAhsQQAgBBtqIAGtIAogCn5CIIh+QiCIp0F/c2ogByAIbHA2AgQgAAsEACMACwYAIAAkAAsQACMAIABrQXBxIgAkACAACwUAQYAICw==", Xo = new TextEncoder().encode("browsercoin-pow-v5"), Ut = {
  memorySize: 32 * 1024,
  // KiB → 32 MB
  iterations: 1,
  parallelism: 1,
  hashLength: 32
};
let Ht = null;
function ln(t) {
  const e = atob(t), r = new Uint8Array(e.length);
  for (let n = 0; n < e.length; n++) r[n] = e.charCodeAt(n);
  return r;
}
function Zo() {
  if (Ht) return Ht;
  const t = ln(Vo), e = ln(zo);
  return Ht = qo(
    (r) => WebAssembly.instantiate(t, r),
    (r) => WebAssembly.instantiate(e, r)
  ), Ht;
}
async function Wo(t) {
  return (await Zo())({
    password: t,
    salt: Xo,
    parallelism: Ut.parallelism,
    passes: Ut.iterations,
    memorySize: Ut.memorySize,
    tagLength: Ut.hashLength
  });
}
const Ot = mt(Vt), jo = mt(Vt);
function $o(t, e) {
  const r = BigInt(t), i = (BigInt(e - Bo) - r * BigInt(xe) << 16n) / BigInt(go);
  let s = i >> 16n, c = Number((i % 65536n + 65536n) % 65536n);
  c >= 65536 && (c -= 65536, s += 1n);
  const A = 65536n + (195766423245049n * BigInt(c) + 971821376n * BigInt(c) * BigInt(c) + 5127n * BigInt(c) * BigInt(c) * BigInt(c) + (1n << 47n) >> 48n);
  let f = jo * A;
  return s < 0n ? f = f >> -s : f = f << s, f = f >> 16n, f <= 0n && (f = 1n), f > Ot && (f = Ot), f;
}
async function ti(t) {
  const e = mt(t.difficulty);
  if (e <= 0n || e > ho) return !1;
  const r = await Wo(zt(t));
  return Cr(r, e);
}
function ei(t, e, r) {
  if (t === 0) return Vt;
  const n = e[e.length - 1], o = mt(n.difficulty);
  if (r !== void 0 && e.length >= 2) {
    const i = e[e.length - 2];
    if (i.height > 0) {
      const s = n.timestamp - i.timestamp > fn * xe, c = r - n.timestamp > fn * xe;
      if (s && c) {
        let A = o * 2n;
        return A > Ot && (A = Ot), Xe(A);
      }
    }
  }
  return Xe($o(n.height, n.timestamp));
}
function hn(t) {
  const e = mt(t);
  return e <= 0n ? 0n : (1n << 256n) / (e + 1n);
}
function ni(t, e) {
  const r = Math.max(0, e - _e + 1), n = [];
  for (let o = r; o <= e; o++) n.push(t[o].timestamp);
  return n.sort((o, i) => o - i), n[Math.floor(n.length / 2)];
}
function ri(t) {
  return t.length === 0 ? 0 : ni(t, t.length - 1);
}
function oi() {
  return /* @__PURE__ */ new Map();
}
function ke(t, e) {
  return t.get(e) ?? { balance: 0n, nonce: 0 };
}
function ii(t) {
  const e = /* @__PURE__ */ new Map();
  for (const [r, n] of t) e.set(r, { balance: n.balance, nonce: n.nonce });
  return e;
}
function si(t) {
  const e = [...t.keys()].sort();
  if (e.length === 0) return new Uint8Array(32);
  const r = [];
  for (const n of e) {
    const o = t.get(n);
    o.balance === 0n && o.nonce === 0 || r.push(Et(
      Ai(n),
      _t(o.balance),
      it(o.nonce)
    ));
  }
  return Vn(r);
}
function Ai(t) {
  const e = new Uint8Array(32);
  for (let r = 0; r < 32; r++)
    e[r] = parseInt(t.slice(r * 2, r * 2 + 2), 16);
  return e;
}
function ci(t, e) {
  const r = k(e.from), n = k(e.to), o = ke(t, r), i = e.amount + e.fee;
  if (o.balance < i) return "insufficient balance";
  if (e.nonce !== o.nonce) return `bad nonce (expected ${o.nonce}, got ${e.nonce})`;
  o.balance -= i, o.nonce += 1, o.balance === 0n && o.nonce !== 0 ? t.set(r, o) : o.balance === 0n ? t.delete(r) : t.set(r, o);
  const s = ke(t, n);
  return s.balance += e.amount, t.set(n, s), null;
}
function fi(t, e, r, n) {
  let o = 0n;
  for (const c of n) {
    const A = ci(t, c);
    if (A) return `tx ${k(c.from).slice(0, 8)}…/${c.nonce}: ${A}`;
    o += c.fee;
  }
  const i = k(r), s = ke(t, i);
  return s.balance += Io(e) + o, t.set(i, s), null;
}
const ai = ao + _e - 1;
class ur {
  /** All known valid blocks, by hex header hash. */
  blocks = /* @__PURE__ */ new Map();
  /** The chain tip — the block with the highest cumulative work. */
  tipHash;
  /** Listeners invoked after a block is accepted (any branch). Hash-hex passed for keying. */
  acceptListeners = /* @__PURE__ */ new Set();
  /** Listeners invoked only when the canonical tip moves, with the mempool delta. */
  tipChangeListeners = /* @__PURE__ */ new Set();
  constructor() {
    const e = yt(Pt.header), r = k(e);
    this.blocks.set(r, {
      block: Pt,
      hash: e,
      work: hn(Pt.header.difficulty),
      state: oi()
    }), this.tipHash = r;
  }
  /**
   * Build a chain rooted at a trusted CHECKPOINT block instead of genesis — for fast
   * boot from a content-addressed state snapshot. The caller MUST have verified
   * `state` against `checkpoint.header.stateRoot` (the state's content address, which
   * is committed in the PoW-anchored header) and the checkpoint's header chain. ASERT
   * is anchored at the hardcoded GENESIS_TIMESTAMP constant, not at the chain root, so
   * difficulty retargeting is identical from any checkpoint. Forward blocks added via
   * addBlock validate exactly as on a genesis-rooted chain.
   */
  static fromCheckpoint(e, r, n) {
    const o = new ur();
    o.blocks.clear();
    const i = yt(e.header), s = k(i);
    return o.blocks.set(s, { block: e, hash: i, work: n, state: r }), o.tipHash = s, o;
  }
  /** Subscribe to every accepted block (canonical or fork). Returns an unsubscribe fn. */
  onBlockAdded(e) {
    return this.acceptListeners.add(e), () => this.acceptListeners.delete(e);
  }
  /**
   * Subscribe to canonical-tip moves. Fires only when the active chain changes
   * (a plain extension or a reorg) with the txs that became confirmed and the
   * txs that were displaced back into pending. This is the single place mempool
   * eviction should hang off — a tx must never leave the mempool just because
   * it appeared in some accepted-but-non-canonical fork block.
   */
  onTipChanged(e) {
    return this.tipChangeListeners.add(e), () => this.tipChangeListeners.delete(e);
  }
  get tip() {
    return this.blocks.get(this.tipHash);
  }
  get height() {
    return this.tip.block.header.height;
  }
  /** State at the chain tip — do NOT mutate. */
  get tipState() {
    return this.tip.state;
  }
  get tipDifficulty() {
    return this.tip.block.header.difficulty;
  }
  hasBlock(e) {
    return this.blocks.has(e);
  }
  getBlock(e) {
    return this.blocks.get(e);
  }
  /** Walk back from the tip collecting up to `n` block headers (newest last). */
  getRecentHeaders(e, r = this.tipHash) {
    const n = [];
    let o = r;
    for (; o && n.length < e; ) {
      const i = this.blocks.get(o);
      if (!i || (n.push(i.block.header), i.block.header.height === 0)) break;
      o = k(i.block.header.prevHash);
    }
    return n.reverse();
  }
  /**
   * Try to add a block. Validates fully: parent exists, PoW, header roots match,
   * timestamp rules, tx signatures + balance/nonce, block size cap. Returns null
   * on success, or an error message.
   *
   * Reorgs are handled by virtue of storing every valid block and letting the
   * heaviest-work tip win. Storage is per-block — no in-place mutation of
   * other branches.
   */
  async addBlock(e) {
    return this.addBlockInternal(e, { skipPoW: !1, skipTxSig: !1 });
  }
  /**
   * Restore a block that was previously validated and persisted locally (IDB).
   * Skips Argon2id PoW + tx signature re-checks — those were verified when the
   * block was first accepted, and re-running them would burn ~40–125 ms each.
   * Still performs all state-dependent checks (parent link, difficulty,
   * timestamp, roots, state apply) because they're cheap and catch IDB
   * corruption / version-skew bugs.
   *
   * An attacker who can rewrite IndexedDB could also rewrite the running JS,
   * so re-verifying PoW from IDB buys no real security — just latency.
   */
  async addValidatedBlock(e) {
    return this.addBlockInternal(e, { skipPoW: !0, skipTxSig: !0 });
  }
  async addBlockInternal(e, r) {
    const { header: n, transactions: o } = e, i = yt(n), s = k(i);
    if (this.blocks.has(s)) return null;
    const c = k(n.prevHash), A = this.blocks.get(c);
    if (!A) return "parent block unknown";
    if (n.height !== A.block.header.height + 1) return "height not parent+1";
    if (po(e) > lo) return "block too large";
    const f = this.getRecentHeaders(ai, c), g = ei(n.height, f, n.timestamp);
    if (n.difficulty !== g)
      return `bad difficulty (expected ${g.toString(16)} got ${n.difficulty.toString(16)})`;
    const a = Math.floor(Date.now() / 1e3);
    if (n.timestamp > a + uo) return "timestamp too far in future";
    const u = ri(this.getRecentHeaders(_e, c));
    if (u > 0 && n.timestamp <= u) return "timestamp not above median-time-past";
    if (!r.skipPoW && !await ti(n)) return "PoW invalid";
    const l = bo(o);
    if (Ze(l, n.txRoot) !== 0) return "txRoot mismatch";
    const d = ii(A.state);
    if (!r.skipTxSig)
      for (const E of o) {
        const N = Qo(E);
        if (N) return `tx structure: ${N}`;
      }
    const w = fi(d, n.height, n.miner, o);
    if (w) return `apply: ${w}`;
    const x = si(d);
    if (Ze(x, n.stateRoot) !== 0) return "stateRoot mismatch";
    const D = A.work + hn(n.difficulty), M = { block: e, hash: i, work: D, state: d };
    this.blocks.set(s, M);
    const h = this.tipHash;
    D > this.tip.work && (this.tipHash = s);
    for (const E of this.acceptListeners) E(M);
    if (this.tipHash !== h && this.tipChangeListeners.size > 0) {
      const E = this.reorgDelta(h, this.tipHash);
      for (const N of this.tipChangeListeners) N(E);
    }
    return null;
  }
  /**
   * Diff two canonical tips by their hashes: walk both back to their common
   * ancestor. Txs on the old branch (above the ancestor) are `restored`
   * (return to mempool); txs on the new branch are `confirmed` (leave mempool).
   */
  reorgDelta(e, r) {
    const n = [], o = [];
    let i = e, s = r, c = this.blocks.get(i), A = this.blocks.get(s);
    for (; c && A && c.block.header.height > A.block.header.height; )
      n.push(c), i = k(c.block.header.prevHash), c = this.blocks.get(i);
    for (; c && A && A.block.header.height > c.block.header.height; )
      o.push(A), s = k(A.block.header.prevHash), A = this.blocks.get(s);
    for (; c && A && i !== s; )
      n.push(c), o.push(A), i = k(c.block.header.prevHash), s = k(A.block.header.prevHash), c = this.blocks.get(i), A = this.blocks.get(s);
    const f = [];
    for (const a of n) for (const u of a.block.transactions) f.push(u);
    const g = [];
    for (const a of o) for (const u of a.block.transactions) g.push(u);
    return { confirmed: g, restored: f, connected: o, disconnected: n };
  }
  /**
   * Variant of addBlock that lets the caller supply a pre-computed PoW result.
   * Used by the parallel verifier worker pool: the worker runs Argon2id in
   * parallel and the main thread feeds the verdict in here. State-dependent
   * checks still run sequentially.
   */
  async addBlockWithPow(e, r) {
    return r ? this.addBlockInternal(e, { skipPoW: !0, skipTxSig: !1 }) : "PoW invalid";
  }
  /** Number of stored blocks across all branches. Helpful for debugging/UI. */
  get size() {
    return this.blocks.size;
  }
  /** Hash of a header, hex-encoded. Convenience. */
  static hash(e) {
    return k(yt(e));
  }
  /** Pre-image hash for the header without nonce mutation — handy for the miner. */
  static headerBytes(e) {
    return zt(e);
  }
  /** Iterate the canonical chain (tip → genesis), used for explorer + persistence. */
  *iterateCanonical() {
    let e = this.tipHash;
    for (; e; ) {
      const r = this.blocks.get(e);
      if (!r || (yield r, r.block.header.height === 0)) return;
      e = k(r.block.header.prevHash);
    }
  }
  /** Headers along the canonical chain, genesis-first. */
  canonicalHeaders() {
    const e = [];
    for (const r of this.iterateCanonical()) e.push(r.block.header);
    return e.reverse();
  }
}
function gi(t) {
  return t && t.__esModule && Object.prototype.hasOwnProperty.call(t, "default") ? t.default : t;
}
var ht = {}, oe, dn;
function ui() {
  return dn || (dn = 1, oe = function() {
    return typeof Promise == "function" && Promise.prototype && Promise.prototype.then;
  }), oe;
}
var ie = {}, nt = {}, In;
function ct() {
  if (In) return nt;
  In = 1;
  let t;
  const e = [
    0,
    // Not used
    26,
    44,
    70,
    100,
    134,
    172,
    196,
    242,
    292,
    346,
    404,
    466,
    532,
    581,
    655,
    733,
    815,
    901,
    991,
    1085,
    1156,
    1258,
    1364,
    1474,
    1588,
    1706,
    1828,
    1921,
    2051,
    2185,
    2323,
    2465,
    2611,
    2761,
    2876,
    3034,
    3196,
    3362,
    3532,
    3706
  ];
  return nt.getSymbolSize = function(n) {
    if (!n) throw new Error('"version" cannot be null or undefined');
    if (n < 1 || n > 40) throw new Error('"version" should be in range from 1 to 40');
    return n * 4 + 17;
  }, nt.getSymbolTotalCodewords = function(n) {
    return e[n];
  }, nt.getBCHDigit = function(r) {
    let n = 0;
    for (; r !== 0; )
      n++, r >>>= 1;
    return n;
  }, nt.setToSJISFunction = function(n) {
    if (typeof n != "function")
      throw new Error('"toSJISFunc" is not a valid function.');
    t = n;
  }, nt.isKanjiModeEnabled = function() {
    return typeof t < "u";
  }, nt.toSJIS = function(n) {
    return t(n);
  }, nt;
}
var se = {}, Bn;
function Oe() {
  return Bn || (Bn = 1, (function(t) {
    t.L = { bit: 1 }, t.M = { bit: 0 }, t.Q = { bit: 3 }, t.H = { bit: 2 };
    function e(r) {
      if (typeof r != "string")
        throw new Error("Param is not a string");
      switch (r.toLowerCase()) {
        case "l":
        case "low":
          return t.L;
        case "m":
        case "medium":
          return t.M;
        case "q":
        case "quartile":
          return t.Q;
        case "h":
        case "high":
          return t.H;
        default:
          throw new Error("Unknown EC Level: " + r);
      }
    }
    t.isValid = function(n) {
      return n && typeof n.bit < "u" && n.bit >= 0 && n.bit < 4;
    }, t.from = function(n, o) {
      if (t.isValid(n))
        return n;
      try {
        return e(n);
      } catch {
        return o;
      }
    };
  })(se)), se;
}
var Ae, En;
function li() {
  if (En) return Ae;
  En = 1;
  function t() {
    this.buffer = [], this.length = 0;
  }
  return t.prototype = {
    get: function(e) {
      const r = Math.floor(e / 8);
      return (this.buffer[r] >>> 7 - e % 8 & 1) === 1;
    },
    put: function(e, r) {
      for (let n = 0; n < r; n++)
        this.putBit((e >>> r - n - 1 & 1) === 1);
    },
    getLengthInBits: function() {
      return this.length;
    },
    putBit: function(e) {
      const r = Math.floor(this.length / 8);
      this.buffer.length <= r && this.buffer.push(0), e && (this.buffer[r] |= 128 >>> this.length % 8), this.length++;
    }
  }, Ae = t, Ae;
}
var ce, Cn;
function hi() {
  if (Cn) return ce;
  Cn = 1;
  function t(e) {
    if (!e || e < 1)
      throw new Error("BitMatrix size must be defined and greater than 0");
    this.size = e, this.data = new Uint8Array(e * e), this.reservedBit = new Uint8Array(e * e);
  }
  return t.prototype.set = function(e, r, n, o) {
    const i = e * this.size + r;
    this.data[i] = n, o && (this.reservedBit[i] = !0);
  }, t.prototype.get = function(e, r) {
    return this.data[e * this.size + r];
  }, t.prototype.xor = function(e, r, n) {
    this.data[e * this.size + r] ^= n;
  }, t.prototype.isReserved = function(e, r) {
    return this.reservedBit[e * this.size + r];
  }, ce = t, ce;
}
var fe = {}, wn;
function di() {
  return wn || (wn = 1, (function(t) {
    const e = ct().getSymbolSize;
    t.getRowColCoords = function(n) {
      if (n === 1) return [];
      const o = Math.floor(n / 7) + 2, i = e(n), s = i === 145 ? 26 : Math.ceil((i - 13) / (2 * o - 2)) * 2, c = [i - 7];
      for (let A = 1; A < o - 1; A++)
        c[A] = c[A - 1] - s;
      return c.push(6), c.reverse();
    }, t.getPositions = function(n) {
      const o = [], i = t.getRowColCoords(n), s = i.length;
      for (let c = 0; c < s; c++)
        for (let A = 0; A < s; A++)
          c === 0 && A === 0 || // top-left
          c === 0 && A === s - 1 || // bottom-left
          c === s - 1 && A === 0 || o.push([i[c], i[A]]);
      return o;
    };
  })(fe)), fe;
}
var ae = {}, Qn;
function Ii() {
  if (Qn) return ae;
  Qn = 1;
  const t = ct().getSymbolSize, e = 7;
  return ae.getPositions = function(n) {
    const o = t(n);
    return [
      // top-left
      [0, 0],
      // top-right
      [o - e, 0],
      // bottom-left
      [0, o - e]
    ];
  }, ae;
}
var ge = {}, yn;
function Bi() {
  return yn || (yn = 1, (function(t) {
    t.Patterns = {
      PATTERN000: 0,
      PATTERN001: 1,
      PATTERN010: 2,
      PATTERN011: 3,
      PATTERN100: 4,
      PATTERN101: 5,
      PATTERN110: 6,
      PATTERN111: 7
    };
    const e = {
      N1: 3,
      N2: 3,
      N3: 40,
      N4: 10
    };
    t.isValid = function(o) {
      return o != null && o !== "" && !isNaN(o) && o >= 0 && o <= 7;
    }, t.from = function(o) {
      return t.isValid(o) ? parseInt(o, 10) : void 0;
    }, t.getPenaltyN1 = function(o) {
      const i = o.size;
      let s = 0, c = 0, A = 0, f = null, g = null;
      for (let a = 0; a < i; a++) {
        c = A = 0, f = g = null;
        for (let u = 0; u < i; u++) {
          let l = o.get(a, u);
          l === f ? c++ : (c >= 5 && (s += e.N1 + (c - 5)), f = l, c = 1), l = o.get(u, a), l === g ? A++ : (A >= 5 && (s += e.N1 + (A - 5)), g = l, A = 1);
        }
        c >= 5 && (s += e.N1 + (c - 5)), A >= 5 && (s += e.N1 + (A - 5));
      }
      return s;
    }, t.getPenaltyN2 = function(o) {
      const i = o.size;
      let s = 0;
      for (let c = 0; c < i - 1; c++)
        for (let A = 0; A < i - 1; A++) {
          const f = o.get(c, A) + o.get(c, A + 1) + o.get(c + 1, A) + o.get(c + 1, A + 1);
          (f === 4 || f === 0) && s++;
        }
      return s * e.N2;
    }, t.getPenaltyN3 = function(o) {
      const i = o.size;
      let s = 0, c = 0, A = 0;
      for (let f = 0; f < i; f++) {
        c = A = 0;
        for (let g = 0; g < i; g++)
          c = c << 1 & 2047 | o.get(f, g), g >= 10 && (c === 1488 || c === 93) && s++, A = A << 1 & 2047 | o.get(g, f), g >= 10 && (A === 1488 || A === 93) && s++;
      }
      return s * e.N3;
    }, t.getPenaltyN4 = function(o) {
      let i = 0;
      const s = o.data.length;
      for (let A = 0; A < s; A++) i += o.data[A];
      return Math.abs(Math.ceil(i * 100 / s / 5) - 10) * e.N4;
    };
    function r(n, o, i) {
      switch (n) {
        case t.Patterns.PATTERN000:
          return (o + i) % 2 === 0;
        case t.Patterns.PATTERN001:
          return o % 2 === 0;
        case t.Patterns.PATTERN010:
          return i % 3 === 0;
        case t.Patterns.PATTERN011:
          return (o + i) % 3 === 0;
        case t.Patterns.PATTERN100:
          return (Math.floor(o / 2) + Math.floor(i / 3)) % 2 === 0;
        case t.Patterns.PATTERN101:
          return o * i % 2 + o * i % 3 === 0;
        case t.Patterns.PATTERN110:
          return (o * i % 2 + o * i % 3) % 2 === 0;
        case t.Patterns.PATTERN111:
          return (o * i % 3 + (o + i) % 2) % 2 === 0;
        default:
          throw new Error("bad maskPattern:" + n);
      }
    }
    t.applyMask = function(o, i) {
      const s = i.size;
      for (let c = 0; c < s; c++)
        for (let A = 0; A < s; A++)
          i.isReserved(A, c) || i.xor(A, c, r(o, A, c));
    }, t.getBestMask = function(o, i) {
      const s = Object.keys(t.Patterns).length;
      let c = 0, A = 1 / 0;
      for (let f = 0; f < s; f++) {
        i(f), t.applyMask(f, o);
        const g = t.getPenaltyN1(o) + t.getPenaltyN2(o) + t.getPenaltyN3(o) + t.getPenaltyN4(o);
        t.applyMask(f, o), g < A && (A = g, c = f);
      }
      return c;
    };
  })(ge)), ge;
}
var Lt = {}, bn;
function lr() {
  if (bn) return Lt;
  bn = 1;
  const t = Oe(), e = [
    // L  M  Q  H
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    1,
    2,
    2,
    4,
    1,
    2,
    4,
    4,
    2,
    4,
    4,
    4,
    2,
    4,
    6,
    5,
    2,
    4,
    6,
    6,
    2,
    5,
    8,
    8,
    4,
    5,
    8,
    8,
    4,
    5,
    8,
    11,
    4,
    8,
    10,
    11,
    4,
    9,
    12,
    16,
    4,
    9,
    16,
    16,
    6,
    10,
    12,
    18,
    6,
    10,
    17,
    16,
    6,
    11,
    16,
    19,
    6,
    13,
    18,
    21,
    7,
    14,
    21,
    25,
    8,
    16,
    20,
    25,
    8,
    17,
    23,
    25,
    9,
    17,
    23,
    34,
    9,
    18,
    25,
    30,
    10,
    20,
    27,
    32,
    12,
    21,
    29,
    35,
    12,
    23,
    34,
    37,
    12,
    25,
    34,
    40,
    13,
    26,
    35,
    42,
    14,
    28,
    38,
    45,
    15,
    29,
    40,
    48,
    16,
    31,
    43,
    51,
    17,
    33,
    45,
    54,
    18,
    35,
    48,
    57,
    19,
    37,
    51,
    60,
    19,
    38,
    53,
    63,
    20,
    40,
    56,
    66,
    21,
    43,
    59,
    70,
    22,
    45,
    62,
    74,
    24,
    47,
    65,
    77,
    25,
    49,
    68,
    81
  ], r = [
    // L  M  Q  H
    7,
    10,
    13,
    17,
    10,
    16,
    22,
    28,
    15,
    26,
    36,
    44,
    20,
    36,
    52,
    64,
    26,
    48,
    72,
    88,
    36,
    64,
    96,
    112,
    40,
    72,
    108,
    130,
    48,
    88,
    132,
    156,
    60,
    110,
    160,
    192,
    72,
    130,
    192,
    224,
    80,
    150,
    224,
    264,
    96,
    176,
    260,
    308,
    104,
    198,
    288,
    352,
    120,
    216,
    320,
    384,
    132,
    240,
    360,
    432,
    144,
    280,
    408,
    480,
    168,
    308,
    448,
    532,
    180,
    338,
    504,
    588,
    196,
    364,
    546,
    650,
    224,
    416,
    600,
    700,
    224,
    442,
    644,
    750,
    252,
    476,
    690,
    816,
    270,
    504,
    750,
    900,
    300,
    560,
    810,
    960,
    312,
    588,
    870,
    1050,
    336,
    644,
    952,
    1110,
    360,
    700,
    1020,
    1200,
    390,
    728,
    1050,
    1260,
    420,
    784,
    1140,
    1350,
    450,
    812,
    1200,
    1440,
    480,
    868,
    1290,
    1530,
    510,
    924,
    1350,
    1620,
    540,
    980,
    1440,
    1710,
    570,
    1036,
    1530,
    1800,
    570,
    1064,
    1590,
    1890,
    600,
    1120,
    1680,
    1980,
    630,
    1204,
    1770,
    2100,
    660,
    1260,
    1860,
    2220,
    720,
    1316,
    1950,
    2310,
    750,
    1372,
    2040,
    2430
  ];
  return Lt.getBlocksCount = function(o, i) {
    switch (i) {
      case t.L:
        return e[(o - 1) * 4 + 0];
      case t.M:
        return e[(o - 1) * 4 + 1];
      case t.Q:
        return e[(o - 1) * 4 + 2];
      case t.H:
        return e[(o - 1) * 4 + 3];
      default:
        return;
    }
  }, Lt.getTotalCodewordsCount = function(o, i) {
    switch (i) {
      case t.L:
        return r[(o - 1) * 4 + 0];
      case t.M:
        return r[(o - 1) * 4 + 1];
      case t.Q:
        return r[(o - 1) * 4 + 2];
      case t.H:
        return r[(o - 1) * 4 + 3];
      default:
        return;
    }
  }, Lt;
}
var ue = {}, Qt = {}, pn;
function Ei() {
  if (pn) return Qt;
  pn = 1;
  const t = new Uint8Array(512), e = new Uint8Array(256);
  return (function() {
    let n = 1;
    for (let o = 0; o < 255; o++)
      t[o] = n, e[n] = o, n <<= 1, n & 256 && (n ^= 285);
    for (let o = 255; o < 512; o++)
      t[o] = t[o - 255];
  })(), Qt.log = function(n) {
    if (n < 1) throw new Error("log(" + n + ")");
    return e[n];
  }, Qt.exp = function(n) {
    return t[n];
  }, Qt.mul = function(n, o) {
    return n === 0 || o === 0 ? 0 : t[e[n] + e[o]];
  }, Qt;
}
var Dn;
function Ci() {
  return Dn || (Dn = 1, (function(t) {
    const e = Ei();
    t.mul = function(n, o) {
      const i = new Uint8Array(n.length + o.length - 1);
      for (let s = 0; s < n.length; s++)
        for (let c = 0; c < o.length; c++)
          i[s + c] ^= e.mul(n[s], o[c]);
      return i;
    }, t.mod = function(n, o) {
      let i = new Uint8Array(n);
      for (; i.length - o.length >= 0; ) {
        const s = i[0];
        for (let A = 0; A < o.length; A++)
          i[A] ^= e.mul(o[A], s);
        let c = 0;
        for (; c < i.length && i[c] === 0; ) c++;
        i = i.slice(c);
      }
      return i;
    }, t.generateECPolynomial = function(n) {
      let o = new Uint8Array([1]);
      for (let i = 0; i < n; i++)
        o = t.mul(o, new Uint8Array([1, e.exp(i)]));
      return o;
    };
  })(ue)), ue;
}
var le, mn;
function wi() {
  if (mn) return le;
  mn = 1;
  const t = Ci();
  function e(r) {
    this.genPoly = void 0, this.degree = r, this.degree && this.initialize(this.degree);
  }
  return e.prototype.initialize = function(n) {
    this.degree = n, this.genPoly = t.generateECPolynomial(this.degree);
  }, e.prototype.encode = function(n) {
    if (!this.genPoly)
      throw new Error("Encoder not initialized");
    const o = new Uint8Array(n.length + this.degree);
    o.set(n);
    const i = t.mod(o, this.genPoly), s = this.degree - i.length;
    if (s > 0) {
      const c = new Uint8Array(this.degree);
      return c.set(i, s), c;
    }
    return i;
  }, le = e, le;
}
var he = {}, de = {}, Ie = {}, Sn;
function hr() {
  return Sn || (Sn = 1, Ie.isValid = function(e) {
    return !isNaN(e) && e >= 1 && e <= 40;
  }), Ie;
}
var J = {}, Mn;
function dr() {
  if (Mn) return J;
  Mn = 1;
  const t = "[0-9]+", e = "[A-Z $%*+\\-./:]+";
  let r = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
  r = r.replace(/u/g, "\\u");
  const n = "(?:(?![A-Z0-9 $%*+\\-./:]|" + r + `)(?:.|[\r
]))+`;
  J.KANJI = new RegExp(r, "g"), J.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g"), J.BYTE = new RegExp(n, "g"), J.NUMERIC = new RegExp(t, "g"), J.ALPHANUMERIC = new RegExp(e, "g");
  const o = new RegExp("^" + r + "$"), i = new RegExp("^" + t + "$"), s = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
  return J.testKanji = function(A) {
    return o.test(A);
  }, J.testNumeric = function(A) {
    return i.test(A);
  }, J.testAlphanumeric = function(A) {
    return s.test(A);
  }, J;
}
var Rn;
function ft() {
  return Rn || (Rn = 1, (function(t) {
    const e = hr(), r = dr();
    t.NUMERIC = {
      id: "Numeric",
      bit: 1,
      ccBits: [10, 12, 14]
    }, t.ALPHANUMERIC = {
      id: "Alphanumeric",
      bit: 2,
      ccBits: [9, 11, 13]
    }, t.BYTE = {
      id: "Byte",
      bit: 4,
      ccBits: [8, 16, 16]
    }, t.KANJI = {
      id: "Kanji",
      bit: 8,
      ccBits: [8, 10, 12]
    }, t.MIXED = {
      bit: -1
    }, t.getCharCountIndicator = function(i, s) {
      if (!i.ccBits) throw new Error("Invalid mode: " + i);
      if (!e.isValid(s))
        throw new Error("Invalid version: " + s);
      return s >= 1 && s < 10 ? i.ccBits[0] : s < 27 ? i.ccBits[1] : i.ccBits[2];
    }, t.getBestModeForData = function(i) {
      return r.testNumeric(i) ? t.NUMERIC : r.testAlphanumeric(i) ? t.ALPHANUMERIC : r.testKanji(i) ? t.KANJI : t.BYTE;
    }, t.toString = function(i) {
      if (i && i.id) return i.id;
      throw new Error("Invalid mode");
    }, t.isValid = function(i) {
      return i && i.bit && i.ccBits;
    };
    function n(o) {
      if (typeof o != "string")
        throw new Error("Param is not a string");
      switch (o.toLowerCase()) {
        case "numeric":
          return t.NUMERIC;
        case "alphanumeric":
          return t.ALPHANUMERIC;
        case "kanji":
          return t.KANJI;
        case "byte":
          return t.BYTE;
        default:
          throw new Error("Unknown mode: " + o);
      }
    }
    t.from = function(i, s) {
      if (t.isValid(i))
        return i;
      try {
        return n(i);
      } catch {
        return s;
      }
    };
  })(de)), de;
}
var xn;
function Qi() {
  return xn || (xn = 1, (function(t) {
    const e = ct(), r = lr(), n = Oe(), o = ft(), i = hr(), s = 7973, c = e.getBCHDigit(s);
    function A(u, l, d) {
      for (let w = 1; w <= 40; w++)
        if (l <= t.getCapacity(w, d, u))
          return w;
    }
    function f(u, l) {
      return o.getCharCountIndicator(u, l) + 4;
    }
    function g(u, l) {
      let d = 0;
      return u.forEach(function(w) {
        const x = f(w.mode, l);
        d += x + w.getBitsLength();
      }), d;
    }
    function a(u, l) {
      for (let d = 1; d <= 40; d++)
        if (g(u, d) <= t.getCapacity(d, l, o.MIXED))
          return d;
    }
    t.from = function(l, d) {
      return i.isValid(l) ? parseInt(l, 10) : d;
    }, t.getCapacity = function(l, d, w) {
      if (!i.isValid(l))
        throw new Error("Invalid QR Code version");
      typeof w > "u" && (w = o.BYTE);
      const x = e.getSymbolTotalCodewords(l), D = r.getTotalCodewordsCount(l, d), M = (x - D) * 8;
      if (w === o.MIXED) return M;
      const h = M - f(w, l);
      switch (w) {
        case o.NUMERIC:
          return Math.floor(h / 10 * 3);
        case o.ALPHANUMERIC:
          return Math.floor(h / 11 * 2);
        case o.KANJI:
          return Math.floor(h / 13);
        case o.BYTE:
        default:
          return Math.floor(h / 8);
      }
    }, t.getBestVersionForData = function(l, d) {
      let w;
      const x = n.from(d, n.M);
      if (Array.isArray(l)) {
        if (l.length > 1)
          return a(l, x);
        if (l.length === 0)
          return 1;
        w = l[0];
      } else
        w = l;
      return A(w.mode, w.getLength(), x);
    }, t.getEncodedBits = function(l) {
      if (!i.isValid(l) || l < 7)
        throw new Error("Invalid QR Code version");
      let d = l << 12;
      for (; e.getBCHDigit(d) - c >= 0; )
        d ^= s << e.getBCHDigit(d) - c;
      return l << 12 | d;
    };
  })(he)), he;
}
var Be = {}, Nn;
function yi() {
  if (Nn) return Be;
  Nn = 1;
  const t = ct(), e = 1335, r = 21522, n = t.getBCHDigit(e);
  return Be.getEncodedBits = function(i, s) {
    const c = i.bit << 3 | s;
    let A = c << 10;
    for (; t.getBCHDigit(A) - n >= 0; )
      A ^= e << t.getBCHDigit(A) - n;
    return (c << 10 | A) ^ r;
  }, Be;
}
var Ee = {}, Ce, kn;
function bi() {
  if (kn) return Ce;
  kn = 1;
  const t = ft();
  function e(r) {
    this.mode = t.NUMERIC, this.data = r.toString();
  }
  return e.getBitsLength = function(n) {
    return 10 * Math.floor(n / 3) + (n % 3 ? n % 3 * 3 + 1 : 0);
  }, e.prototype.getLength = function() {
    return this.data.length;
  }, e.prototype.getBitsLength = function() {
    return e.getBitsLength(this.data.length);
  }, e.prototype.write = function(n) {
    let o, i, s;
    for (o = 0; o + 3 <= this.data.length; o += 3)
      i = this.data.substr(o, 3), s = parseInt(i, 10), n.put(s, 10);
    const c = this.data.length - o;
    c > 0 && (i = this.data.substr(o), s = parseInt(i, 10), n.put(s, c * 3 + 1));
  }, Ce = e, Ce;
}
var we, Fn;
function pi() {
  if (Fn) return we;
  Fn = 1;
  const t = ft(), e = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    " ",
    "$",
    "%",
    "*",
    "+",
    "-",
    ".",
    "/",
    ":"
  ];
  function r(n) {
    this.mode = t.ALPHANUMERIC, this.data = n;
  }
  return r.getBitsLength = function(o) {
    return 11 * Math.floor(o / 2) + 6 * (o % 2);
  }, r.prototype.getLength = function() {
    return this.data.length;
  }, r.prototype.getBitsLength = function() {
    return r.getBitsLength(this.data.length);
  }, r.prototype.write = function(o) {
    let i;
    for (i = 0; i + 2 <= this.data.length; i += 2) {
      let s = e.indexOf(this.data[i]) * 45;
      s += e.indexOf(this.data[i + 1]), o.put(s, 11);
    }
    this.data.length % 2 && o.put(e.indexOf(this.data[i]), 6);
  }, we = r, we;
}
var Qe, Un;
function Di() {
  if (Un) return Qe;
  Un = 1;
  const t = ft();
  function e(r) {
    this.mode = t.BYTE, typeof r == "string" ? this.data = new TextEncoder().encode(r) : this.data = new Uint8Array(r);
  }
  return e.getBitsLength = function(n) {
    return n * 8;
  }, e.prototype.getLength = function() {
    return this.data.length;
  }, e.prototype.getBitsLength = function() {
    return e.getBitsLength(this.data.length);
  }, e.prototype.write = function(r) {
    for (let n = 0, o = this.data.length; n < o; n++)
      r.put(this.data[n], 8);
  }, Qe = e, Qe;
}
var ye, Hn;
function mi() {
  if (Hn) return ye;
  Hn = 1;
  const t = ft(), e = ct();
  function r(n) {
    this.mode = t.KANJI, this.data = n;
  }
  return r.getBitsLength = function(o) {
    return o * 13;
  }, r.prototype.getLength = function() {
    return this.data.length;
  }, r.prototype.getBitsLength = function() {
    return r.getBitsLength(this.data.length);
  }, r.prototype.write = function(n) {
    let o;
    for (o = 0; o < this.data.length; o++) {
      let i = e.toSJIS(this.data[o]);
      if (i >= 33088 && i <= 40956)
        i -= 33088;
      else if (i >= 57408 && i <= 60351)
        i -= 49472;
      else
        throw new Error(
          "Invalid SJIS character: " + this.data[o] + `
Make sure your charset is UTF-8`
        );
      i = (i >>> 8 & 255) * 192 + (i & 255), n.put(i, 13);
    }
  }, ye = r, ye;
}
var be = { exports: {} }, Ln;
function Si() {
  return Ln || (Ln = 1, (function(t) {
    var e = {
      single_source_shortest_paths: function(r, n, o) {
        var i = {}, s = {};
        s[n] = 0;
        var c = e.PriorityQueue.make();
        c.push(n, 0);
        for (var A, f, g, a, u, l, d, w, x; !c.empty(); ) {
          A = c.pop(), f = A.value, a = A.cost, u = r[f] || {};
          for (g in u)
            u.hasOwnProperty(g) && (l = u[g], d = a + l, w = s[g], x = typeof s[g] > "u", (x || w > d) && (s[g] = d, c.push(g, d), i[g] = f));
        }
        if (typeof o < "u" && typeof s[o] > "u") {
          var D = ["Could not find a path from ", n, " to ", o, "."].join("");
          throw new Error(D);
        }
        return i;
      },
      extract_shortest_path_from_predecessor_list: function(r, n) {
        for (var o = [], i = n; i; )
          o.push(i), r[i], i = r[i];
        return o.reverse(), o;
      },
      find_path: function(r, n, o) {
        var i = e.single_source_shortest_paths(r, n, o);
        return e.extract_shortest_path_from_predecessor_list(
          i,
          o
        );
      },
      /**
       * A very naive priority queue implementation.
       */
      PriorityQueue: {
        make: function(r) {
          var n = e.PriorityQueue, o = {}, i;
          r = r || {};
          for (i in n)
            n.hasOwnProperty(i) && (o[i] = n[i]);
          return o.queue = [], o.sorter = r.sorter || n.default_sorter, o;
        },
        default_sorter: function(r, n) {
          return r.cost - n.cost;
        },
        /**
         * Add a new item to the queue and ensure the highest priority element
         * is at the front of the queue.
         */
        push: function(r, n) {
          var o = { value: r, cost: n };
          this.queue.push(o), this.queue.sort(this.sorter);
        },
        /**
         * Return the highest priority element in the queue.
         */
        pop: function() {
          return this.queue.shift();
        },
        empty: function() {
          return this.queue.length === 0;
        }
      }
    };
    t.exports = e;
  })(be)), be.exports;
}
var Tn;
function Mi() {
  return Tn || (Tn = 1, (function(t) {
    const e = ft(), r = bi(), n = pi(), o = Di(), i = mi(), s = dr(), c = ct(), A = Si();
    function f(D) {
      return unescape(encodeURIComponent(D)).length;
    }
    function g(D, M, h) {
      const E = [];
      let N;
      for (; (N = D.exec(h)) !== null; )
        E.push({
          data: N[0],
          index: N.index,
          mode: M,
          length: N[0].length
        });
      return E;
    }
    function a(D) {
      const M = g(s.NUMERIC, e.NUMERIC, D), h = g(s.ALPHANUMERIC, e.ALPHANUMERIC, D);
      let E, N;
      return c.isKanjiModeEnabled() ? (E = g(s.BYTE, e.BYTE, D), N = g(s.KANJI, e.KANJI, D)) : (E = g(s.BYTE_KANJI, e.BYTE, D), N = []), M.concat(h, E, N).sort(function(m, p) {
        return m.index - p.index;
      }).map(function(m) {
        return {
          data: m.data,
          mode: m.mode,
          length: m.length
        };
      });
    }
    function u(D, M) {
      switch (M) {
        case e.NUMERIC:
          return r.getBitsLength(D);
        case e.ALPHANUMERIC:
          return n.getBitsLength(D);
        case e.KANJI:
          return i.getBitsLength(D);
        case e.BYTE:
          return o.getBitsLength(D);
      }
    }
    function l(D) {
      return D.reduce(function(M, h) {
        const E = M.length - 1 >= 0 ? M[M.length - 1] : null;
        return E && E.mode === h.mode ? (M[M.length - 1].data += h.data, M) : (M.push(h), M);
      }, []);
    }
    function d(D) {
      const M = [];
      for (let h = 0; h < D.length; h++) {
        const E = D[h];
        switch (E.mode) {
          case e.NUMERIC:
            M.push([
              E,
              { data: E.data, mode: e.ALPHANUMERIC, length: E.length },
              { data: E.data, mode: e.BYTE, length: E.length }
            ]);
            break;
          case e.ALPHANUMERIC:
            M.push([
              E,
              { data: E.data, mode: e.BYTE, length: E.length }
            ]);
            break;
          case e.KANJI:
            M.push([
              E,
              { data: E.data, mode: e.BYTE, length: f(E.data) }
            ]);
            break;
          case e.BYTE:
            M.push([
              { data: E.data, mode: e.BYTE, length: f(E.data) }
            ]);
        }
      }
      return M;
    }
    function w(D, M) {
      const h = {}, E = { start: {} };
      let N = ["start"];
      for (let Q = 0; Q < D.length; Q++) {
        const m = D[Q], p = [];
        for (let C = 0; C < m.length; C++) {
          const I = m[C], B = "" + Q + C;
          p.push(B), h[B] = { node: I, lastCount: 0 }, E[B] = {};
          for (let S = 0; S < N.length; S++) {
            const y = N[S];
            h[y] && h[y].node.mode === I.mode ? (E[y][B] = u(h[y].lastCount + I.length, I.mode) - u(h[y].lastCount, I.mode), h[y].lastCount += I.length) : (h[y] && (h[y].lastCount = I.length), E[y][B] = u(I.length, I.mode) + 4 + e.getCharCountIndicator(I.mode, M));
          }
        }
        N = p;
      }
      for (let Q = 0; Q < N.length; Q++)
        E[N[Q]].end = 0;
      return { map: E, table: h };
    }
    function x(D, M) {
      let h;
      const E = e.getBestModeForData(D);
      if (h = e.from(M, E), h !== e.BYTE && h.bit < E.bit)
        throw new Error('"' + D + '" cannot be encoded with mode ' + e.toString(h) + `.
 Suggested mode is: ` + e.toString(E));
      switch (h === e.KANJI && !c.isKanjiModeEnabled() && (h = e.BYTE), h) {
        case e.NUMERIC:
          return new r(D);
        case e.ALPHANUMERIC:
          return new n(D);
        case e.KANJI:
          return new i(D);
        case e.BYTE:
          return new o(D);
      }
    }
    t.fromArray = function(M) {
      return M.reduce(function(h, E) {
        return typeof E == "string" ? h.push(x(E, null)) : E.data && h.push(x(E.data, E.mode)), h;
      }, []);
    }, t.fromString = function(M, h) {
      const E = a(M, c.isKanjiModeEnabled()), N = d(E), Q = w(N, h), m = A.find_path(Q.map, "start", "end"), p = [];
      for (let C = 1; C < m.length - 1; C++)
        p.push(Q.table[m[C]].node);
      return t.fromArray(l(p));
    }, t.rawSplit = function(M) {
      return t.fromArray(
        a(M, c.isKanjiModeEnabled())
      );
    };
  })(Ee)), Ee;
}
var Pn;
function Ri() {
  if (Pn) return ie;
  Pn = 1;
  const t = ct(), e = Oe(), r = li(), n = hi(), o = di(), i = Ii(), s = Bi(), c = lr(), A = wi(), f = Qi(), g = yi(), a = ft(), u = Mi();
  function l(Q, m) {
    const p = Q.size, C = i.getPositions(m);
    for (let I = 0; I < C.length; I++) {
      const B = C[I][0], S = C[I][1];
      for (let y = -1; y <= 7; y++)
        if (!(B + y <= -1 || p <= B + y))
          for (let R = -1; R <= 7; R++)
            S + R <= -1 || p <= S + R || (y >= 0 && y <= 6 && (R === 0 || R === 6) || R >= 0 && R <= 6 && (y === 0 || y === 6) || y >= 2 && y <= 4 && R >= 2 && R <= 4 ? Q.set(B + y, S + R, !0, !0) : Q.set(B + y, S + R, !1, !0));
    }
  }
  function d(Q) {
    const m = Q.size;
    for (let p = 8; p < m - 8; p++) {
      const C = p % 2 === 0;
      Q.set(p, 6, C, !0), Q.set(6, p, C, !0);
    }
  }
  function w(Q, m) {
    const p = o.getPositions(m);
    for (let C = 0; C < p.length; C++) {
      const I = p[C][0], B = p[C][1];
      for (let S = -2; S <= 2; S++)
        for (let y = -2; y <= 2; y++)
          S === -2 || S === 2 || y === -2 || y === 2 || S === 0 && y === 0 ? Q.set(I + S, B + y, !0, !0) : Q.set(I + S, B + y, !1, !0);
    }
  }
  function x(Q, m) {
    const p = Q.size, C = f.getEncodedBits(m);
    let I, B, S;
    for (let y = 0; y < 18; y++)
      I = Math.floor(y / 3), B = y % 3 + p - 8 - 3, S = (C >> y & 1) === 1, Q.set(I, B, S, !0), Q.set(B, I, S, !0);
  }
  function D(Q, m, p) {
    const C = Q.size, I = g.getEncodedBits(m, p);
    let B, S;
    for (B = 0; B < 15; B++)
      S = (I >> B & 1) === 1, B < 6 ? Q.set(B, 8, S, !0) : B < 8 ? Q.set(B + 1, 8, S, !0) : Q.set(C - 15 + B, 8, S, !0), B < 8 ? Q.set(8, C - B - 1, S, !0) : B < 9 ? Q.set(8, 15 - B - 1 + 1, S, !0) : Q.set(8, 15 - B - 1, S, !0);
    Q.set(C - 8, 8, 1, !0);
  }
  function M(Q, m) {
    const p = Q.size;
    let C = -1, I = p - 1, B = 7, S = 0;
    for (let y = p - 1; y > 0; y -= 2)
      for (y === 6 && y--; ; ) {
        for (let R = 0; R < 2; R++)
          if (!Q.isReserved(I, y - R)) {
            let P = !1;
            S < m.length && (P = (m[S] >>> B & 1) === 1), Q.set(I, y - R, P), B--, B === -1 && (S++, B = 7);
          }
        if (I += C, I < 0 || p <= I) {
          I -= C, C = -C;
          break;
        }
      }
  }
  function h(Q, m, p) {
    const C = new r();
    p.forEach(function(R) {
      C.put(R.mode.bit, 4), C.put(R.getLength(), a.getCharCountIndicator(R.mode, Q)), R.write(C);
    });
    const I = t.getSymbolTotalCodewords(Q), B = c.getTotalCodewordsCount(Q, m), S = (I - B) * 8;
    for (C.getLengthInBits() + 4 <= S && C.put(0, 4); C.getLengthInBits() % 8 !== 0; )
      C.putBit(0);
    const y = (S - C.getLengthInBits()) / 8;
    for (let R = 0; R < y; R++)
      C.put(R % 2 ? 17 : 236, 8);
    return E(C, Q, m);
  }
  function E(Q, m, p) {
    const C = t.getSymbolTotalCodewords(m), I = c.getTotalCodewordsCount(m, p), B = C - I, S = c.getBlocksCount(m, p), y = C % S, R = S - y, P = Math.floor(C / S), _ = Math.floor(B / S), St = _ + 1, Mt = P - _, Xt = new A(Mt);
    let Ct = 0;
    const Rt = new Array(S), qe = new Array(S);
    let Zt = 0;
    const Br = new Uint8Array(Q.buffer);
    for (let at = 0; at < S; at++) {
      const jt = at < R ? _ : St;
      Rt[at] = Br.slice(Ct, Ct + jt), qe[at] = Xt.encode(Rt[at]), Ct += jt, Zt = Math.max(Zt, jt);
    }
    const Wt = new Uint8Array(C);
    let Ve = 0, O, q;
    for (O = 0; O < Zt; O++)
      for (q = 0; q < S; q++)
        O < Rt[q].length && (Wt[Ve++] = Rt[q][O]);
    for (O = 0; O < Mt; O++)
      for (q = 0; q < S; q++)
        Wt[Ve++] = qe[q][O];
    return Wt;
  }
  function N(Q, m, p, C) {
    let I;
    if (Array.isArray(Q))
      I = u.fromArray(Q);
    else if (typeof Q == "string") {
      let P = m;
      if (!P) {
        const _ = u.rawSplit(Q);
        P = f.getBestVersionForData(_, p);
      }
      I = u.fromString(Q, P || 40);
    } else
      throw new Error("Invalid data");
    const B = f.getBestVersionForData(I, p);
    if (!B)
      throw new Error("The amount of data is too big to be stored in a QR Code");
    if (!m)
      m = B;
    else if (m < B)
      throw new Error(
        `
The chosen QR Code version cannot contain this amount of data.
Minimum version required to store current data is: ` + B + `.
`
      );
    const S = h(m, p, I), y = t.getSymbolSize(m), R = new n(y);
    return l(R, m), d(R), w(R, m), D(R, p, 0), m >= 7 && x(R, m), M(R, S), isNaN(C) && (C = s.getBestMask(
      R,
      D.bind(null, R, p)
    )), s.applyMask(C, R), D(R, p, C), {
      modules: R,
      version: m,
      errorCorrectionLevel: p,
      maskPattern: C,
      segments: I
    };
  }
  return ie.create = function(m, p) {
    if (typeof m > "u" || m === "")
      throw new Error("No input text");
    let C = e.M, I, B;
    return typeof p < "u" && (C = e.from(p.errorCorrectionLevel, e.M), I = f.from(p.version), B = s.from(p.maskPattern), p.toSJISFunc && t.setToSJISFunction(p.toSJISFunc)), N(m, I, C, B);
  }, ie;
}
var pe = {}, De = {}, Gn;
function Ir() {
  return Gn || (Gn = 1, (function(t) {
    function e(r) {
      if (typeof r == "number" && (r = r.toString()), typeof r != "string")
        throw new Error("Color should be defined as hex string");
      let n = r.slice().replace("#", "").split("");
      if (n.length < 3 || n.length === 5 || n.length > 8)
        throw new Error("Invalid hex color: " + r);
      (n.length === 3 || n.length === 4) && (n = Array.prototype.concat.apply([], n.map(function(i) {
        return [i, i];
      }))), n.length === 6 && n.push("F", "F");
      const o = parseInt(n.join(""), 16);
      return {
        r: o >> 24 & 255,
        g: o >> 16 & 255,
        b: o >> 8 & 255,
        a: o & 255,
        hex: "#" + n.slice(0, 6).join("")
      };
    }
    t.getOptions = function(n) {
      n || (n = {}), n.color || (n.color = {});
      const o = typeof n.margin > "u" || n.margin === null || n.margin < 0 ? 4 : n.margin, i = n.width && n.width >= 21 ? n.width : void 0, s = n.scale || 4;
      return {
        width: i,
        scale: i ? 4 : s,
        margin: o,
        color: {
          dark: e(n.color.dark || "#000000ff"),
          light: e(n.color.light || "#ffffffff")
        },
        type: n.type,
        rendererOpts: n.rendererOpts || {}
      };
    }, t.getScale = function(n, o) {
      return o.width && o.width >= n + o.margin * 2 ? o.width / (n + o.margin * 2) : o.scale;
    }, t.getImageWidth = function(n, o) {
      const i = t.getScale(n, o);
      return Math.floor((n + o.margin * 2) * i);
    }, t.qrToImageData = function(n, o, i) {
      const s = o.modules.size, c = o.modules.data, A = t.getScale(s, i), f = Math.floor((s + i.margin * 2) * A), g = i.margin * A, a = [i.color.light, i.color.dark];
      for (let u = 0; u < f; u++)
        for (let l = 0; l < f; l++) {
          let d = (u * f + l) * 4, w = i.color.light;
          if (u >= g && l >= g && u < f - g && l < f - g) {
            const x = Math.floor((u - g) / A), D = Math.floor((l - g) / A);
            w = a[c[x * s + D] ? 1 : 0];
          }
          n[d++] = w.r, n[d++] = w.g, n[d++] = w.b, n[d] = w.a;
        }
    };
  })(De)), De;
}
var _n;
function xi() {
  return _n || (_n = 1, (function(t) {
    const e = Ir();
    function r(o, i, s) {
      o.clearRect(0, 0, i.width, i.height), i.style || (i.style = {}), i.height = s, i.width = s, i.style.height = s + "px", i.style.width = s + "px";
    }
    function n() {
      try {
        return document.createElement("canvas");
      } catch {
        throw new Error("You need to specify a canvas element");
      }
    }
    t.render = function(i, s, c) {
      let A = c, f = s;
      typeof A > "u" && (!s || !s.getContext) && (A = s, s = void 0), s || (f = n()), A = e.getOptions(A);
      const g = e.getImageWidth(i.modules.size, A), a = f.getContext("2d"), u = a.createImageData(g, g);
      return e.qrToImageData(u.data, i, A), r(a, f, g), a.putImageData(u, 0, 0), f;
    }, t.renderToDataURL = function(i, s, c) {
      let A = c;
      typeof A > "u" && (!s || !s.getContext) && (A = s, s = void 0), A || (A = {});
      const f = t.render(i, s, A), g = A.type || "image/png", a = A.rendererOpts || {};
      return f.toDataURL(g, a.quality);
    };
  })(pe)), pe;
}
var me = {}, Kn;
function Ni() {
  if (Kn) return me;
  Kn = 1;
  const t = Ir();
  function e(o, i) {
    const s = o.a / 255, c = i + '="' + o.hex + '"';
    return s < 1 ? c + " " + i + '-opacity="' + s.toFixed(2).slice(1) + '"' : c;
  }
  function r(o, i, s) {
    let c = o + i;
    return typeof s < "u" && (c += " " + s), c;
  }
  function n(o, i, s) {
    let c = "", A = 0, f = !1, g = 0;
    for (let a = 0; a < o.length; a++) {
      const u = Math.floor(a % i), l = Math.floor(a / i);
      !u && !f && (f = !0), o[a] ? (g++, a > 0 && u > 0 && o[a - 1] || (c += f ? r("M", u + s, 0.5 + l + s) : r("m", A, 0), A = 0, f = !1), u + 1 < i && o[a + 1] || (c += r("h", g), g = 0)) : A++;
    }
    return c;
  }
  return me.render = function(i, s, c) {
    const A = t.getOptions(s), f = i.modules.size, g = i.modules.data, a = f + A.margin * 2, u = A.color.light.a ? "<path " + e(A.color.light, "fill") + ' d="M0 0h' + a + "v" + a + 'H0z"/>' : "", l = "<path " + e(A.color.dark, "stroke") + ' d="' + n(g, f, A.margin) + '"/>', d = 'viewBox="0 0 ' + a + " " + a + '"', x = '<svg xmlns="http://www.w3.org/2000/svg" ' + (A.width ? 'width="' + A.width + '" height="' + A.width + '" ' : "") + d + ' shape-rendering="crispEdges">' + u + l + `</svg>
`;
    return typeof c == "function" && c(null, x), x;
  }, me;
}
var vn;
function ki() {
  if (vn) return ht;
  vn = 1;
  const t = ui(), e = Ri(), r = xi(), n = Ni();
  function o(i, s, c, A, f) {
    const g = [].slice.call(arguments, 1), a = g.length, u = typeof g[a - 1] == "function";
    if (!u && !t())
      throw new Error("Callback required as last argument");
    if (u) {
      if (a < 2)
        throw new Error("Too few arguments provided");
      a === 2 ? (f = c, c = s, s = A = void 0) : a === 3 && (s.getContext && typeof f > "u" ? (f = A, A = void 0) : (f = A, A = c, c = s, s = void 0));
    } else {
      if (a < 1)
        throw new Error("Too few arguments provided");
      return a === 1 ? (c = s, s = A = void 0) : a === 2 && !s.getContext && (A = c, c = s, s = void 0), new Promise(function(l, d) {
        try {
          const w = e.create(c, A);
          l(i(w, s, A));
        } catch (w) {
          d(w);
        }
      });
    }
    try {
      const l = e.create(c, A);
      f(null, i(l, s, A));
    } catch (l) {
      f(l);
    }
  }
  return ht.create = e.create, ht.toCanvas = o.bind(null, r.render), ht.toDataURL = o.bind(null, r.renderToDataURL), ht.toString = o.bind(null, function(i, s, c) {
    return n.render(i, c);
  }), ht;
}
var Fi = ki();
const Ui = /* @__PURE__ */ gi(Fi);
function Oi(t) {
  return Ui.toString(t, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0d0f17", light: "#ffffff" }
  });
}
export {
  ur as Blockchain,
  sr as CHAIN_ID,
  Ar as COIN,
  ao as DIFFICULTY_WINDOW,
  Pt as GENESIS,
  Vt as GENESIS_DIFFICULTY_COMPACT,
  Bo as GENESIS_TIMESTAMP,
  fo as HALVING_INTERVAL,
  Je as HEADER_LEN,
  co as INITIAL_REWARD,
  uo as MAX_FUTURE_TIME_S,
  ne as MAX_MONEY,
  ho as MAX_TARGET,
  Gi as MIN_FEE_PER_BYTE,
  _e as MTP_WINDOW,
  xe as TARGET_BLOCK_TIME_S,
  cr as TX_ENCODED_LEN,
  Ti as addressFingerprint,
  Pi as addressFromHex,
  fi as applyBlockTxs,
  vi as blockHashHex,
  Io as blockReward,
  hn as blockWork,
  k as bytesToHex,
  ti as checkPoW,
  ii as cloneState,
  mt as compactToTarget,
  Ze as compareBytes,
  bo as computeTxRoot,
  Yi as decodeBlock,
  yo as decodeHeader,
  Co as decodeTx,
  oi as emptyState,
  Ji as encodeBlock,
  zt as encodeHeader,
  ve as encodeTx,
  Li as fromPrivateKey,
  Hi as generateKeyPair,
  ke as getAccount,
  yt as hashHeader,
  Cr as hashMeetsTarget,
  Er as hexToBytes,
  ri as medianTimePast,
  ei as nextDifficulty,
  Wo as powHash,
  Oi as qrSvg,
  Bt as sha256,
  so as sign,
  Ki as signTx,
  si as stateRoot,
  Xe as targetToCompact,
  _i as txHash,
  Ke as txPreimage,
  Qo as validateTxStructure,
  Ao as verify,
  wo as verifyTxSignature
};
