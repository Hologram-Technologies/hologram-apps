// q-summon.mjs — tap the Q orb and the home BECOMES Q. Four welds, all additive, all fail-soft:
//
//   1. THE MORPH — the bundle already names the home orb `view-transition-name:holo-q-orb` and ships tuned
//      ::view-transition groups, but never paired it. We give the hero's orb the matching name for the summon
//      and wrap the open in document.startViewTransition, so the BROWSER itself flies the orb from the corner
//      into Q's face while the home canvas (greeting, day-ring, quote) crossfades into the starfield. Dismiss
//      reverses the same motion. Compositor-only; no View Transitions → a graceful widget-exhale fallback.
//   2. THE VOICE AT t=0 — the tap IS the browser's autoplay gesture, so Q may speak the instant you summon it.
//      We greet out loud immediately (on-device Kokoro if warm, OS voice floor otherwise — never mute) and
//      pre-warm the HD voice while home idles, so Q's beautiful voice is ready before you ever tap.
//   3. THE WARM BRAIN — the hero's own BitNet engine (window.HoloQ.warm(), the ~70 tok/s warm-KV path that
//      matches the standalone Q) starts loading while home idles, so the FIRST message prefills instead of
//      cold-loading. The messenger's ONNX seed first-responder covers the gap — Q is never speechless.
//   4. THE κ-THREAD — every message that paints in the Q thread is sealed to a BLAKE3 κ
//      (did:holo:blake3:<hex>, Law L1) hash-linked to the previous message's κ, persisted, and the whole
//      chain is re-derived and VERIFIED on every load (Law L5). A flipped byte in storage is named, live.
//      window.QSummon.{thread,verify,kappaOf} exposes the ledger.
//
// 100% serverless: View Transitions + Web Audio + vendored Kokoro + WebGPU BitNet + pure-JS BLAKE3 —
// nothing leaves the device. Self-contained on purpose: imports only CANONICAL modules (core voice, κ seam).
import { createVoice } from "../q/core/voice-out.js";
import { kappo, kappoVerify } from "../../_shared/holo-kappa.mjs";

const DOC = document, HTML = DOC.documentElement;
const $ = (s, r) => (r || DOC).querySelector(s);
const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const hasVT = () => typeof DOC.startViewTransition === "function" && !reduced();

// ── choreography CSS (transform/opacity only — compositor-clean) ──────────────────────────────────────────
const css = DOC.createElement("style");
css.id = "q-summon-css";
css.textContent = `
/* pre-flight anticipation: the orb leans into your tap */
html.q-anticipate .holo-home-orb{transform:scale(1.07)}
/* while summoned, exactly ONE element carries the shared morph name in each snapshot */
html.q-summoning .holo-home-orb,html.q-summoning .holo-global-orb{view-transition-name:none!important}
html.q-summoning .holo-hero-orb{view-transition-name:holo-q-orb}
/* summon/dismiss pacing (scoped so every other view switch keeps the app's quick default) */
@media (prefers-reduced-motion: no-preference){
  html.q-vt::view-transition-old(root){animation-duration:.52s;animation-timing-function:cubic-bezier(.4,0,.2,1)}
  html.q-vt::view-transition-new(root){animation-duration:.52s;animation-timing-function:cubic-bezier(.4,0,.2,1)}
  html.q-vt::view-transition-group(holo-q-orb){animation-duration:.62s;animation-timing-function:cubic-bezier(.34,.75,.15,1)}
}
/* no-View-Transitions fallback: the home exhales (widgets fade+settle) while the hero fades in above */
html.q-summon-manual .holo-home-layer [class*="holo-home-"]:not(.holo-home-orb),
html.q-summon-manual .holo-home-quote,html.q-summon-manual .holo-home-menu-fab{opacity:0!important;transition:opacity .38s ease!important}
html.q-summon-manual .holo-home-orb{opacity:0;transform:scale(1.14);transition:transform .55s cubic-bezier(.4,0,.2,1),opacity .5s ease .1s}
/* κ-chain chip — quiet proof, bottom-left of the hero */
#q-kappa-chip{position:fixed;left:14px;bottom:14px;z-index:340;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;
  color:#9fd3ff;background:rgba(10,14,20,.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:5px 10px;pointer-events:none;opacity:0;transition:opacity .5s ease .25s}
#q-kappa-chip.on{opacity:.85}
#q-kappa-chip.bad{color:#ffb3c0;border-color:rgba(255,120,140,.4)}
/* SUGGESTION CHIPS — the standalone's discoverability row, folded into the hero (which shipped without them).
   Fixed above the composer (React-reconciliation-proof), horizontally scrollable, brand glass; fade on first send. */
#q-hero-chips{position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom) + 78px);z-index:305;
  display:flex;gap:9px;justify-content:center;flex-wrap:wrap;padding:0 16px;pointer-events:none;
  opacity:0;transform:translateY(6px);transition:opacity .45s ease,transform .45s cubic-bezier(.4,0,.2,1)}
#q-hero-chips.on{opacity:1;transform:none}
#q-hero-chips button{pointer-events:auto;white-space:nowrap;color:#eef3fb;border-radius:20px;padding:8px 15px;font-size:13.5px;
  cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(20,26,36,.62);
  backdrop-filter:blur(20px) saturate(150%);-webkit-backdrop-filter:blur(20px) saturate(150%);
  box-shadow:0 3px 16px rgba(0,0,0,.28);transition:transform .14s ease,border-color .16s ease,background .16s ease}
#q-hero-chips button:hover{border-color:rgba(139,123,255,.55);transform:translateY(-1px);background:rgba(28,36,50,.72)}
#q-hero-chips button:active{transform:scale(.96)}
@media (prefers-reduced-motion:reduce){#q-hero-chips{transition:opacity .2s ease}}
`;
DOC.head.appendChild(css);

