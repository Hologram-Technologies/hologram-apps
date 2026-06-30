// holo-chaptermap.mjs — pair LibriVox audio SECTIONS with holo-text CHAPTERS. They rarely line up 1:1 (a
// LibriVox section may combine letters, or add a preface/credits), so forcing index alignment would put the
// wrong audio under the wrong text — a confidently-wrong read-along. Instead: parse each heading into a
// (type, number) key ("Letter 1" / "Letter I" / "Chapter 01" all normalize), match on that first, fall back to
// order ONLY when counts agree, and leave the rest UNMATCHED (logged) so alignment never runs on a bad pair.
// Pure ESM → Node witnesses it.
//
//   mapSections(sections, chapters) → { pairs:[{ sectionIndex, chapterId, how, conf }], unmatched:[…], log:[…] }
//     sections = [{ title, sec? }]   (LibriVox)     chapters = [{ id, title }]   (holo-text DAG)

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function roman2int(s) {
  s = s.toLowerCase(); if (!/^[ivxlcdm]+$/.test(s)) return null;
  let n = 0; for (let i = 0; i < s.length; i++) { const v = ROMAN[s[i]], nx = ROMAN[s[i + 1]]; n += nx && nx > v ? -v : v; }
  return n || null;
}
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const TYPES = /(letter|chapter|chap|part|book|volume|canto|act|scene)/;
const FRONT = /(preface|introduction|prologue|foreword|dedication|contents|epilogue|afterword|appendix)/;

// parse a heading → { type, num } | { type:"front", key } | null
export function parseHeading(title) {
  const t = String(title || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const f = t.match(FRONT); if (f) return { type: "front", key: f[1], num: null };
  const m = t.match(new RegExp(`\\b${TYPES.source}\\b\\s+([ivxlcdm]+|\\d+|${Object.keys(WORD_NUM).join("|")})\\b`));
  if (m) {
    const type = m[1] === "chap" ? "chapter" : m[1];
    const raw = m[2];
    const num = /^\d+$/.test(raw) ? +raw : WORD_NUM[raw] != null ? WORD_NUM[raw] : roman2int(raw);
    if (num != null) return { type, num };
  }
  return null;
}
const keyOf = (h) => (h ? (h.type === "front" ? `front:${h.key}` : `${h.type}:${h.num}`) : null);

export function mapSections(sections = [], chapters = []) {
  const log = [];
  const chKey = chapters.map((c) => keyOf(parseHeading(c.title)));
  const used = new Set();
  const pairs = [];
  // 1) match on parsed (type, number) — robust to "Letter 1" vs "Letter I" vs "Chapter 01"
  sections.forEach((s, si) => {
    const k = keyOf(parseHeading(s.title));
    if (!k) return;
    const ci = chKey.findIndex((ck, i) => ck === k && !used.has(i));
    if (ci >= 0) { used.add(ci); pairs.push({ sectionIndex: si, chapterId: chapters[ci].id, how: "title", conf: 1 }); }
  });
  // 2) order fallback ONLY when nothing matched by title and counts agree (a clean, equal-length book)
  if (!pairs.length && sections.length === chapters.length && chapters.length > 0) {
    sections.forEach((s, si) => { pairs.push({ sectionIndex: si, chapterId: chapters[si].id, how: "order", conf: 0.6 }); used.add(si); });
    log.push(`no title matches; fell back to order (equal counts ${chapters.length})`);
  }
  pairs.sort((a, b) => a.sectionIndex - b.sectionIndex);
  const matchedSecs = new Set(pairs.map((p) => p.sectionIndex));
  const unmatched = sections.map((s, i) => i).filter((i) => !matchedSecs.has(i));
  if (unmatched.length) log.push(`unmatched sections (no confident chapter; skipped, not forced): ${unmatched.map((i) => JSON.stringify(sections[i].title)).join(", ")}`);
  const orphanChapters = chapters.map((c, i) => i).filter((i) => !used.has(i));
  if (orphanChapters.length) log.push(`text chapters with no audio section: ${orphanChapters.map((i) => JSON.stringify(chapters[i].title)).join(", ")}`);
  return { pairs, unmatched, log };
}

export default { parseHeading, mapSections };
if (typeof window !== "undefined") window.HoloChapterMap = { parseHeading, mapSections };
