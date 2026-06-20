// backdrop.mjs — Three.js (WebGL) 3D worlds behind the Holo v86 monitor.
//
// A pluggable theme system: each theme is {init, update, dispose}. The manager owns one renderer/
// scene/camera, runs the active theme, parallaxes the camera with the mouse, and pauses when hidden
// (the monitor + live OS run in front and must keep their frames). Procedural only — no assets, no
// trademarked marks: original art that EVOKES each universe. Uses the global THREE (UMD <script>).
//
//   import * as Backdrop from "./backdrop.mjs"
//   Backdrop.available()           -> WebGL present AND motion allowed
//   await Backdrop.start(canvas, themeName)
//   Backdrop.setTheme(name) · Backdrop.play() · Backdrop.pause() · Backdrop.dispose()

let T, renderer, scene, camera, raf = 0, running = false, theme = null, curThemeName = "galactic";
const mouse = { x: 0, y: 0 }, target = { x: 0, y: 0 };
export const THEMES = ["galactic", "bridge", "improbability"];

export function available() {
  try {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch { return false; }
}
const waitTHREE = () => new Promise((res, rej) => { let n = 0; (function p() {
  if (window.THREE) return res(window.THREE); if (n++ > 120) return rej(new Error("THREE not loaded")); setTimeout(p, 50); })(); });

// ── shared procedural textures (soft dot / colored glow) ───────────────────────────
function dot(alpha) {
  const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, `rgba(255,255,255,${alpha})`); grd.addColorStop(0.35, `rgba(255,255,255,${alpha * 0.5})`); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64); const t = new T.CanvasTexture(c); t.needsUpdate = true; return t;
}
function glowSprite(r, g, b, scale) {
  const tex = dot(1.0);
  const m = new T.SpriteMaterial({ map: tex, color: new T.Color(r, g, b), blending: T.AdditiveBlending, transparent: true, depthWrite: false });
  const s = new T.Sprite(m); s.scale.set(scale, scale, 1); return s;
}
function starfield(count, radius, size, alpha) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { const u = Math.random(), v = Math.random();
    const th = u * 2 * Math.PI, ph = Math.acos(2 * v - 1), r = radius * (0.6 + 0.4 * Math.random());
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(ph); }
  const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3));
  const mat = new T.PointsMaterial({ size, map: dot(alpha), transparent: true, depthWrite: false, blending: T.AdditiveBlending, color: 0x9fb6e0, sizeAttenuation: true });
  return new T.Points(geo, mat);
}

// ── THEMES ──────────────────────────────────────────────────────────────────────────
const Galactic = {                                   // Foundation: a vast slow spiral galaxy + Trantor glow
  o: [],
  init(scene, camera) {
    camera.position.set(0, 26, 78); camera.lookAt(0, 0, 0);
    const sky = starfield(1400, 600, 1.4, 0.5); scene.add(sky); this.o.push(sky);
    const grp = new T.Group(); grp.rotation.x = -0.62; scene.add(grp); this.o.push(grp); this.grp = grp;
    const N = 9000, R = 62, arms = 4, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const core = new T.Color(1.0, 0.86, 0.55), edge = new T.Color(0.42, 0.55, 1.0);
    for (let i = 0; i < N; i++) {
      const r = Math.pow(Math.random(), 0.55) * R, arm = i % arms;
      const ang = r * 0.16 + arm * (2 * Math.PI / arms) + (Math.random() - 0.5) * 0.55;
      pos[i * 3] = Math.cos(ang) * r + (Math.random() - 0.5) * 2;
      pos[i * 3 + 2] = Math.sin(ang) * r + (Math.random() - 0.5) * 2;
      pos[i * 3 + 1] = (Math.random() - 0.5) * Math.pow(1 - r / R, 2) * 9;
      const c = core.clone().lerp(edge, r / R); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3)); geo.setAttribute("color", new T.BufferAttribute(col, 3));
    const mat = new T.PointsMaterial({ size: 0.7, map: dot(0.9), vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true });
    const gal = new T.Points(geo, mat); grp.add(gal);
    const coreGlow = glowSprite(1.0, 0.82, 0.5, 36); grp.add(coreGlow);
    const trantor = glowSprite(1.0, 0.72, 0.4, 120); trantor.position.set(38, -10, -30); scene.add(trantor); this.o.push(trantor);
  },
  update(t, m, camera) { if (this.grp) this.grp.rotation.y = t * 0.025;
    camera.position.x += (m.x * 22 - camera.position.x) * 0.04; camera.position.y += (26 - m.y * 14 - camera.position.y) * 0.04; camera.lookAt(0, 0, 0); },
  dispose(scene) { for (const x of this.o) scene.remove(x); this.o = []; this.grp = null; },
};