// ── Q's summon voice (canonical core voice; HD warms once, floor voice means never mute) ──────────────────
const voice = createVoice({ onLevel: (level) => { try { window.dispatchEvent(new CustomEvent("holo-q-state", { detail: { mode: "speaking", level } })); } catch {} } });
const TTS_URL = new URL("../../usr/lib/holo/voice/holo-voice-tts.mjs", import.meta.url).href;   // mount-safe (works under /Q/)
const GREET_FIRST = "Hey, I'm Q. I live right here on your device, so whatever you tell me stays with you, always. What's on your mind?";
const GREET_BACK = "Welcome back. I'm right here — what's on your mind?";
const GKEY = "holo.q.summon.greeted";

// warm while home idles, in value order: ① OS voices (ms) ② HD voice (~MBs — the greeting upgrade)
// ③ Q's real brain via the app's own hook (window.HoloQ.warm() — the hero's BitNet, so the FIRST message
// prefills instead of cold-loading). Visible tabs only; every stage fail-soft.
function warm() {
  try { window.speechSynthesis && speechSynthesis.getVoices(); } catch {}
  try { voice.warmHD({ ttsUrl: TTS_URL }).catch(() => {}); } catch {}
  let tries = 0;
  (function brain() {
    try { if (window.HoloQ && window.HoloQ.warm) { window.HoloQ.warm(); return; } } catch {}
    if (++tries < 40) setTimeout(brain, 700);   // HoloQ appears after boot; give it ~28s then let first-use load it
  })();
}
function warmWhenIdle() {
  if (DOC.visibilityState !== "visible") { DOC.addEventListener("visibilitychange", warmWhenIdle, { once: true }); return; }
  if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4500 }); else setTimeout(warm, 2500);
}
warmWhenIdle();

let greeting = false;
function speakGreeting() {
  let first = true; try { first = !localStorage.getItem(GKEY); localStorage.setItem(GKEY, String(Date.now())); } catch {}
  greeting = true;
  Promise.resolve(voice.speak(first ? GREET_FIRST : GREET_BACK)).catch(() => {}).then(() => { greeting = false; });
}
function bargeIn() { if (greeting) { greeting = false; try { voice.stop(); } catch {} } }
// your typing (or the hero's own reply arriving — see the ledger observer) takes the floor from the greeting
window.addEventListener("keydown", bargeIn, { capture: true, passive: true });

// ── the summon + dismiss choreography ─────────────────────────────────────────────────────────────────────
let passthrough = false;   // true while we re-dispatch a swallowed activation inside a view transition
const heroOpen = () => !!$(".holo-hero");

