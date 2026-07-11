// consoles.mjs — the per-console registry that makes Holo Games' ONE play surface play every system the
// engine has a core for. Each entry: which libretro core + ROM extension, the authentic body look, the face
// buttons (libretro JOYPAD bit + label + keyboard key + colour), and the r-roms (Internet Archive) source
// item. The play loop, projector, save-states, input feedback and stream pipeline are all console-agnostic;
// only this data changes per system. Add a console = add a row (+ copy its core into this dir).
//
// libretro JOYPAD bit ids (uniform across cores): B0 Y1 Select2 Start3 Up4 Down5 Left6 Right7 A8 X9 L10 R11.
// The D-pad (4-7), Start (Enter→3) and Select (R-Shift→2) are common to all; only face/shoulder buttons vary.
//
// `archive` is the Internet Archive per-game-ZIP item(s) the library streams from. It may be a single item
// (string) OR an ORDERED ARRAY of items — resolveTitle tries each in order and the first exact hit wins, so a
// console can union several sources to widen its playable set. Keep them per-game ZIP (browser-native deflate;
// never .7z). The shipped name shard play/index/<item>.json makes resolution 0-network.

const MAGENTA = "#9c2b5e", NES_RED = "#b32134", DARK = "#2c2c30";

export const CONSOLES = {
  gb: {
    label: "Game Boy", core: "./gambatte.mjs", ext: "gb", handheld: true,
    body: "#c6c7bc", accent: MAGENTA, sub: "DOT · MATRIX", archive: "theentiregameboycollection",
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: MAGENTA }, { bit: 8, l: "A", k: "KeyX", c: MAGENTA }],
  },
  gbc: {
    label: "Game Boy Color", core: "./gambatte.mjs", ext: "gbc", handheld: true,
    body: "#5a3fa0", accent: "#c0306a", sub: "COLOR", archive: "theentireGAMEBOYCOLORcollection",
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: "#c0306a" }, { bit: 8, l: "A", k: "KeyX", c: "#c0306a" }],
  },
  nes: {
    label: "Nintendo Entertainment System", core: "./quicknes.mjs", ext: "nes", handheld: false,
    body: "#bdbcb4", accent: NES_RED, sub: "", archive: "No-Intro_NES",
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: NES_RED }, { bit: 8, l: "A", k: "KeyX", c: NES_RED }],
  },
  snes: {
    label: "Super Nintendo", core: "./snes9x.mjs", ext: "sfc", handheld: false,
    body: "#cdc9c0", accent: "#6a5fae", sub: "", archive: "No-Intro_Super_Nintendo_SNES",   // per-game ZIPs (No-Intro names)
    buttons: [
      { bit: 1, l: "Y", k: "KeyA", c: "#2ca05a" }, { bit: 9, l: "X", k: "KeyS", c: "#2b5fa0" },
      { bit: 0, l: "B", k: "KeyZ", c: "#d2c12a" }, { bit: 8, l: "A", k: "KeyX", c: NES_RED },
    ],
    shoulders: [{ bit: 10, l: "L", k: "KeyQ" }, { bit: 11, l: "R", k: "KeyW" }],
  },
  gen: {
    label: "Mega Drive / Genesis", core: "./genesis.mjs", ext: "md", handheld: false,
    body: "#1b1b1d", accent: "#444", sub: "", archive: "ef_mega_genesis_no-intro_2024-04-21",   // per-game ZIPs (No-Intro names)
    buttons: [{ bit: 0, l: "A", k: "KeyZ", c: DARK }, { bit: 8, l: "B", k: "KeyX", c: DARK }, { bit: 9, l: "C", k: "KeyC", c: DARK }],
  },
  gba: {
    label: "Game Boy Advance", core: "./mgba.mjs", ext: "gba", handheld: true,
    body: "#4b3fb0", accent: "#3a3f8f", sub: "", archive: "ef_gba_no-intro_2024-02-21",   // per-game ZIPs (avoids the .7z-only No-Intro_GBA)
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: "#3a3f8f" }, { bit: 8, l: "A", k: "KeyX", c: "#3a3f8f" }],
    shoulders: [{ bit: 10, l: "L", k: "KeyA" }, { bit: 11, l: "R", k: "KeyS" }],
  },
  // Sega 8-bit — both run on the SAME genesis.mjs (Genesis Plus GX also emulates Master System / Game Gear /
  // SG-1000 by ROM extension), so no new core binary. 2-button pad; Start = Pause (Enter, COMMON_KEYS).
  sms: {
    label: "Master System", core: "./genesis.mjs", ext: "sms", handheld: false,
    body: "#17171a", accent: "#c1272d", sub: "",
    archive: ["master-system-no-intro-romset-2025-06-06", "ef_sms_No-Intro_2024-03-08"],   // per-game ZIPs (widest)
    buttons: [{ bit: 0, l: "1", k: "KeyZ", c: "#c1272d" }, { bit: 8, l: "2", k: "KeyX", c: "#c1272d" }],
  },
  gg: {
    label: "Game Gear", core: "./genesis.mjs", ext: "gg", handheld: true,
    body: "#26262b", accent: "#2f7be0", sub: "",
    archive: ["game-gear-no-intro-romset-2025-07-29", "ef_sega_game_gear_no-intro_2024-02-21"],   // per-game ZIPs (widest)
    buttons: [{ bit: 0, l: "1", k: "KeyZ", c: "#2f7be0" }, { bit: 8, l: "2", k: "KeyX", c: "#2f7be0" }],
  },
  // ── cartridge/handheld batch on cores built from libretro source (stella2014 / beetle_*). BIOS-free. ──
  a2600: {
    label: "Atari 2600", core: "./stella2014.mjs", ext: "a26", handheld: false,
    body: "#5a3a1e", accent: "#c0392b", sub: "",   // wood-grain console
    archive: ["atari-2600-no-intro-romset-2026-05-29"],   // per-game ZIPs (subdir-prefixed names; verified 2026-07-10)
    buttons: [{ bit: 0, l: "Fire", k: "KeyZ", c: "#c0392b" }],   // single-button joystick
  },
  ngpc: {
    label: "Neo Geo Pocket Color", core: "./beetle_ngp.mjs", ext: "ngp", handheld: true,
    body: "#1d3f8f", accent: "#e6b32e", sub: "",   // blue clamshell
    archive: ["ef_snk_neogeo_Pocket_neogeo_pocket_color_no-intro_2024"],   // per-game ZIPs (verified 2026-07-10)
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: "#e6b32e" }, { bit: 8, l: "A", k: "KeyX", c: "#e6b32e" }],
  },
  // ── advanced/3D tier: runs on the EmulatorJS GL engine (engine:"ejs" → play surface = ejs-play.html).
  //    ROM bytes stream from the archive.org complete No-Intro set (ARCHIVE_SET, per-game .7z extracted by the
  //    EJS engine). N64 = no BIOS, no disc, no threads. ──
  n64: {
    label: "Nintendo 64", core: "ejs", engine: "ejs", ejsCore: "n64", ext: "z64", handheld: false,
    body: "#20243f", accent: "#1f6feb", sub: "",
    archive: ["n64"], archiveSet: true,   // bytes from archive.org complete No-Intro set (BigEndian .7z, via ARCHIVE_SET)
    buttons: [{ bit: 8, l: "A", k: "KeyX", c: "#1f6feb" }, { bit: 0, l: "B", k: "KeyZ", c: "#2ca05a" }],
  },
  // SG-1000 also runs on genesis_plus_gx (genesis.mjs) — no new core. Atari 7800 on the built prosystem core.
  sg: {
    label: "SG-1000", core: "./genesis.mjs", ext: "sg", handheld: false,
    body: "#c9c5bb", accent: "#c1272d", sub: "",
    archive: ["ef_sg-1000_No-Intro"],   // per-game ZIPs (verified 2026-07-10; was .7z-set browse-only)
    buttons: [{ bit: 0, l: "1", k: "KeyZ", c: "#c1272d" }, { bit: 8, l: "2", k: "KeyX", c: "#c1272d" }],
  },
  a7800: {
    label: "Atari 7800", core: "./prosystem.mjs", ext: "a78", handheld: false,
    body: "#16161a", accent: "#cc2936", sub: "",
    archive: ["atari-7800-no-intro-romset-2025-06-25"],   // per-game ZIPs (subdir-prefixed names; verified 2026-07-10)
    buttons: [{ bit: 0, l: "L", k: "KeyZ", c: "#cc2936" }, { bit: 8, l: "R", k: "KeyX", c: "#cc2936" }],
  },
  min: {
    label: "Pokémon Mini", core: "./pokemini.mjs", ext: "min", handheld: true,
    body: "#7a2630", accent: "#f0c020", sub: "",   // tiny handheld
    archive: ["theentirepokemonminicollection"],   // per-game ZIPs (verified 2026-07-10; was .7z-set browse-only)
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: "#f0c020" }, { bit: 8, l: "A", k: "KeyX", c: "#f0c020" }, { bit: 1, l: "C", k: "KeyC", c: "#f0c020" }],
  },
  pce: {
    label: "PC Engine / TurboGrafx-16", core: "./beetle_pce.mjs", ext: "pce", handheld: false,
    body: "#e6e4dd", accent: "#d76a1c", sub: "",   // white HuCard console
    archive: "ef_pce_No-Intro_2024",
    buttons: [{ bit: 0, l: "II", k: "KeyZ", c: "#2b2b2b" }, { bit: 8, l: "I", k: "KeyX", c: "#2b2b2b" }],
  },
  wsc: {
    label: "WonderSwan Color", core: "./beetle_wswan.mjs", ext: "wsc", handheld: true,
    body: "#8d8f93", accent: "#1f8a70", sub: "",   // grey vertical handheld; core also runs mono WonderSwan
    archive: ["ef_bandai_wonderswan_color_no-intro_2024-04-08", "ef_bandai_wonderswan_no-intro_2024-04-08"],
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: "#3a3a3a" }, { bit: 8, l: "A", k: "KeyX", c: "#3a3a3a" }],
  },
  vb: {
    label: "Virtual Boy", core: "./beetle_vb.mjs", ext: "vb", handheld: false,
    body: "#1a1a1d", accent: "#b3000c", sub: "",   // red+black; screen renders RED monochrome
    archive: "NoIntroVirtualBoy",
    buttons: [{ bit: 0, l: "B", k: "KeyZ", c: "#b3000c" }, { bit: 8, l: "A", k: "KeyX", c: "#b3000c" }],
    shoulders: [{ bit: 10, l: "L", k: "KeyA" }, { bit: 11, l: "R", k: "KeyS" }],
  },
};

