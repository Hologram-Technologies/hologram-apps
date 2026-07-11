// sources.mjs — the BYTE SOURCE. A title is ONE content-addressed identity (its exact No-Intro name); its
// BYTES are resolved at Play-time host-side (no CORS, via holo://games/rom), then cached in OPFS. Everything
// comes from the Internet Archive (archive.org) — the one mirror that serves any client and is allow-listed in
// cef-host/src/kappa_scheme.cc `IsRomSourceUrl()` (tight SSRF allow-list, never a wildcard). Add a source = add
// an adapter here AND allow its exact host there.
//
// (The previous third-party mirror was removed 2026-06-28 — it shut down in early 2026 and its Cloudflare front
// served the host an HTML landing page instead of bytes. archive.org is the single source now. Successor mirrors
// can be added later as adapters IF they serve programmatic clients.)
//
// Personal-use stance unchanged: bytes come from a preservation archive, fetched host-side, unzipped + run +
// cached LOCALLY, never re-hosted. Tier-2 consumer sites (Vimm/Retrostic/Romspedia/Romspure/CDRomance) are NOT
// here — they are ad-gated/anti-bot and supported only via a user-provided URL, never scraped.

// ── ARCHIVE-SET source — for consoles with NO per-game archive.org item. archive.org's `no-intro-rom-sets-2025`
//    ships the COMPLETE No-Intro set as one set-zip per system; archive.org's view_archive.php extracts a SINGLE
//    inner per-game file on demand (the host allows ia*.archive.org via the .archive.org suffix). The inner
//    files are .7z (LZMA) — NOT browser-deflate-able — so consoles on this source MUST use the EJS engine raw
//    path (streamRawTitle): EmulatorJS extracts the .7z itself.
//    URL shape: archive.org/download/<item>/<setzip>.zip/<subdir>/<name>.7z  (each path segment encoded). ──
export const ARCHIVE_SET = {
  n64: {
    item: "no-intro-rom-sets-2025",
    setzip: "Nintendo - Nintendo 64 (BigEndian) (20251229-205458).zip",
    subdir: "Nintendo - Nintendo 64 (BigEndian)",
    ext: "7z",
  },
};
export function archiveSetUrl(code, name) {
  const c = ARCHIVE_SET[code];
  if (!c) return null;
  return "https://archive.org/download/" + encodeURIComponent(c.item) + "/" +
    encodeURIComponent(c.setzip) + "/" + encodeURIComponent(c.subdir) + "/" +
    encodeURIComponent(name + "." + c.ext);
}

// Per-game adapter: urlFor(name, sysCode, archiveItem) → a direct .zip byte URL (fetched host-side), or null if
// this source can't address the title. Used by the consoles that have a per-game-ZIP archive.org item.
export const SOURCES = [
  {
    id: "archive",
    urlFor: (name, code, item) =>
      item ? "https://archive.org/download/" + item + "/" + encodeURIComponent(name) + ".zip" : null,
  },
];