// wait (bounded) for the hero to mount/unmount inside the transition callback, so the "new" snapshot is real
function settle(pred, capMs) {
  return new Promise((res) => { const t0 = performance.now(); (function tick() { if (pred() || performance.now() - t0 > (capMs || 260)) res(); else setTimeout(tick, 16); })(); });
}
async function morph(mutate, settled) {
  HTML.classList.add("q-vt");
  try {
    const vt = DOC.startViewTransition(async () => { mutate(); await settle(settled); });
    await vt.finished.catch(() => {});
  } finally { HTML.classList.remove("q-vt"); }
}

function onOrbDown(e) {
  if (passthrough || heroOpen()) return;
  const orb = e.target && e.target.closest && e.target.closest(".holo-home-orb");
  if (!orb) return;
  if (!reduced()) HTML.classList.add("q-anticipate");
  speakGreeting();   // ← the tap IS the gesture: Q speaks at t=0 (HD if warm, floor voice otherwise)
}
function onOrbClick(e) {
  if (passthrough || heroOpen()) return;
  const orb = e.target && e.target.closest && e.target.closest(".holo-home-orb");
  if (!orb) return;
  if (hasVT()) {
    e.stopPropagation(); e.preventDefault();
    morph(() => {
      HTML.classList.add("q-summoning");           // new snapshot: hero orb carries the name, home orb yields it
      passthrough = true; try { orb.click(); } finally { passthrough = false; }
    }, heroOpen).finally(() => { HTML.classList.remove("q-anticipate"); if (!heroOpen()) HTML.classList.remove("q-summoning"); });
  } else {
    if (!reduced()) HTML.classList.add("q-summon-manual");   // widgets exhale under the hero's own fade
    HTML.classList.remove("q-anticipate");
  }
}
function onCloseClick(e) {
  if (passthrough) return;
  const x = e.target && e.target.closest && e.target.closest(".holo-hero-x");
  if (!x || !HTML.classList.contains("q-summoning") || !hasVT()) return;
  e.stopPropagation(); e.preventDefault();
  bargeIn();
  morph(() => {
    HTML.classList.remove("q-summoning");          // new snapshot: home orb takes the name back
    passthrough = true; try { x.click(); } finally { passthrough = false; }
  }, () => !heroOpen());
}
function onEsc(e) {
  if (passthrough || e.key !== "Escape" || !heroOpen() || !HTML.classList.contains("q-summoning") || !hasVT()) return;
  const x = $(".holo-hero-x"); if (!x) return;
  e.stopPropagation(); e.preventDefault();
  bargeIn();
  morph(() => { HTML.classList.remove("q-summoning"); passthrough = true; try { x.click(); } finally { passthrough = false; } }, () => !heroOpen());
}
DOC.addEventListener("pointerdown", onOrbDown, { capture: true, passive: true });
DOC.addEventListener("click", onOrbClick, { capture: true });
DOC.addEventListener("click", onCloseClick, { capture: true });
window.addEventListener("keydown", onEsc, { capture: true });

