// GGUF Forge — full-graph LoRA autograd (Tier-A). Backprop through the WHOLE dense
// transformer forward so LoRA adapters train end-to-end, not just an isolated linear.
//
// This is the piece the inference forge lacked: the vector-Jacobian product (vjp) of
// every op between the loss and the adapted linears — rms_norm, LoRA-adapted QKV, NEOX
// RoPE, causal multi-head attention (softmax jacobian), SwiGLU FFN, tied lm_head, and
// assistant-masked cross-entropy. Base weights are FROZEN; gradients flow only to the
// LoRA A/B params. Reuses the optimizer/checkpoint primitives in gguf-forge-lora-train.
//
// Computed in float64: this is an autograd-CORRECTNESS proof, witnessed by end-to-end
// finite-difference gradient checking (gguf-forge-lora-graph.test.mjs). The f32 fidelity
// of the underlying kernels is established separately in the inference path.
//
// Backward derivations (standard, hand-derived):
//   rms_norm:  dx = r·(g∘dy) − (r³/n)·x·Σ(x∘g∘dy),  r = 1/√(mean(x²)+eps)
//   linear(W frozen):  dx = Wᵀ·dy ;  LoRA: y=W·x+s·B(A·x) → dx += s·Aᵀ(Bᵀ·dy)
//   RoPE (rotation):   backward = rotate by −θ (orthogonal)
//   attention:  dv[s]=Σ_t p[t,s]dctx[t]; dscore[t,:]=p[t,:]∘(dp[t,:]−Σp[t,·]dp[t,·]);
//               dq[t]=Σ_s dscore[t,s]k[s]/√d; dk[s]=Σ_t dscore[t,s]q[t]/√d
//   SwiGLU:  a=silu(g)∘u; dg=da∘u∘silu'(g); du=da∘silu(g); silu'(z)=σ(1+z(1−σ))

import { maskedCrossEntropy } from "./gguf-forge-lora-train.mjs";

// Pure-f64 LoRA forward/backward for the autograd-correctness proof (the f32 inference
// versions in gguf-forge-lora-train.mjs round to binary32, whose ~1e-7 noise would swamp
// finite-difference gradient checking). Same math: y = W0·x + scale·B·(A·x).
function loraForward(W0, A, B, scale, x, { inn, out, r }) {
  const h = new Float64Array(r);
  for (let k = 0; k < r; k++) { let s = 0; for (let i = 0; i < inn; i++) s += A[k * inn + i] * x[i]; h[k] = s; }
  const y = new Float64Array(out);
  for (let o = 0; o < out; o++) { let s = 0; for (let i = 0; i < inn; i++) s += W0[o * inn + i] * x[i]; let bh = 0; for (let k = 0; k < r; k++) bh += B[o * r + k] * h[k]; y[o] = s + scale * bh; }
  return { y, h };
}
function loraBackward(B, scale, x, h, dy, { inn, out, r }) {
  const dB = new Float64Array(out * r), dA = new Float64Array(r * inn), dh = new Float64Array(r);
  for (let o = 0; o < out; o++) for (let k = 0; k < r; k++) dB[o * r + k] = scale * dy[o] * h[k];
  for (let k = 0; k < r; k++) { let s = 0; for (let o = 0; o < out; o++) s += B[o * r + k] * dy[o]; dh[k] = scale * s; }
  for (let k = 0; k < r; k++) for (let i = 0; i < inn; i++) dA[k * inn + i] = dh[k] * x[i];
  return { dA, dB };
}

const sig = (z) => 1 / (1 + Math.exp(-z));
const silu = (z) => z * sig(z);
const siluP = (z) => { const s = sig(z); return s * (1 + z * (1 - s)); };
const mv = (W, x, K, N) => { const y = new Float64Array(N); for (let n = 0; n < N; n++) { let s = 0; for (let k = 0; k < K; k++) s += W[n * K + k] * x[k]; y[n] = s; } return y; };
const mvT = (W, dy, K, N) => { const dx = new Float64Array(K); for (let n = 0; n < N; n++) for (let k = 0; k < K; k++) dx[k] += W[n * K + k] * dy[n]; return dx; };
const add = (a, b) => a.map((v, i) => v + b[i]);