// the universal controls every console shares
export const COMMON_KEYS = { ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, Enter: 3, ShiftRight: 2 };

// map a catalog system label ("Nintendo - Game Boy", "Sega - Mega Drive - Genesis", …) → a console code.
export function codeForSys(sys) {
  const s = (sys || "").toLowerCase();
  if (/game boy advance|gba/.test(s)) return "gba";
  if (/game boy color|gbc/.test(s)) return "gbc";
  if (/game boy/.test(s)) return "gb";
  if (/super nintendo|snes|super famicom/.test(s)) return "snes";
  if (/nintendo 64|n64/.test(s)) return "n64";
  if (/pokemon mini|pok.mon mini/.test(s)) return "min";
  if (/game gear/.test(s)) return "gg";
  if (/sg-1000|sc-3000/.test(s)) return "sg";
  if (/master system|mark iii/.test(s)) return "sms";
  if (/mega drive|genesis|megadrive/.test(s)) return "gen";
  if (/neo.?geo pocket/.test(s)) return "ngpc";
  if (/virtual boy/.test(s)) return "vb";
  if (/wonderswan/.test(s)) return "wsc";
  if (/pc engine|turbografx|turbo grafx/.test(s)) return "pce";
  if (/atari.*7800|\b7800\b/.test(s)) return "a7800";
  if (/atari.*2600|\b2600\b/.test(s)) return "a2600";
  if (/nintendo entertainment system|nes|famicom/.test(s)) return "nes";
  return "gb";
}