const Bridge = {                                     // Star Trek: warp starfield + viewscreen horizon glow
  o: [], warp: 60,
  init(scene, camera) {
    camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1);
    const N = 1800, pos = new Float32Array(N * 3); this.N = N;
    for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 120; pos[i * 3 + 1] = (Math.random() - 0.5) * 120; pos[i * 3 + 2] = -Math.random() * 400; }
    const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    const mat = new T.PointsMaterial({ size: 1.3, map: dot(0.95), transparent: true, depthWrite: false, blending: T.AdditiveBlending, color: 0xbfe3ff, sizeAttenuation: true });
    this.stars = new T.Points(geo, mat); scene.add(this.stars); this.o.push(this.stars);
    const horizon = glowSprite(0.3, 0.7, 1.0, 220); horizon.position.set(0, -70, -180); scene.add(horizon); this.o.push(horizon);
  },
  update(t, m, camera) {
    const p = this.stars.geometry.attributes.position, a = p.array;
    for (let i = 0; i < this.N; i++) { a[i * 3 + 2] += this.warp * 0.016; if (a[i * 3 + 2] > 2) { a[i * 3 + 2] = -400; a[i * 3] = (Math.random() - 0.5) * 120; a[i * 3 + 1] = (Math.random() - 0.5) * 120; } }
    p.needsUpdate = true; this.warp += (60 - this.warp) * 0.02;
    camera.rotation.y += (m.x * 0.25 - camera.rotation.y) * 0.05; camera.rotation.x += (-m.y * 0.18 - camera.rotation.x) * 0.05;
  },
  boost() { this.warp = 420; },                      // call on boot/transition for a warp surge
  dispose(scene) { for (const x of this.o) scene.remove(x); this.o = []; this.stars = null; },
};

const Improbability = {                              // Hitchhiker's: playful drift, towel-blue, wonder
  o: [], shapes: [],
  init(scene, camera) {
    scene.background = new T.Color(0x081226); camera.position.set(0, 0, 60); camera.lookAt(0, 0, 0);
    const sky = starfield(900, 400, 1.6, 0.45); scene.add(sky); this.o.push(sky);
    const palette = [0x8fd0ff, 0x6fa8dc, 0xffd27f, 0xb0e0a8];
    const geoms = [() => new T.IcosahedronGeometry(4 + Math.random() * 4, 0), () => new T.TorusKnotGeometry(3, 1, 64, 8), () => new T.OctahedronGeometry(5)];
    for (let i = 0; i < 34; i++) {
      const g = geoms[i % geoms.length]();
      const mat = new T.MeshBasicMaterial({ color: palette[i % palette.length], wireframe: true, transparent: true, opacity: 0.55 });
      const mesh = new T.Mesh(g, mat);
      mesh.position.set((Math.random() - 0.5) * 120, (Math.random() - 0.5) * 80, -Math.random() * 140);
      mesh.userData = { sx: (Math.random() - 0.5) * 0.4, sy: (Math.random() - 0.5) * 0.4, dy: (Math.random() - 0.5) * 0.04 };
      scene.add(mesh); this.shapes.push(mesh); this.o.push(mesh);
    }
    const glow = glowSprite(0.5, 0.7, 1.0, 90); glow.position.set(-30, 20, -60); scene.add(glow); this.o.push(glow);
  },
  update(t, m, camera) {
    for (const s of this.shapes) { s.rotation.x += s.userData.sx * 0.02; s.rotation.y += s.userData.sy * 0.02; s.position.y += s.userData.dy; if (s.position.y > 50) s.position.y = -50; }
    camera.position.x += (m.x * 16 - camera.position.x) * 0.04; camera.position.y += (-m.y * 12 - camera.position.y) * 0.04; camera.lookAt(0, 0, -40);
  },
  dispose(scene) { scene.background = null; for (const x of this.o) scene.remove(x); this.o = []; this.shapes = []; },
};

const REG = { galactic: Galactic, bridge: Bridge, improbability: Improbability };