function rms(x, g, eps) { let s = 0; for (const v of x) s += v * v; const r = 1 / Math.sqrt(s / x.length + eps); const y = x.map((v, i) => v * r * g[i]); return { y, r }; }
function rmsBack(x, g, r, dy) {
  const n = x.length; let dot = 0; for (let i = 0; i < n; i++) dot += x[i] * g[i] * dy[i];
  const c = (r * r * r) / n * dot; return x.map((xi, i) => r * g[i] * dy[i] - c * xi);
}
// NEOX RoPE on a [nHead·hd] vector at position pos; back = same with sin negated.
function rope(vec, pos, hd, freqBase, sign = 1) {
  const half = hd / 2, nH = vec.length / hd, out = Float64Array.from(vec);
  for (let h = 0; h < nH; h++) for (let i = 0; i < half; i++) {
    const th = pos * Math.pow(freqBase, -2 * i / hd), c = Math.cos(th), sn = sign * Math.sin(th), o = h * hd;
    const x0 = vec[o + i], x1 = vec[o + i + half];
    out[o + i] = x0 * c - x1 * sn; out[o + i + half] = x0 * sn + x1 * c;
  }
  return out;
}

// Full forward over a token sequence; caches everything backward needs.
export function forwardCache(M, tokens) {
  const { D, NH, HD, FF, V, eps, freqBase, scale } = M, T = tokens.length, ASC = 1 / Math.sqrt(HD);
  const c = { T, h: [], xn: [], rA: [], q: [], k: [], v: [], qr: [], kr: [], p: [], ctx: [], h1: [], xn2: [], rF: [], gate: [], up: [], act: [], h2: [], xf: [], rO: [], logits: new Float64Array(T * V), loraQ: [], loraV: [] };
  for (let t = 0; t < T; t++) c.h.push(Float64Array.from(M.tok_embd.slice(tokens[t] * D, tokens[t] * D + D)));
  // attention needs all positions' k/v before any ctx — do projections first
  for (let t = 0; t < T; t++) {
    const { y: xn, r: rA } = rms(c.h[t], M.attn_norm, eps); c.xn[t] = xn; c.rA[t] = rA;
    const fq = loraForward(M.Wq, M.Aq, M.Bq, scale, xn, { inn: D, out: D, r: M.rank }); c.loraQ[t] = fq.h;
    const fv = loraForward(M.Wv, M.Av, M.Bv, scale, xn, { inn: D, out: D, r: M.rank }); c.loraV[t] = fv.h;
    c.q[t] = fq.y; c.v[t] = fv.y; c.k[t] = mv(M.Wk, xn, D, D);
    c.qr[t] = rope(c.q[t], t, HD, freqBase); c.kr[t] = rope(c.k[t], t, HD, freqBase);
  }
  for (let t = 0; t < T; t++) {
    const ctx = new Float64Array(D), pT = [];
    for (let h = 0; h < NH; h++) {
      const sc = new Float64Array(t + 1);
      for (let s = 0; s <= t; s++) { let d = 0; for (let i = 0; i < HD; i++) d += c.qr[t][h * HD + i] * c.kr[s][h * HD + i]; sc[s] = d * ASC; }
      let mx = -Infinity; for (const z of sc) mx = Math.max(mx, z); let Z = 0; const p = new Float64Array(t + 1);
      for (let s = 0; s <= t; s++) { p[s] = Math.exp(sc[s] - mx); Z += p[s]; } for (let s = 0; s <= t; s++) p[s] /= Z;
      for (let i = 0; i < HD; i++) { let a = 0; for (let s = 0; s <= t; s++) a += p[s] * c.v[s][h * HD + i]; ctx[h * HD + i] = a; }
      pT.push(p);
    }
    c.p[t] = pT; c.ctx[t] = ctx;
    const ao = mv(M.Wo, ctx, D, D); c.h1[t] = add(c.h[t], ao);
    const { y: xn2, r: rF } = rms(c.h1[t], M.ffn_norm, eps); c.xn2[t] = xn2; c.rF[t] = rF;
    const gate = mv(M.Wg, xn2, D, FF), up = mv(M.Wu, xn2, D, FF), act = new Float64Array(FF);
    for (let i = 0; i < FF; i++) act[i] = silu(gate[i]) * up[i];
    c.gate[t] = gate; c.up[t] = up; c.act[t] = act;
    const ff = mv(M.Wd, act, FF, D); c.h2[t] = add(c.h1[t], ff);
    const { y: xf, r: rO } = rms(c.h2[t], M.out_norm, eps); c.xf[t] = xf; c.rO[t] = rO;
    const lg = mv(M.tok_embd, xf, D, V); for (let j = 0; j < V; j++) c.logits[t * V + j] = lg[j];
  }
  return c;
}