// ── the κ-thread: every painted message → did:holo:blake3, hash-linked, verified on every load ────────────
const LKEY = "holo.q.kappa-thread.v1";
const enc = new TextEncoder();
const sealBytes = (m) => enc.encode(JSON.stringify({ v: 1, role: m.role, text: m.text, ts: m.ts, prev: m.prev }));
let ledger = []; try { ledger = JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch {}
const seen = new Set(ledger.map((m) => m.role + " " + m.text));
let chainOk = true, brokenAt = -1;
function verifyChain() {
  let prev = null;
  for (let i = 0; i < ledger.length; i++) {
    const m = ledger[i];
    if (m.prev !== prev || !kappoVerify(sealBytes(m), m.k)) { chainOk = false; brokenAt = i; return false; }
    prev = m.k;
  }
  chainOk = true; brokenAt = -1; return true;
}
verifyChain();
function persist() { try { localStorage.setItem(LKEY, JSON.stringify(ledger.slice(-240))); } catch {} }
function seal(role, text) {
  const key = role + " " + text;
  if (!text || seen.has(key)) return null;
  const m = { v: 1, role, text, ts: Date.now(), prev: ledger.length ? ledger[ledger.length - 1].k : null };
  m.k = kappo(sealBytes(m));
  ledger.push(m); seen.add(key); persist(); chip();
  return m.k;
}

// quiet proof chip, shown while the hero is open
let chipEl = null;
function chip() {
  if (!heroOpen()) { if (chipEl) chipEl.classList.remove("on"); return; }
  if (!chipEl) { chipEl = DOC.createElement("div"); chipEl.id = "q-kappa-chip"; DOC.body.appendChild(chipEl); }
  const last = ledger[ledger.length - 1];
  chipEl.textContent = chainOk
    ? `⛓ ${ledger.length} sealed · verified` + (last ? ` · κ…${last.k.slice(-8)}` : "")
    : `⛓ chain broken at #${brokenAt} — history was altered`;
  chipEl.classList.toggle("bad", !chainOk);
  chipEl.classList.add("on");
}

// ── suggestion chips (the standalone's discoverability row; the hero shipped without them) ────────────────
// Drive the hero's React-controlled input the reconciliation-safe way: native value setter → input event →
// click send. Chips are a fixed sibling of the hero (not inside React's tree), so React never reconciles them.
const CHIPS = ["Tell me something amazing", "Write me something beautiful", "Help me think through something", "Tell me a joke"];
let chipsEl = null;
function heroHasUserMsg() { try { return !!DOC.querySelector(".holo-hero-bubble.me"); } catch { return false; } }
function driveSend(text) {
  const inp = DOC.querySelector("#holo-hero-input"); if (!inp) return;
  try {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, text); inp.dispatchEvent(new Event("input", { bubbles: true }));
    const send = DOC.querySelector(".holo-hero-send");
    if (send && !send.disabled) send.click();
    else { inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
  } catch {}
}
function showChips() {
  if (!heroOpen() || heroHasUserMsg()) return;
  if (!chipsEl) {
    chipsEl = DOC.createElement("div"); chipsEl.id = "q-hero-chips";
    for (const c of CHIPS) { const b = DOC.createElement("button"); b.textContent = c; b.onclick = () => { hideChips(); bargeIn(); driveSend(c); }; chipsEl.appendChild(b); }
    DOC.body.appendChild(chipsEl);
  }
  requestAnimationFrame(() => chipsEl && chipsEl.classList.add("on"));
}
function hideChips() { if (chipsEl) { chipsEl.classList.remove("on"); } }

// observe the hero: seal each bubble as it paints; a NEW Q reply takes the voice floor from the greeting
const mo = new MutationObserver((muts) => {
  for (const mut of muts) {
    for (const n of mut.addedNodes) {
      if (!(n instanceof Element)) continue;
      if (n.classList && n.classList.contains("holo-hero")) { verifyChain(); chip(); setTimeout(showChips, 260); }
      const bubbles = n.classList && n.classList.contains("holo-hero-bubble") ? [n] : (n.querySelectorAll ? n.querySelectorAll(".holo-hero-bubble") : []);
      for (const b of bubbles) {
        if (b.classList.contains("typing")) continue;
        const role = b.classList.contains("me") ? "me" : "q";
        const text = (b.textContent || "").trim();
        const k = seal(role, text);
        if (role === "me") hideChips();     // you engaged → the chips step aside
        if (k && role === "q") bargeIn();   // the hero speaks its own replies — the greeting yields instantly
      }
    }
    for (const n of mut.removedNodes) {
      if (n instanceof Element && n.classList && n.classList.contains("holo-hero")) {
        // closed by ANY path: never leave the morph classes dangling, hush the chip + chips, release the greeting
        HTML.classList.remove("q-summoning", "q-summon-manual", "q-anticipate");
        if (chipEl) chipEl.classList.remove("on");
        hideChips();
        bargeIn();
      }
    }
  }
});
mo.observe(DOC.body, { childList: true, subtree: true });

// ── debug/verification surface ────────────────────────────────────────────────────────────────────────────
window.QSummon = {
  thread: () => ledger.slice(),
  verify: () => ({ ok: verifyChain(), brokenAt, sealed: ledger.length }),
  kappaOf: (i) => (ledger[i] || {}).k || null,
  speak: (t) => voice.speak(t),
  version: 2,
};
try { console.info("[q-summon] live — morph:", hasVT() ? "view-transitions" : "fallback", "· sealed:", ledger.length, "· chain:", chainOk ? "verified" : "BROKEN@" + brokenAt); } catch {}