// ── 3D MACHINE OBJECT MODE — hyper-real, themed, orbitable, live-textured (stage 1: view-only) ──
// Each theme binds to an iconic computer FORM (original art — no marks): galactic→CRT tube,
// bridge→compact all-in-one, improbability→amber terminal. The live OS textures the (curved) glass.
// The machine is lifted clear of the theme's busy center so it reads as the hero floating in a world.
let objMode = false, mon = null, screenTex = null, screenSrc = null, monLights = null, monKind = null;
let entrance = 0;                                              // 0→1 entrance ease
const LIFT = 18;                                              // raise the machine above each theme's core
const orbit = { th: 0, ph: 1.4, r: 16, tth: 0, tph: 1.42, tr: 16, drag: false, px: 0, py: 0 };
const MACHINE = {
  galactic:      { kind: "crt",      shell: 0x14171c, trim: 0x05070b, glow: 0x9fd2ff, scan: 0.16, curve: 0.62, screenW: 7.0 },
  bridge:        { kind: "allinone", shell: 0xd8d1c1, trim: 0xb7ae9c, glow: 0xd6ecff, scan: 0.0,  curve: 0.16, screenW: 5.6 },
  improbability: { kind: "amber",    shell: 0x2c2720, trim: 0x12100b, glow: 0xffae42, scan: 0.20, curve: 0.42, screenW: 6.2, tint: 0xffbe5e },
};
function canvasTex(draw, w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); const t = new T.CanvasTexture(c); t.needsUpdate = true; return t; }
function scanTex() { return canvasTex((g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = "rgba(0,0,0,0.9)"; for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1.3); }, 4, 512); }
function rimTex(r, gg, b) { return canvasTex((g, w, h) => { const grd = g.createRadialGradient(w / 2, h / 2, h * 0.30, w / 2, h / 2, h * 0.62);
  grd.addColorStop(0, "rgba(255,255,255,0)"); grd.addColorStop(0.80, `rgba(${r},${gg},${b},0.06)`); grd.addColorStop(1, `rgba(${r},${gg},${b},0.40)`); g.fillStyle = grd; g.fillRect(0, 0, w, h); }, 256, 256); }
