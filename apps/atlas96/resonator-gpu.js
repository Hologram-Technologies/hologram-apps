// resonator-gpu.js — the Resonator's WebGPU tier: the WHOLE 12,288-cell boundary lives ON the
// GPU. Structure DNA (the content-address bytes), positions, fibers, constraints, strain — all
// storage buffers; physics is WGSL compute (Jacobi position-based dynamics), rendering is
// storage-buffer instancing (the vertex stage pulls fiber endpoints straight from the physics
// buffer — zero per-frame CPU geometry). The projection mathematics mirrors the sealed
// resonator-geometry.js byte-for-byte in DNA terms: only the integer DNA is identity (Law L5);
// the trig here is presentation, same as the CPU tier. Falls back cleanly when WebGPU is absent.

const WG = 256;                                          // workgroup size
const TAU = Math.PI * 2;

const SIM_WGSL = /* wgsl */`
struct Sim {
  morph  : vec4f,            // x=k0, y=f, z=squeeze, w=applyField(0/1)
  rot4   : vec4f,            // c1, s1, c2, s2 — the 4D double rotation
  grab   : vec4f,            // xyz target · w = grab index (-1 none)
  field  : vec4f,            // xyz field delta · w = field on
  counts : vec4u,            // x=cells, y=renderEdges, z=shearEdges, w=pluckCount
  pluckI : vec4u,            // pluck cell indices
  plucks : array<vec4f, 4>,  // dir.xyz · mag
};
@group(0) @binding(0) var<uniform> sim : Sim;
@group(0) @binding(1) var<storage, read_write> pos  : array<vec4f>;   // xyz · w = strain
@group(0) @binding(2) var<storage, read_write> prev : array<vec4f>;
@group(0) @binding(3) var<storage, read_write> rest : array<vec4f>;
@group(0) @binding(4) var<storage, read_write> rlen : array<f32>;
@group(0) @binding(5) var<storage, read>       edges: array<vec2u>;
@group(0) @binding(6) var<storage, read_write> corr : array<atomic<i32>>;
@group(0) @binding(7) var<storage, read>       cell : array<vec4u>;   // dna w0 · dna w1 · class · 0
@group(0) @binding(8) var<storage, read_write> bins : array<atomic<u32>>; // 96 class bins + [96] budget

const PI2 = 6.28318530718;
fn dnaByte(i: u32, k: u32) -> f32 {                       // byte k of cell i's 8-byte DNA
  let w = select(cell[i].x, cell[i].y, k > 3u);
  return f32((w >> ((k & 3u) * 8u)) & 0xffu);
}
// the four projections of T² = Z48 × Z256 — mirrors resonator-geometry.js (presentation only)
fn project(i: u32, k: u32) -> vec3f {
  let p = f32(i >> 8u); let b = f32(i & 0xffu);
  let thB = PI2 * b / 256.0; let thP = PI2 * p / 48.0;
  if (k == 0u) { let th = PI2 * f32(i) / 12288.0; return vec3f(cos(th) * 300.0, 0.0, sin(th) * 300.0); }
  if (k == 1u) { return vec3f((b - 127.5) * 2.2, 0.0, (p - 23.5) * 6.0); }
  if (k == 2u) { let w = 152.0 + 60.0 * cos(thP);
    return vec3f(w * cos(thB), 60.0 * sin(thP), w * sin(thB)); }
  let q = 0.70710678;                                     // Clifford torus on S³, double-rotated
  let x = cos(thB) * q; let y = sin(thB) * q; let z = cos(thP) * q; let w4 = sin(thP) * q;
  let x2 = x * sim.rot4.x - w4 * sim.rot4.y; let w2 = x * sim.rot4.y + w4 * sim.rot4.x;
  let y2 = y * sim.rot4.z - z * sim.rot4.w;  let z2 = y * sim.rot4.w + z * sim.rot4.z;
  let s = 170.0 / (1.25 - w2);                            // stereographic
  return vec3f(x2 * s, y2 * s, z2 * s);
}
fn restOf(i: u32) -> vec3f {
  let k0 = u32(sim.morph.x); let f = sim.morph.y;
  var r = project(i, k0);
  if (f > 0.0) { r = mix(r, project(i, min(k0 + 1u, 3u)), f); }
  return r + (vec3f(dnaByte(i,0u), dnaByte(i,1u), dnaByte(i,2u)) - 128.0) / 127.0 * 2.6;
}

@compute @workgroup_size(${WG}) fn kRest(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= sim.counts.x) { return; }
  rest[i] = vec4f(restOf(i), 0.0);
}
@compute @workgroup_size(${WG}) fn kLen(@builtin(global_invocation_id) g: vec3u) {
  let j = g.x; if (j >= sim.counts.y + sim.counts.z) { return; }
  let e = edges[j];
  rlen[j] = max(distance(rest[e.x].xyz, rest[e.y].xyz), 1e-5);
}
@compute @workgroup_size(${WG}) fn kIntegrate(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= sim.counts.x) { return; }
  var x = pos[i].xyz;
  var v = (x - prev[i].xyz) * 0.9855;
  let sp = length(v); if (sp > 14.0) { v *= 14.0 / sp; }
  // plucks: kick a short run of the fiber (±2 cells), exactly like the CPU tier
  for (var k = 0u; k < sim.counts.w; k++) {
    let d = abs(i32(i) - i32(sim.pluckI[k]));
    if (d <= 2) { v += sim.plucks[k].xyz * sim.plucks[k].w * (1.0 - f32(d) * 0.3); }
  }
  prev[i] = vec4f(x, 0.0);
  x += v + (rest[i].xyz * sim.morph.z - x) * 0.02;
  if (sim.field.w > 0.5 && sim.morph.w > 0.5) {           // soft field: the whole structure follows
    let d2 = dot(x - sim.grab.xyz, x - sim.grab.xyz);
    x += sim.field.xyz * exp(-d2 / 18050.0) * 0.6;
  }
  pos[i] = vec4f(x, pos[i].w);
}
@compute @workgroup_size(${WG}) fn kEdge(@builtin(global_invocation_id) g: vec3u) {
  let j = g.x; let nT = sim.counts.y + sim.counts.z; if (j >= nT) { return; }
  let k = select(0.2, 0.42, j < sim.counts.y);            // fibers stiff, shear stabilizers soft
  let e = edges[j];
  let d = pos[e.y].xyz - pos[e.x].xyz;
  let L = max(length(d), 1e-5);
  let c = d * ((L - rlen[j]) / L * k * 0.5 * 65536.0);
  atomicAdd(&corr[e.x * 3u], i32(c.x)); atomicAdd(&corr[e.x * 3u + 1u], i32(c.y)); atomicAdd(&corr[e.x * 3u + 2u], i32(c.z));
  atomicSub(&corr[e.y * 3u], i32(c.x)); atomicSub(&corr[e.y * 3u + 1u], i32(c.y)); atomicSub(&corr[e.y * 3u + 2u], i32(c.z));
}
@compute @workgroup_size(${WG}) fn kApply(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= sim.counts.x) { return; }
  // Jacobi: every touching constraint accumulated at once, so normalize by the node's degree
  // (Gauss–Seidel re-reads positions between edges and needs no normalization — this does)
  let deg = max(1.0, f32(cell[i].w));
  var x = pos[i].xyz + vec3f(
    f32(atomicExchange(&corr[i * 3u], 0)),
    f32(atomicExchange(&corr[i * 3u + 1u], 0)),
    f32(atomicExchange(&corr[i * 3u + 2u], 0))) / 65536.0 / deg * 0.95;
  if (i32(i) == i32(sim.grab.w) && sim.field.w < 0.5) { x = mix(x, sim.grab.xyz, 0.55); }
  pos[i] = vec4f(x, pos[i].w);
}
@compute @workgroup_size(${WG}) fn kStrain(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= sim.counts.x) { return; }
  let s = distance(pos[i].xyz, rest[i].xyz * sim.morph.z);
  pos[i] = vec4f(pos[i].xyz, s);
  atomicAdd(&bins[cell[i].z], u32(s * 256.0));
  atomicAdd(&bins[96], u32(s * 256.0));
}`;

