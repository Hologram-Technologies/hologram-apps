// holo-spaces.mjs — the net-new core of Holo Spaces: a SPACE is a content κ.
//
// The OS already renders "a room of live apps" (shell.html openHolospace mounts a
// holospace template's members concurrently, tiled via geomFor). What did NOT exist:
//   1. a composition with its OWN content identity (templates are did:holo:slug — a name);
//   2. nesting (a member that is itself a Space);
//   3. compose-on-the-fly + fork (templates were authored by a build tool).
// This module is the pure, isomorphic (browser + Node) core that supplies all three.
//
// Law L1 (identity is content): a Space's κ is sha256 over its CANONICAL identity tuple —
// the ordered member κs + layout + accent + mood + name. Re-derive the tuple, hash, compare:
// that is Law L5 on the COMPOSITION, not merely its parts. Tamper any member → the κ moves →
// verify refuses. Presentation/@context never enter the hash, so identity is stable across
// formatting. Pure and dependency-free: the witness runs the exact bytes the browser runs.

const PREFIX = "did:holo:sha256:";
const subtle = () => globalThis.crypto.subtle;          // WebCrypto: browser + Node ≥18 global

// The first six are the shell's in-room tiling vocabulary (geomFor / layoutStates). "honeycomb"
// is an APP-level layout: a Space-of-Spaces shown as a pannable hex wall (the lobby), rendered by
// Holo Spaces itself, never by the shell. It is identity-bearing like any other layout.
export const SHELL_LAYOUTS = ["split-h", "split-v", "primary-rail", "grid-2x2", "stack", "single"];
export const LAYOUTS = [...SHELL_LAYOUTS, "honeycomb"];
export const KINDS = ["app", "space"];                  // a member is a κ-addressed app OR a nested Space

// ── canonical identity ──────────────────────────────────────────────────────────────────
// A Space's identity is exactly this tuple. Anything else (title prose, icons, @context) is
// presentation and is deliberately excluded so two byte-different docs that mean the same
// arrangement share one κ. Members are ordered by position (stable sort), then frozen to
// {kind, root} — a member's identity is which thing it is and that it is an app vs a Space.
export function identity(space = {}) {
  const members = (space.members || [])
    .map((m, i) => ({ kind: KINDS.includes(m.kind) ? m.kind : "app", root: hexOf(m.root), pos: m.position == null ? i : m.position | 0 }))
    .filter((m) => m.root)                              // a member with no resolvable κ is not part of identity
    .sort((a, b) => a.pos - b.pos || a.root.localeCompare(b.root))
    .map((m) => ({ kind: m.kind, root: PREFIX + m.root }));
  return {
    v: 1,
    name: String(space.name || ""),
    layout: LAYOUTS.includes(space.layout) ? space.layout : "single",
    accent: /^#[0-9a-f]{3,8}$/i.test(space.accent || "") ? space.accent.toLowerCase() : "",
    mood: String(space.mood || ""),
    members,
  };
}

// hexOf(any-κ-form) → 64-hex | "" — accept did:holo:sha256:<hex> | holo://<hex> | bare hex.
export function hexOf(s) {
  const m = String(s || "").match(/[0-9a-f]{64}/i);
  return m ? m[0].toLowerCase() : "";
}

// stableStringify — deterministic JSON (object keys sorted recursively). The bytes we hash.
function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

// canonicalBytes(space) → Uint8Array — the exact bytes whose sha256 IS the Space's κ.
export function canonicalBytes(space) {
  return new TextEncoder().encode(stableStringify(identity(space)));
}

async function sha256hex(bytes) {
  const d = await subtle().digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// kappa(space) → "did:holo:sha256:<hex>" — the Space's single, shareable content identity (L1).
export async function kappa(space) {
  return PREFIX + (await sha256hex(canonicalBytes(space)));
}

// verify(space, expectedKappa) → boolean — Law L5 on the composition: re-derive, compare.
// Fail-closed by construction: a mismatch (a tampered member, a reordered tuple) returns false,
// and the surface renders an honest empty slot rather than a wrong arrangement.
export async function verify(space, expectedKappa) {
  return (await kappa(space)) === PREFIX + hexOf(expectedKappa);
}

// ── poster (the honeycomb preview) — content-derived, re-derived before display ───────────
// A hex shows a POSTER, never a live iframe (a 40-hex wall of iframes would melt). The poster is
// a pure function of the Space's identity, so it is itself content-addressed: re-derive the Space
// and compare to the κ it is filed under (Law L5). On a match → a themed poster descriptor; on a
// mismatch (drift / a tampered record) → an identicon descriptor derived from the κ alone. The
// browser turns the descriptor into an SVG; this stays pure so the witness can prove the fallback.
export async function poster(space, expectedKappa) {
  const hex = hexOf(expectedKappa);
  if (space && (await verify(space, expectedKappa))) {
    const id = identity(space);
    return { kind: "poster", kappa: "did:holo:sha256:" + hex, accent: id.accent || "#2dd4bf", name: id.name || "", mood: id.mood || "", count: id.members.length };
  }
  return { kind: "identicon", kappa: "did:holo:sha256:" + hex };   // fail-closed: no trusted poster
}

// ── the ONE hex packer (the fractal honeycomb) ────────────────────────────────────────────
// A honeycomb is the same shape at every scale: the lobby wall, an in-hex preview, and a preview
// inside a preview all pack their children with THIS function. Self-similar by construction.

// hexSpiral(n) → n axial {q,r} cells in a centre-out spiral (centre, then ring of 6, then 12 …).
export function hexSpiral(n) {
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];   // the 6 axial neighbours
  const res = [{ q: 0, r: 0 }];
  for (let k = 1; res.length < n; k++) {
    let q = DIRS[4][0] * k, r = DIRS[4][1] * k;                        // step out to the ring's start
    for (let s = 0; s < 6 && res.length < n; s++)
      for (let i = 0; i < k && res.length < n; i++) { res.push({ q, r }); q += DIRS[s][0]; r += DIRS[s][1]; }
  }
  return res.slice(0, n);
}

