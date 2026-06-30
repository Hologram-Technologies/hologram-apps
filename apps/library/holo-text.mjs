// holo-text.mjs — the text track. Turns a raw book (Project Gutenberg plain text) into the reader's addressable
// text DAG: strip the PG license boilerplate, split into chapters, sentence-span each chapter, and content-
// address every chapter by κ (the text-track κ is the κ over the sorted chapter-κ map — a self-verifying
// manifest, same pattern as holospaceKappa). The spans line up 1:1 with what holo-align consumes and holo-read
// renders, so a Gutenberg text drops straight into the read-along. Pure (kappaOf is pure blake3) → Node
// witnesses it; the only input is bytes, so it runs identically on a real fetched book or a fixture.
//
//   toTextDAG(rawText, { bookId }) → { chapters:[{ id, title, spans:[{spanId,text}], kappa }], kappa, words }
//   chapterRefText(dag, i) → the plain text of chapter i (what holo-align aligns against the audio)

import { kappaOf } from "./holo-kappa.mjs";
const te = new TextEncoder();

// PG wraps the actual work between these markers; everything outside is license/credits, not the book.
const PG_START = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
const PG_END = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;

export function stripGutenberg(raw) {
  let t = String(raw || "").replace(/\r\n/g, "\n");
  const sm = t.match(PG_START); if (sm) t = t.slice(t.indexOf(sm[0]) + sm[0].length);
  const em = t.match(PG_END); if (em) t = t.slice(0, t.indexOf(em[0]));
  return t.trim();
}

// chapter headings in classic literature: "CHAPTER I", "Letter 1", "Part Two", … on their own short line.
const HEAD = /^(chapter|letter|part|book)\b.{0,60}$/i;
export function chapterize(text) {
  const lines = text.split("\n");
  const heads = [];
  lines.forEach((ln, i) => { const s = ln.trim(); if (s.length <= 60 && HEAD.test(s)) heads.push({ i, title: s }); });
  if (heads.length < 2) return [{ title: "", text: text.trim() }];
  const chs = [];
  const pre = lines.slice(0, heads[0].i).join("\n").trim();
  if (pre.length > 200) chs.push({ title: "", text: pre });            // preface/intro before chapter 1
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].i + 1, end = h + 1 < heads.length ? heads[h + 1].i : lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    if (body) chs.push({ title: heads[h].title, text: body });
  }
  return chs;
}

// strip Gutenberg's plain-text emphasis markup (_italics_) and collapse whitespace, so the reader shows clean
// prose. _ is purely presentational in PG texts, safe to remove.
export const cleanInline = (t) => String(t || "").replace(/_/g, "").replace(/[ \t]+/g, " ");

// same sentence boundary as holo-align.tokenizeRef, so text spans and syncmap spans correspond.
export const splitSentences = (t) => cleanInline(t).replace(/\s+/g, " ").trim()
  .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((s) => s.trim()).filter(Boolean);

export function toTextDAG(rawText, { bookId = "c" } = {}) {
  const body = stripGutenberg(rawText);
  const chs = chapterize(body);
  let words = 0;
  const chapters = chs.map((c, i) => {
    const id = `${bookId}${i}`;
    const text = cleanInline(c.text);
    const spans = splitSentences(text).map((s, j) => ({ spanId: `${id}#s${j}`, text: s }));
    words += text.split(/\s+/).filter(Boolean).length;
    return { id, title: c.title, spans, kappa: kappaOf(te.encode(text)) };
  });
  const kappa = kappaOf(te.encode(chapters.map((c) => c.kappa).slice().sort().join("|")));
  return { chapters, kappa, words };
}

// the plain text holo-align aligns against the chapter's audio.
export const chapterRefText = (dag, i) => (dag.chapters[i]?.spans || []).map((s) => s.text).join(" ");

export default { stripGutenberg, chapterize, splitSentences, toTextDAG, chapterRefText };
if (typeof window !== "undefined") window.HoloText = { stripGutenberg, chapterize, splitSentences, toTextDAG, chapterRefText };