const RND_WGSL = /* wgsl */`
struct Rnd {
  mvp  : mat4x4f,
  vp   : vec4f,    // x=VW · y=VH · z=widthMul · w=alphaMul
  misc : vec4f,    // x=time · y=spacing · z=spriteMul · w=mode
  morph: vec4f,    // k0 · f · squeeze · 0   (ghost formula)
  rot4 : vec4f,
};
@group(0) @binding(0) var<uniform> R : Rnd;
@group(0) @binding(1) var<storage, read> pos   : array<vec4f>;
@group(0) @binding(2) var<storage, read> edges : array<vec2u>;
@group(0) @binding(3) var<storage, read> rlen  : array<f32>;
@group(0) @binding(4) var<storage, read> cell  : array<vec4u>;
@group(0) @binding(5) var<storage, read> col   : array<vec4f>;   // rgb · size

const PI2 = 6.28318530718;
const C6 = array<vec2f, 6>(vec2f(0.,-1.), vec2f(1.,-1.), vec2f(1.,1.), vec2f(0.,-1.), vec2f(1.,1.), vec2f(0.,1.));
fn dnaByte(i: u32, k: u32) -> f32 {
  let w = select(cell[i].x, cell[i].y, k > 3u);
  return f32((w >> ((k & 3u) * 8u)) & 0xffu);
}
fn nodeCol(i: u32) -> vec3f {
  let s = min(1.0, pos[i].w / R.misc.y * 0.9);
  let ph = dnaByte(i, 4u);
  let sh = 0.93 + 0.07 * sin(R.misc.x * (0.6 + ph / 300.0) + ph);
  return col[i].rgb * ((1.0 + s * 1.1) * sh) + vec3f(0.35, 0.28, 0.18) * s;
}
struct VOut { @builtin(position) p: vec4f, @location(0) c: vec3f, @location(1) g: f32, @location(2) y: f32 };

@vertex fn vLine(@builtin(vertex_index) vid: u32, @builtin(instance_index) inst: u32) -> VOut {
  let e = edges[inst]; let cn = C6[vid];
  var ca = R.mvp * vec4f(pos[e.x].xyz, 1.0);
  var cb = R.mvp * vec4f(pos[e.y].xyz, 1.0);
  var o: VOut;
  if (ca.w < 0.05 && cb.w < 0.05) { o.p = vec4f(0., 0., -3., 1.); o.c = vec3f(0.); o.g = 0.; o.y = 1.; return o; }
  ca.w = max(ca.w, 0.05); cb.w = max(cb.w, 0.05);
  let sa = ca.xy / ca.w * R.vp.xy * 0.5; let sb = cb.xy / cb.w * R.vp.xy * 0.5;
  let d = sb - sa; let L = max(length(d), 1e-4); let nrm = vec2f(-d.y, d.x) / L;
  let wl = max(distance(pos[e.x].xyz, pos[e.y].xyz), 1e-5);
  let glow = min(1.0, abs(wl / rlen[inst] - 1.0) * 9.0);
  let th = (dnaByte(e.x, 3u) + dnaByte(e.y, 3u)) / 510.0 * 1.5 + 0.8;
  var cc = mix(ca, cb, cn.x);
  let w = th * R.vp.z * (1.0 + glow * 1.5);
  cc = vec4f(cc.xy + nrm * (cn.y * w) / (R.vp.xy * 0.5) * cc.w, cc.zw);
  o.p = cc; o.c = (nodeCol(e.x) + nodeCol(e.y)) * 0.5; o.g = glow; o.y = cn.y;
  return o;
}
@fragment fn fLine(v: VOut) -> @location(0) vec4f {
  let t = 1.0 - abs(v.y); let a = R.vp.w * t * t;
  return vec4f((v.c * (1.0 + v.g * 1.9) + vec3f(0.42, 0.34, 0.2) * v.g) * a, 1.0);
}

// ghost: the bare formula (full lattice, no DNA artifacts) + amber residual whiskers
fn formula(i: u32) -> vec3f {
  let p = f32(i >> 8u); let b = f32(i & 0xffu);
  let thB = PI2 * b / 256.0; let thP = PI2 * p / 48.0;
  let k0 = u32(R.morph.x); let f = R.morph.y;
  var A: vec3f; var B: vec3f;
  for (var k = 0u; k < 2u; k++) {
    let kk = min(k0 + k, 3u); var r: vec3f;
    if (kk == 0u) { let th = PI2 * f32(i) / 12288.0; r = vec3f(cos(th) * 300.0, 0.0, sin(th) * 300.0); }
    else if (kk == 1u) { r = vec3f((b - 127.5) * 2.2, 0.0, (p - 23.5) * 6.0); }
    else if (kk == 2u) { let w = 152.0 + 60.0 * cos(thP); r = vec3f(w * cos(thB), 60.0 * sin(thP), w * sin(thB)); }
    else { let q = 0.70710678;
      let x = cos(thB) * q; let y = sin(thB) * q; let z = cos(thP) * q; let w4 = sin(thP) * q;
      let x2 = x * R.rot4.x - w4 * R.rot4.y; let w2 = x * R.rot4.y + w4 * R.rot4.x;
      let y2 = y * R.rot4.z - z * R.rot4.w;  let z2 = y * R.rot4.w + z * R.rot4.z;
      let s = 170.0 / (1.25 - w2); r = vec3f(x2 * s, y2 * s, z2 * s); }
    if (k == 0u) { A = r; } else { B = r; }
  }
  return mix(A, B, R.morph.y) * R.morph.z;
}
@vertex fn vGhost(@builtin(vertex_index) vid: u32, @builtin(instance_index) inst: u32) -> VOut {
  let cn = C6[vid];
  var a: vec3f; var b: vec3f; var color = vec3f(0.30, 0.33, 0.38); var wd = 0.7;
  if (inst < 12288u) { let i = inst; a = formula(i); b = formula((i & 0xff00u) | ((i + 1u) & 0xffu)); }
  else if (inst < 24576u) { let i = inst - 12288u;
    a = formula(i); b = formula(((((i >> 8u) + 1u) % 48u) << 8u) | (i & 0xffu)); }
  else { let i = (inst - 24576u) * 8u;                     // whisker: formula → artifact
    a = formula(i); b = pos[i].xyz; color = vec3f(0.95, 0.62, 0.12); wd = 1.0; }
  var ca = R.mvp * vec4f(a, 1.0); var cb = R.mvp * vec4f(b, 1.0);
  var o: VOut;
  if (ca.w < 0.05 && cb.w < 0.05) { o.p = vec4f(0., 0., -3., 1.); o.c = vec3f(0.); o.g = 0.; o.y = 1.; return o; }
  ca.w = max(ca.w, 0.05); cb.w = max(cb.w, 0.05);
  let sa = ca.xy / ca.w * R.vp.xy * 0.5; let sb = cb.xy / cb.w * R.vp.xy * 0.5;
  let d = sb - sa; let L = max(length(d), 1e-4); let nrm = vec2f(-d.y, d.x) / L;
  var cc = mix(ca, cb, cn.x);
  cc = vec4f(cc.xy + nrm * (cn.y * wd * R.vp.z) / (R.vp.xy * 0.5) * cc.w, cc.zw);
  o.p = cc; o.c = color; o.g = 0.0; o.y = cn.y;
  return o;
}

const Q4 = array<vec2f, 6>(vec2f(-1.,-1.), vec2f(1.,-1.), vec2f(1.,1.), vec2f(-1.,-1.), vec2f(1.,1.), vec2f(-1.,1.));
struct SOut { @builtin(position) p: vec4f, @location(0) c: vec3f, @location(1) uv: vec2f };
@vertex fn vSpr(@builtin(vertex_index) vid: u32, @builtin(instance_index) i: u32) -> SOut {
  let cn = Q4[vid];
  var cc = R.mvp * vec4f(pos[i].xyz, 1.0);
  var o: SOut;
  if (cc.w < 0.05) { o.p = vec4f(0., 0., -3., 1.); o.c = vec3f(0.); o.uv = vec2f(2.); return o; }
  let size = col[i].w * (1.0 + min(1.4, pos[i].w / R.misc.y)) * R.misc.z;
  cc = vec4f(cc.xy + cn * size / (R.vp.xy * 0.5) * cc.w, cc.zw);
  o.p = cc; o.c = nodeCol(i); o.uv = cn;
  return o;
}
@fragment fn fSpr(v: SOut) -> @location(0) vec4f {
  let d = length(v.uv);
  var a = pow(max(0.0, 1.0 - d), 2.2) + pow(max(0.0, 1.0 - d * 1.6), 6.0) * 0.9;
  return vec4f(v.c * a, 1.0);
}`;