// Backward: given dLogits (per position), return grads for the LoRA params only.
export function backward(M, tokens, c, dLogits) {
  const { D, NH, HD, FF, V, freqBase, scale, rank } = M, T = c.T, ASC = 1 / Math.sqrt(HD);
  const dAq = new Float64Array(rank * D), dBq = new Float64Array(D * rank), dAv = new Float64Array(rank * D), dBv = new Float64Array(D * rank);
  const dQr = Array.from({ length: T }, () => new Float64Array(D)), dKr = Array.from({ length: T }, () => new Float64Array(D)), dV = Array.from({ length: T }, () => new Float64Array(D)), dXn = Array.from({ length: T }, () => null);
  // pass 1: per-position back to ctx/h1, then to qr/kr/v contributions (attention couples positions)
  const dCtx = Array.from({ length: T }, () => new Float64Array(D)), dH1 = Array.from({ length: T }, () => new Float64Array(D));
  for (let t = 0; t < T; t++) {
    const dxf = mvT(M.tok_embd, dLogits.subarray(t * V, t * V + V), D, V); // lm_head (frozen, tied)
    const dh2 = rmsBack(c.h2[t], M.out_norm, c.rO[t], dxf);
    // ffn: h2 = h1 + Wd·act ; act=silu(gate)∘up
    const dact = mvT(M.Wd, dh2, FF, D), dgate = new Float64Array(FF), dup = new Float64Array(FF);
    for (let i = 0; i < FF; i++) { dgate[i] = dact[i] * c.up[t][i] * siluP(c.gate[t][i]); dup[i] = dact[i] * silu(c.gate[t][i]); }
    const dxn2 = add(mvT(M.Wg, dgate, D, FF), mvT(M.Wu, dup, D, FF));
    const dh1 = add(dh2, rmsBack(c.h1[t], M.ffn_norm, c.rF[t], dxn2)); // residual: h2=h1+ff
    dH1[t] = dh1;
    dCtx[t] = mvT(M.Wo, dh1, D, D);                                    // h1 = h + Wo·ctx
  }
  // pass 2: attention backward (couples positions) → dqr/dkr/dv
  for (let t = 0; t < T; t++) for (let h = 0; h < NH; h++) {
    const p = c.p[t][h], dp = new Float64Array(t + 1);
    for (let s = 0; s <= t; s++) { let d = 0; for (let i = 0; i < HD; i++) d += dCtx[t][h * HD + i] * c.v[s][h * HD + i]; dp[s] = d; }
    for (let s = 0; s <= t; s++) for (let i = 0; i < HD; i++) dV[s][h * HD + i] += p[s] * dCtx[t][h * HD + i];
    let psum = 0; for (let s = 0; s <= t; s++) psum += p[s] * dp[s];
    const dsc = new Float64Array(t + 1); for (let s = 0; s <= t; s++) dsc[s] = p[s] * (dp[s] - psum);
    for (let i = 0; i < HD; i++) { for (let s = 0; s <= t; s++) { dQr[t][h * HD + i] += dsc[s] * c.kr[s][h * HD + i] * ASC; dKr[s][h * HD + i] += dsc[s] * c.qr[t][h * HD + i] * ASC; } }
  }
  // pass 3: rope back → dq/dk ; then linears → LoRA grads + dxn ; rms back → dh ; (h grad to embd dropped, frozen)
  for (let t = 0; t < T; t++) {
    const dq = rope(dQr[t], t, HD, freqBase, -1), dk = rope(dKr[t], t, HD, freqBase, -1); // rotation transpose
    // q = Wq·xn + scale·Bq·(Aq·xn) ; v likewise ; k = Wk·xn (frozen)
    const gq = loraBackward(M.Bq, scale, c.xn[t], c.loraQ[t], dq, { inn: D, out: D, r: rank });
    const gv = loraBackward(M.Bv, scale, c.xn[t], c.loraV[t], dV[t], { inn: D, out: D, r: rank });
    for (let i = 0; i < dAq.length; i++) { dAq[i] += gq.dA[i]; dAv[i] += gv.dA[i]; }
    for (let i = 0; i < dBq.length; i++) { dBq[i] += gq.dB[i]; dBv[i] += gv.dB[i]; }
    // dxn from all three projections (base + lora) — not needed for LoRA grads, but completes
    // the chain if embeddings were trainable. Frozen embd → we stop here.
  }
  return { dAq, dBq, dAv, dBv };
}

// Convenience: forward + masked-CE loss + backward → loss and LoRA grads.
export function lossAndGrads(M, tokens, targets, mask) {
  const c = forwardCache(M, tokens);
  const { loss, dLogits } = maskedCrossEntropy(c.logits, targets, mask, c.T, M.V);
  return { loss, grads: backward(M, tokens, c, dLogits), logits: c.logits };
}
