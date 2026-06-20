// covers.mjs — original, sharp cover art for every Holo v86 machine tile.
//
// One deterministic emblem per OS (seeded from its id): a per-machine accent palette, an original
// geometric badge motif, a crisp monogram, and the OS name as a vector wordmark. Pure inline SVG →
// resolution-independent, razor sharp at any DPI. ORIGINAL marks that evoke each system — never the
// real trademarked logos. No assets, no network: the cover is a string the gallery drops into the tile.
//
//   import { coverSVG } from "./covers.mjs"
//   tile.querySelector(".scr").insertAdjacentHTML("afterbegin", coverSVG(os));

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// a short, legible monogram derived from the name (number-first, else initials, else letters)
function monogram(name) {
  const n = String(name).trim();
  const num = n.match(/\b(\d{1,4}(?:\.\d)?)\b/);                 // "Windows 98" → 98, "DOS 3.1" → 3.1
  if (num && num[1].length <= 4) return num[1];
  const words = n.replace(/([a-z0-9])([A-Z])/g, "$1 $2")        // split camelCase: "bootRogue" → "boot Rogue"
    .replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] || n;
  return w.slice(0, w.length <= 4 ? w.length : 3).toUpperCase();
}

// Real, free-licensed marks (font-logos, OFL/public-domain) for the OSes that actually have one —
// the glyph renders in the font; everything else keeps its original generated badge. Tux stands in
// for the generic Linux distros. PUA codepoints from font-logos 1.2.0.
const ARCH = "", FREEBSD = "", OPENBSD = "", TUX = "";
const LOGO = {
  "archlinux-boot": ARCH, "freebsd-boot": FREEBSD, "openbsd-boot": OPENBSD,
  basiclinux: TUX, buildroot: TUX, buildroot6: TUX, dsl: TUX, linux26: TUX,
  slitaz: TUX, tinycore: TUX, xpud: TUX, openwrt: TUX,
};

// original badge frame paths (centred on 0,0 in a ~96 unit box)
function frame(kind, R) {
  const r = R;
  if (kind === 0) return `<rect x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" rx="${r * 0.28}"/>`;        // rounded square
  if (kind === 1) { const p = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; p.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`); } return `<polygon points="${p.join(" ")}"/>`; } // hexagon
  if (kind === 2) return `<path d="M0 ${-r} L${r * 0.92} ${-r * 0.5} L${r * 0.92} ${r * 0.34} Q${r * 0.92} ${r * 0.9} 0 ${r * 1.04} Q${-r * 0.92} ${r * 0.9} ${-r * 0.92} ${r * 0.34} L${-r * 0.92} ${-r * 0.5} Z"/>`; // shield
  if (kind === 3) return `<circle cx="0" cy="0" r="${r}"/>`;                                                          // disc
  const d = r * 1.18; return `<polygon points="0,${-d} ${d},0 0,${d} ${-d},0"/>`;                                     // diamond
}

export function coverSVG(o) {
  const h = hash(o.id || o.name || "x"), uid = "c" + h.toString(36);
  const hue = h % 360, hue2 = (hue + 30 + (h >> 9) % 40) % 360;
  const a1 = `hsl(${hue},78%,64%)`, a2 = `hsl(${hue2},82%,54%)`, deep = `hsl(${hue},60%,9%)`;
  const logo = LOGO[o.id];                                                        // a real, free-licensed mark, or undefined
  const mono = esc(monogram(o.name));
  const fk = h % 5, R = 40;
  const ms = mono.length <= 2 ? 38 : mono.length === 3 ? 28 : 21;                 // monogram font size by length
  const emblem = logo
    ? `<text x="0" y="0" dy="0.34em" text-anchor="middle" font-family="font-logos" font-size="48" fill="#f5f9ff">${logo}</text>`
    : `<text x="0" y="0" dy="0.35em" text-anchor="middle" font-family="'Segoe UI',system-ui,'Helvetica Neue',Arial,sans-serif" font-weight="800" font-size="${ms}" fill="#f3f8ff" letter-spacing="0.5">${mono}</text>`;
  const nm = esc(o.name);
  const ns = nm.length <= 10 ? 18 : nm.length <= 16 ? 14.5 : nm.length <= 22 ? 12 : 10.5;  // wordmark size by length
  const ring = (h >> 3) % 2 === 0;
  // a faint decorative orbit + corner ticks for the "substrate" feel
  const ticks = [[18, 18], [302, 18], [18, 222], [302, 222]].map(([x, y]) =>
    `<path d="M${x - 7} ${y} h14 M${x} ${y - 7} v14" stroke="${a1}" stroke-opacity="0.5" stroke-width="1.4"/>`).join("");
  return `<svg class="cover" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <defs>
    <radialGradient id="${uid}bg" cx="50%" cy="38%" r="78%">
      <stop offset="0%" stop-color="hsl(${hue},55%,16%)"/><stop offset="58%" stop-color="${deep}"/><stop offset="100%" stop-color="#05070b"/>
    </radialGradient>
    <linearGradient id="${uid}em" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${a1}"/><stop offset="100%" stop-color="${a2}"/></linearGradient>
    <filter id="${uid}gl" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.2"/></filter>
  </defs>
  <rect width="320" height="240" fill="url(#${uid}bg)"/>
  <g opacity="0.10" stroke="${a1}" fill="none" stroke-width="1">${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${20 + i * 34}" x2="320" y2="${20 + i * 34}"/>`).join("")}</g>
  ${ring ? `<circle cx="160" cy="104" r="70" fill="none" stroke="${a1}" stroke-opacity="0.28" stroke-width="1.5" stroke-dasharray="3 7"/>` : ""}
  ${ticks}
  <g transform="translate(160,104)">
    <g filter="url(#${uid}gl)" opacity="0.55" fill="url(#${uid}em)">${frame(fk, R)}</g>
    <g fill="none" stroke="url(#${uid}em)" stroke-width="3.4" stroke-linejoin="round">${frame(fk, R)}</g>
    ${emblem}
  </g>
  <text x="160" y="206" text-anchor="middle" font-family="'Segoe UI',system-ui,'Helvetica Neue',Arial,sans-serif" font-weight="700" font-size="${ns}" fill="#e8f0fb" letter-spacing="0.4">${nm}</text>
</svg>`;
}

export default { coverSVG };