const stdMat = (color, rough, metal) => new T.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
function curvedScreenGeo(sw, sh, bulge) {                      // subdivided plane bulged toward the viewer (CRT glass)
  const g = new T.PlaneGeometry(sw, sh, 40, 30), p = g.attributes.position, hw = sw / 2, hh = sh / 2;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i) / hw, y = p.getY(i) / hh; p.setZ(i, bulge * (1 - x * x * 0.6) * (1 - y * y * 0.6)); }
  g.computeVertexNormals(); return g;
}
function bezelFrame(sw, sh, bw, depth, mat) {                  // four bars forming a picture-frame bezel around the screen
  const g = new T.Group();
  const top = new T.Mesh(new T.BoxGeometry(sw + 2 * bw, bw, depth), mat); top.position.y = sh / 2 + bw / 2;
  const bot = top.clone(); bot.position.y = -(sh / 2 + bw / 2);
  const left = new T.Mesh(new T.BoxGeometry(bw, sh, depth), mat); left.position.x = -(sw / 2 + bw / 2);
  const right = left.clone(); right.position.x = sw / 2 + bw / 2;
  g.add(top, bot, left, right); return g;
}
function screenAssembly(art, sw, sh) {                         // curved live screen + scanline + glass-rim overlays
  const g = new T.Group();
  screenTex.minFilter = T.LinearFilter; screenTex.magFilter = T.LinearFilter; screenTex.generateMipmaps = false;
  const scrMat = new T.MeshBasicMaterial({ map: screenTex, toneMapped: false }); if (art.tint) scrMat.color = new T.Color(art.tint);
  const scr = new T.Mesh(curvedScreenGeo(sw, sh, art.curve), scrMat); scr.name = "screen"; g.add(scr);
  if (art.scan > 0) { const sg = curvedScreenGeo(sw, sh, art.curve + 0.02);
    g.add(new T.Mesh(sg, new T.MeshBasicMaterial({ map: scanTex(), transparent: true, opacity: art.scan, depthWrite: false, blending: T.NormalBlending, toneMapped: false }))); }
  const c = new T.Color(art.glow);
  g.add(new T.Mesh(curvedScreenGeo(sw, sh, art.curve + 0.03), new T.MeshBasicMaterial({ map: rimTex(c.r * 255 | 0, c.g * 255 | 0, c.b * 255 | 0), transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false })));
  return g;
}
function buildMachine(src, art) {
  const aspect = (src.width || 4) / (src.height || 3);
  const sw = art.screenW, sh = sw / aspect;
  screenTex = new T.CanvasTexture(src);
  const shell = stdMat(art.shell, 0.6, 0.08), trim = stdMat(art.trim, 0.82, 0.05);
  const g = new T.Group();
  const front = screenAssembly(art, sw, sh);
  if (art.kind === "crt") {
    const body = new T.Mesh(new T.BoxGeometry(sw * 1.06, sh * 1.06, 3.6), shell); body.position.z = -1.9; g.add(body);   // deep tube
    const back = new T.Mesh(new T.BoxGeometry(sw * 0.7, sh * 0.7, 0.9), trim); back.position.z = -3.8; g.add(back);
    g.add(bezelFrame(sw, sh, 0.55, 0.7, shell));
    front.position.z = 0.36; g.add(front);
    const neck = new T.Mesh(new T.CylinderGeometry(0.9, 1.1, 1.3, 24), trim); neck.position.y = -(sh / 2 + 1.3); g.add(neck);
    const base = new T.Mesh(new T.CylinderGeometry(2.0, 2.4, 0.4, 36), shell); base.position.y = -(sh / 2 + 2.1); g.add(base);
  } else if (art.kind === "allinone") {
    const body = new T.Mesh(new T.BoxGeometry(sw + 2.0, sh + 3.4, 2.6), shell); body.position.y = -0.7; body.position.z = -1.0; g.add(body);   // tall friendly body w/ chin
    g.add(bezelFrame(sw, sh, 0.45, 0.5, trim));
    front.position.z = 0.5; g.add(front);
    const slot = new T.Mesh(new T.BoxGeometry(sw * 0.7, 0.22, 0.3), new T.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.9 })); slot.position.set(0, -(sh / 2 + 1.6), 0.35); g.add(slot);
    const foot = new T.Mesh(new T.BoxGeometry(sw * 0.5, 0.5, 2.2), trim); foot.position.y = -(sh / 2 + 2.6); g.add(foot);
  } else { // amber terminal — boxy, vented, slight tilt
    const body = new T.Mesh(new T.BoxGeometry(sw + 1.6, sh + 1.8, 3.2), shell); body.position.z = -1.4; g.add(body);
    g.add(bezelFrame(sw, sh, 0.6, 0.6, shell));
    front.position.z = 0.42; g.add(front);
    for (let i = 0; i < 6; i++) { const v = new T.Mesh(new T.BoxGeometry(sw * 0.8, 0.08, 0.2), trim); v.position.set(0, sh * 0.34 - i * 0.34, -3.0); g.add(v); }   // vents on the back
    const base = new T.Mesh(new T.BoxGeometry(sw + 1.2, 0.6, 3.4), trim); base.position.y = -(sh / 2 + 1.2); g.add(base);
    g.rotation.x = -0.05;
  }
  // lighting rig (only present while a machine is shown)
  const lights = new T.Group();
  lights.add(new T.HemisphereLight(0x9fb0d0, 0x0a0c12, 0.5));
  const key = new T.DirectionalLight(0xffffff, 0.95); key.position.set(6, 10, 9); lights.add(key);
  const rim = new T.DirectionalLight(new T.Color(art.glow), 0.6); rim.position.set(-7, 2, -6); lights.add(rim);
  const spill = new T.PointLight(new T.Color(art.glow), 0.9, 26, 2); spill.position.set(0, 0, 2.2); lights.add(spill);   // screen light spilling onto the bezel
  lights.position.y = LIFT; scene.add(lights); monLights = lights;
  g.position.y = LIFT; scene.add(g); mon = g; screenSrc = src; monKind = art.kind;
  const span = Math.max(sw + 2.5, sh + 4);
  orbit.r = orbit.tr = span * 1.7; orbit.th = orbit.tth = 0; orbit.ph = orbit.tph = 1.46; entrance = 0;
}
function clearMonitor() {
  if (mon) scene.remove(mon); mon = null;
  if (monLights) scene.remove(monLights); monLights = null;
  if (screenTex) { screenTex.dispose(); screenTex = null; } screenSrc = null; monKind = null;
}
function odown(e) { orbit.drag = true; orbit.px = e.clientX; orbit.py = e.clientY; }
function oup() { orbit.drag = false; }
function omove(e) { if (!orbit.drag) return; const dx = e.clientX - orbit.px, dy = e.clientY - orbit.py; orbit.px = e.clientX; orbit.py = e.clientY;
  orbit.tth -= dx * 0.006; orbit.tph = Math.max(0.25, Math.min(Math.PI - 0.25, orbit.tph - dy * 0.006)); }