export async function createGpuEngine({ canvas, dna, buildEdges, classOf, colors, cells }) {
  if (!navigator.gpu) return null;
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }); } catch { return null; }
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.addEventListener("uncapturederror", (e) => console.error("[webgpu]", e.error && e.error.message));
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const info = adapter.info || {};
  const maxDim = adapter.limits.maxTextureDimension2D;

  const N = cells;
  const simMod = device.createShaderModule({ code: SIM_WGSL });
  const rndMod = device.createShaderModule({ code: RND_WGSL });

  // ── persistent buffers ──
  const B = (size, usage) => device.createBuffer({ size, usage });
  const posB = B(N * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const prevB = B(N * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const restB = B(N * 16, GPUBufferUsage.STORAGE);
  const corrB = B(N * 12, GPUBufferUsage.STORAGE);
  const cellB = B(N * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const binsB = B(97 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const colB = B(N * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  // one sim uniform PER SUBSTEP: queue.writeBuffer lands before the whole submitted command
  // buffer runs, so two writes to one buffer would clobber substep 0's plucks/field gate
  const simBufs = [B(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), B(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)];
  const RND_SIZE = 64 + 4 * 16;
  const uHalo = B(RND_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const uCore = B(RND_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const uGhost = B(RND_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(colB, 0, colors);

  // ── compute pipelines (one shared layout: 1 uniform + 8 storage) ──
  const compLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ...[1, 2, 3, 4, 6, 8].map((b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } })),
    ...[5, 7].map((b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } })),
  ] });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [compLayout] });
  const kernel = (entry) => device.createComputePipeline({ layout: pl, compute: { module: simMod, entryPoint: entry } });
  const kRest = kernel("kRest"), kLen = kernel("kLen"), kIntegrate = kernel("kIntegrate"),
        kEdge = kernel("kEdge"), kApply = kernel("kApply"), kStrain = kernel("kStrain");

  // ── render pipelines ──
  const rndLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ...[1, 2, 3, 4, 5].map((b) => ({ binding: b, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } })),
  ] });
  const rpl = device.createPipelineLayout({ bindGroupLayouts: [rndLayout] });
  const additive = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } };
  const rPipe = (vs, fs) => device.createRenderPipeline({ layout: rpl,
    vertex: { module: rndMod, entryPoint: vs },
    fragment: { module: rndMod, entryPoint: fs, targets: [{ format, blend: additive }] },
    primitive: { topology: "triangle-list" } });
  const pLine = rPipe("vLine", "fLine"), pGhost = rPipe("vGhost", "fLine"), pSpr = rPipe("vSpr", "fSpr");

  // ── structure-dependent resources (rebuilt on tamper swap) ──
  let edgesB, rlenB, nE, nShear, nTotal, compBGs, bgHalo, bgCore, bgGhost;
  function setStructure(d) {
    const { render, shear } = buildEdges(d);
    nE = render.length / 2; nShear = shear.length / 2; nTotal = nE + nShear;
    const all = new Uint32Array(nTotal * 2); all.set(render); all.set(shear, render.length);
    edgesB = B(all.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(edgesB, 0, all);
    rlenB = B(nTotal * 4, GPUBufferUsage.STORAGE);
    const cellData = new Uint32Array(N * 4);
    const dnaWords = new Uint32Array(d.buffer, d.byteOffset, N * 2);
    for (let i = 0; i < N; i++) { cellData[i * 4] = dnaWords[i * 2]; cellData[i * 4 + 1] = dnaWords[i * 2 + 1]; cellData[i * 4 + 2] = classOf(i); }
    for (let j = 0; j < all.length; j++) cellData[all[j] * 4 + 3]++;        // constraint degree per node
    device.queue.writeBuffer(cellB, 0, cellData);
    compBGs = simBufs.map((sb) => device.createBindGroup({ layout: compLayout, entries: [
      { binding: 0, resource: { buffer: sb } }, { binding: 1, resource: { buffer: posB } },
      { binding: 2, resource: { buffer: prevB } }, { binding: 3, resource: { buffer: restB } },
      { binding: 4, resource: { buffer: rlenB } }, { binding: 5, resource: { buffer: edgesB } },
      { binding: 6, resource: { buffer: corrB } }, { binding: 7, resource: { buffer: cellB } },
      { binding: 8, resource: { buffer: binsB } } ] }));
    const rbg = (u) => device.createBindGroup({ layout: rndLayout, entries: [
      { binding: 0, resource: { buffer: u } }, { binding: 1, resource: { buffer: posB } },
      { binding: 2, resource: { buffer: edgesB } }, { binding: 3, resource: { buffer: rlenB } },
      { binding: 4, resource: { buffer: cellB } }, { binding: 5, resource: { buffer: colB } } ] });
    bgHalo = rbg(uHalo); bgCore = rbg(uCore); bgGhost = rbg(uGhost);
  }
  setStructure(dna);

  // ── sim uniform staging ──
  const simData = new ArrayBuffer(160);
  const simF = new Float32Array(simData), simU = new Uint32Array(simData);
  const plucks = [];                                       // queued {i, dir, mag}
  function writeSim(p, substepFirst, buf) {
    simF[0] = Math.min(3, Math.max(0, Math.floor(p.dim) - 1));
    simF[1] = (() => { const f0 = p.dim - 1 - simF[0]; return f0 <= 0 ? 0 : f0 * f0 * (3 - 2 * f0); })();
    simF[2] = p.squeeze; simF[3] = substepFirst ? 1 : 0;
    simF[4] = Math.cos(p.a4); simF[5] = Math.sin(p.a4); simF[6] = Math.cos(p.b4); simF[7] = Math.sin(p.b4);
    simF[8] = p.grabT[0]; simF[9] = p.grabT[1]; simF[10] = p.grabT[2]; simF[11] = p.grab;
    simF[12] = p.fieldDelta[0]; simF[13] = p.fieldDelta[1]; simF[14] = p.fieldDelta[2]; simF[15] = p.fieldGrab ? 1 : 0;
    simU[16] = N; simU[17] = nE; simU[18] = nShear;
    const np = substepFirst ? Math.min(4, plucks.length) : 0;
    simU[19] = np;
    for (let k = 0; k < 4; k++) {
      const pk = k < np ? plucks[k] : null;
      simU[20 + k] = pk ? pk.i : 0;
      simF[24 + k * 4] = pk ? pk.dir[0] : 0; simF[25 + k * 4] = pk ? pk.dir[1] : 0;
      simF[26 + k * 4] = pk ? pk.dir[2] : 0; simF[27 + k * 4] = pk ? pk.mag : 0;
    }
    if (substepFirst) plucks.splice(0, np);
    device.queue.writeBuffer(buf, 0, simData);
  }
  const rndData = new ArrayBuffer(RND_SIZE);
  const rndF = new Float32Array(rndData);
  function writeRnd(buf, mvp, vw, vh, wmul, amul, time, spacing, smul, p) {
    rndF.set(mvp, 0);
    rndF[16] = vw; rndF[17] = vh; rndF[18] = wmul; rndF[19] = amul;
    rndF[20] = time; rndF[21] = spacing; rndF[22] = smul; rndF[23] = 0;
    rndF[24] = Math.min(3, Math.max(0, Math.floor(p.dim) - 1));
    const f0 = p.dim - 1 - rndF[24]; rndF[25] = f0 <= 0 ? 0 : f0 * f0 * (3 - 2 * f0);
    rndF[26] = p.squeeze; rndF[27] = 0;
    rndF[28] = Math.cos(p.a4); rndF[29] = Math.sin(p.a4); rndF[30] = Math.cos(p.b4); rndF[31] = Math.sin(p.b4);
    device.queue.writeBuffer(buf, 0, rndData);
  }

  // ── async readbacks: strain bins + budget every frame, positions (picking) periodically ──
  const stBins = [B(512, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ), B(512, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)];
  const stPos = [B(N * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ), B(N * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)];
  const busy = new Map();
  const state = { budget: 50, classBins: new Float32Array(96), posMirror: new Float32Array(N * 4), mirrorFresh: false };
  function readback(staging, bytes, onData) {
    const buf = staging.find((b) => !busy.get(b));
    if (!buf) return null;
    busy.set(buf, true);
    return { buf, finish: () => buf.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
      onData(buf.getMappedRange(0, bytes)); buf.unmap(); busy.set(buf, false);
    }).catch(() => busy.set(buf, false)) };
  }

  const groups = (n) => Math.ceil(n / WG);
  function encodeCompute(enc, p, substeps) {
    for (let s = 0; s < substeps; s++) {
      writeSim(p, s === 0, simBufs[s % 2]);
      const c = enc.beginComputePass();
      c.setBindGroup(0, compBGs[s % 2]);
      if (s === 0) { c.setPipeline(kRest); c.dispatchWorkgroups(groups(N));
        c.setPipeline(kLen); c.dispatchWorkgroups(groups(nTotal)); }
      c.setPipeline(kIntegrate); c.dispatchWorkgroups(groups(N));
      for (let it = 0; it < 2; it++) {                     // 2 Jacobi iterations ≈ one GS sweep
        c.setPipeline(kEdge); c.dispatchWorkgroups(groups(nTotal));
        c.setPipeline(kApply); c.dispatchWorkgroups(groups(N));
      }
      if (s === substeps - 1) { c.setPipeline(kStrain); c.dispatchWorkgroups(groups(N)); }
      c.end();
    }
  }

  let frameNo = 0;
  return {
    tier: "webgpu",
    gpu: info.description || [info.vendor, info.architecture].filter(Boolean).join(" ") || "GPU",
    maxDim, device, state, setStructure,
    pluck: (i, dir, mag = 16) => plucks.push({ i, dir, mag }),
    resize(w, h) { canvas.width = Math.min(maxDim, w); canvas.height = Math.min(maxDim, h); },
    // one full simulated + rendered frame
    frame(p) {
      // p: {dim,a4,b4,squeeze,grab,grabT,fieldGrab,fieldDelta,mvp,time,spacing,exposure,ghost}
      const enc = device.createCommandEncoder();
      enc.clearBuffer(binsB);
      encodeCompute(enc, p, 2);
      const binsRb = readback(stBins, 97 * 4, (r) => { const u = new Uint32Array(r.slice(0));
        for (let c = 0; c < 96; c++) state.classBins[c] = u[c] / 256;
        state.budget = u[96] / 256 / N / p.spacing; });
      if (binsRb) enc.copyBufferToBuffer(binsB, 0, binsRb.buf, 0, 97 * 4);
      let posRb = null;
      if (frameNo % 5 === 0) { posRb = readback(stPos, N * 16, (r) => { state.posMirror.set(new Float32Array(r.slice(0))); state.mirrorFresh = true; });
        if (posRb) enc.copyBufferToBuffer(posB, 0, posRb.buf, 0, N * 16); }
      const vw = canvas.width, vh = canvas.height, ex = p.exposure;
      writeRnd(uGhost, p.mvp, vw, vh, p.dpr, 0.18, p.time, p.spacing, 0, p);
      writeRnd(uHalo, p.mvp, vw, vh, 5.6 * p.dpr, 0.12 * ex, p.time, p.spacing, 0, p);
      writeRnd(uCore, p.mvp, vw, vh, 1.7 * p.dpr, 1.0 * ex, p.time, p.spacing, p.dpr * (0.6 + 0.4 * ex), p);
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(),
        loadOp: "clear", clearValue: { r: 0.012, g: 0.02, b: 0.035, a: 1 }, storeOp: "store" }] });
      if (p.ghost) { pass.setPipeline(pGhost); pass.setBindGroup(0, bgGhost); pass.draw(6, 24576 + Math.ceil(N / 8)); }
      pass.setPipeline(pLine); pass.setBindGroup(0, bgHalo); pass.draw(6, nE);
      pass.setBindGroup(0, bgCore); pass.draw(6, nE);
      pass.setPipeline(pSpr); pass.setBindGroup(0, bgCore); pass.draw(6, N);
      pass.end();
      device.queue.submit([enc.finish()]);
      if (binsRb) binsRb.finish();
      if (posRb) posRb.finish();
      frameNo++;
    },
    // compute-only steps + a guaranteed budget readback (the witness path)
    async step(p, n) {
      for (let k = 0; k < n; k++) {
        const enc = device.createCommandEncoder();
        if (k === n - 1) enc.clearBuffer(binsB);
        encodeCompute(enc, p, 2);
        device.queue.submit([enc.finish()]);
      }
      const enc = device.createCommandEncoder();
      const st = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyBufferToBuffer(binsB, 0, st, 0, 97 * 4);
      device.queue.submit([enc.finish()]);
      await st.mapAsync(GPUMapMode.READ);
      const u = new Uint32Array(st.getMappedRange().slice(0));
      st.unmap(); st.destroy();
      for (let c = 0; c < 96; c++) state.classBins[c] = u[c] / 256;
      state.budget = u[96] / 256 / N / p.spacing;
      return state.budget;
    },
    seed(positions) {                                      // initial pos/prev upload
      const v4 = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) { v4[i * 4] = positions[i * 3]; v4[i * 4 + 1] = positions[i * 3 + 1]; v4[i * 4 + 2] = positions[i * 3 + 2]; }
      device.queue.writeBuffer(posB, 0, v4); device.queue.writeBuffer(prevB, 0, v4);
      state.posMirror.set(v4);
    },
    async readPos() {                                      // synchronous-style position stats (debug/witness)
      const st = device.createBuffer({ size: N * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(posB, 0, st, 0, N * 16);
      device.queue.submit([enc.finish()]);
      await st.mapAsync(GPUMapMode.READ);
      const a = new Float32Array(st.getMappedRange().slice(0));
      st.unmap(); st.destroy();
      state.posMirror.set(a);
      let mx = 0, sum = 0, nan = 0;
      for (let i = 0; i < N; i++) { const x = a[i * 4], y = a[i * 4 + 1], z = a[i * 4 + 2];
        if (!Number.isFinite(x + y + z)) { nan++; continue; }
        const r = Math.hypot(x, y, z); sum += r; if (r > mx) mx = r; }
      return { maxR: +mx.toFixed(1), meanR: +(sum / N).toFixed(1), nan, s0: [...a.slice(0, 4)].map((v) => +v.toFixed(2)) };
    },
  };
}