// hexLayout(n, size) → n flat-top hex centres {q,r,x,y}, centred on the origin (cell 0 is (0,0)).
// `size` is the hex radius (centre→corner): width = 2·size, height = √3·size, column pitch = 1.5·size.
export function hexLayout(n, size) {
  return hexSpiral(n).map(({ q, r }) => ({ q, r, x: size * 1.5 * q, y: size * Math.sqrt(3) * (r + q / 2) }));
}

// the single flat-top hexagon clip — used by every hex at every scale.
export const HEX_CLIP = "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)";

// ── compose & fork (immutability) ───────────────────────────────────────────────────────
// Every edit returns a NEW Space (new κ); the original bytes are never mutated. Forking is
// the one creative gesture: drag a κ in → a new immutable Space you can share.
function clone(space) { return JSON.parse(JSON.stringify(space || {})); }

// addMember(space, member) → new Space with the member appended at the next free position.
// member: { kind?: "app"|"space", root: <any κ form> } — kind defaults to "app".
export function addMember(space, member) {
  const next = clone(space);
  next.members = next.members || [];
  const pos = next.members.reduce((mx, m) => Math.max(mx, (m.position | 0)), -1) + 1;
  next.members.push({ kind: KINDS.includes(member.kind) ? member.kind : "app", root: PREFIX + hexOf(member.root), position: pos });
  return next;
}

// removeMember(space, index) → new Space without that member (positions left as-is; identity
// re-sorts by position then κ, so gaps never change the arrangement's meaning).
export function removeMember(space, index) {
  const next = clone(space);
  (next.members || []).splice(index, 1);
  return next;
}

// nest(parent, childKappa) → new Space with the child Space added AS a member (kind "space").
// This is the whole "infinite" claim in one line: a Space is just another κ thing.
export function nest(parent, childKappa) {
  return addMember(parent, { kind: "space", root: childKappa });
}

// ── share (serverless, by κ) ──────────────────────────────────────────────────────────────
// A Space travels two ways, both κ-true: (a) by its κ alone, when both peers can resolve the
// composition object from a store/peer/gateway; (b) self-contained, the canonical bytes packed
// into the link fragment so a cold peer reconstructs it with NO server — and the κ still
// re-derives from the decoded bytes (L5), so a corrupted link is refused, not silently shown.
const b64urlEnc = (bytes) => btoaU(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDec = (s) => Uint8Array.from(atobU(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const btoaU = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64"));
const atobU = (s) => (typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary"));

// encode(space) → a compact self-contained payload string (the canonical identity, base64url).
export function encode(space) { return b64urlEnc(canonicalBytes(space)); }

// decode(payload) → the identity Space reconstructed from a self-contained link. The caller
// re-derives its κ and compares to the κ in the link before trusting it.
export function decode(payload) { return JSON.parse(new TextDecoder().decode(b64urlDec(payload))); }

// ── content store (κ → composition), L5 on read ──────────────────────────────────────────
// Resolve a Space by its κ. In the browser this is OPFS (the app's own κ-store namespace);
// in Node (the witness) it's an injected Map. Either way: re-derive on read, refuse a mismatch.
// This is what makes "tap a κ → the exact arrangement" honest rather than hopeful.
export function makeStore(backend) {
  // backend: { get(hex)->bytes|null, put(hex,bytes)->void }. Defaults to OPFS in the browser.
  const be = backend || opfsBackend();
  return {
    async put(space) {
      const bytes = canonicalBytes(space);
      const hex = await sha256hex(bytes);
      await be.put(hex, bytes);
      return PREFIX + hex;
    },
    async get(kappaIn) {
      const hex = hexOf(kappaIn);
      if (!hex) return null;
      const bytes = await be.get(hex);
      if (!bytes) return null;
      if ((await sha256hex(bytes)) !== hex) return null;     // Law L5: drifted bytes are not this Space
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  };
}

// opfsBackend — the browser default: Origin-Private File System, one flat dir of κ-named blobs.
function opfsBackend() {
  let dirP = null;
  const dir = async () => (dirP ||= navigator.storage.getDirectory().then((root) => root.getDirectoryHandle("holo-spaces", { create: true })));
  return {
    async get(hex) {
      try { const fh = await (await dir()).getFileHandle(hex); return new Uint8Array(await (await fh.getFile()).arrayBuffer()); }
      catch { return null; }
    },
    async put(hex, bytes) {
      const fh = await (await dir()).getFileHandle(hex, { create: true });
      const w = await fh.createWritable(); await w.write(bytes); await w.close();
    },
  };
}