function owheel(e) { e.preventDefault(); orbit.tr = Math.max(6, Math.min(60, orbit.tr + Math.sign(e.deltaY) * 1.2)); }
function attachOrbit() { const c = renderer.domElement; c.addEventListener("pointerdown", odown); window.addEventListener("pointerup", oup); window.addEventListener("pointermove", omove); c.addEventListener("wheel", owheel, { passive: false }); }
function detachOrbit() { const c = renderer.domElement; c.removeEventListener("pointerdown", odown); window.removeEventListener("pointerup", oup); window.removeEventListener("pointermove", omove); c.removeEventListener("wheel", owheel); }
function updateObject(t) {
  if (screenTex && screenSrc && screenSrc.width > 1) screenTex.needsUpdate = true;   // live framebuffer → texture
  entrance += (1 - entrance) * 0.05;
  orbit.th += (orbit.tth - orbit.th) * 0.12; orbit.ph += (orbit.tph - orbit.ph) * 0.12; orbit.r += (orbit.tr - orbit.r) * 0.12;
  if (mon) { mon.position.y = LIFT + Math.sin(t * 0.7) * 0.18; mon.rotation.z = Math.sin(t * 0.5) * 0.006; const s = 0.9 + 0.1 * entrance; mon.scale.setScalar(s); }
  const rr = orbit.r * (1 + 0.55 * (1 - entrance));            // gentle fly-in on entrance
  camera.position.set(rr * Math.sin(orbit.ph) * Math.sin(orbit.th), LIFT + rr * Math.cos(orbit.ph), rr * Math.sin(orbit.ph) * Math.cos(orbit.th));
  camera.lookAt(0, LIFT, 0);
}
export function setObjectMode(on, src) {
  if (!T || !scene) return false;
  objMode = !!on;
  if (objMode) { clearMonitor(); buildMachine(src, MACHINE[curThemeName] || MACHINE.galactic); attachOrbit(); }
  else { clearMonitor(); detachOrbit(); }
  return true;
}
export function objectActive() { return objMode; }

// a persistent, very distant fine-star field shared by every theme → depth + parallax behind the action
let deep = null;
function deepField() {
  const g = new T.Group();
  g.add(starfield(2600, 760, 0.7, 0.55));                     // far, fine, faint
  const a = glowSprite(0.18, 0.26, 0.5, 520); a.position.set(-260, 120, -520); g.add(a);   // soft distant nebulae for tone
  const b = glowSprite(0.4, 0.28, 0.5, 460); b.position.set(300, -160, -560); g.add(b);
  return g;
}
function resize() { if (!renderer) return; const c = renderer.domElement;
  const w = c.clientWidth || innerWidth, h = c.clientHeight || innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix(); }
function onMove(e) { target.x = e.clientX / innerWidth - 0.5; target.y = e.clientY / innerHeight - 0.5; }
function loop() {
  if (!running) return;
  mouse.x += (target.x - mouse.x) * 0.06; mouse.y += (target.y - mouse.y) * 0.06;   // smoothed parallax
  const t = performance.now() / 1000;
  if (deep) deep.rotation.y = t * 0.004;                       // barely-perceptible deep parallax
  try { theme.update(t, mouse, camera); if (objMode && mon) updateObject(t); renderer.render(scene, camera); } catch (_) {}
  raf = requestAnimationFrame(loop);
}

export async function start(canvas, themeName) {
  T = await waitTHREE();
  renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  try { renderer.outputEncoding = T.sRGBEncoding; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12; } catch (_) {}
  scene = new T.Scene(); camera = new T.PerspectiveCamera(60, 1, 0.1, 3000);
  resize();
  deep = deepField(); scene.add(deep);
  setTheme(themeName || "galactic");
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", onMove);
  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : play()));
  play();                                            // start the render loop now that the renderer exists
}
export function setTheme(name) {
  if (!T) return; if (theme && theme.dispose) theme.dispose(scene);
  curThemeName = REG[name] ? name : "galactic";
  theme = REG[curThemeName]; theme.init(scene, camera, renderer);
  if (objMode && screenSrc) { const s = screenSrc; setObjectMode(false); setObjectMode(true, s); }   // rebuild machine to match the new theme
  try { localStorage.setItem("holo-v86-theme", name); } catch (_) {}
}
export function objectTheme() { return curThemeName; }
export function boost() { if (theme && theme.boost) theme.boost(); }
export function play() { if (!running && renderer) { running = true; resize(); loop(); } }
export function pause() { running = false; cancelAnimationFrame(raf); }
export function dispose() { pause(); if (theme && theme.dispose) theme.dispose(scene); window.removeEventListener("resize", resize); window.removeEventListener("pointermove", onMove); }
