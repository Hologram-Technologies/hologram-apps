// holo-book.mjs — the work hub for Holo Library. Books are not films: the magic is that ONE work's audio and
// text live in DIFFERENT open libraries (LibriVox narration + Project Gutenberg text), and we MERGE them into
// a single "work" you can then auto-manufacture into a synced holo-title. So instead of the player's stream-
// candidate model, a BookProvider yields *editions* tagged by mediaType, and the hub groups editions across
// providers by a stable work key (normalized title + author surname + language).
//
//   BookProvider = { id, name, kind, trust, mediaType: "audio"|"text"|"meta", async search(q) → [edition] }
//   edition      = { id, title, authors[], lang, year?, cover?, mediaType, _src, ...locator }
//   work         = { key, title, authors[], lang, year?, cover, audio[], text[], meta[], sources[] }
//
// Pure ESM, providers inject their own fetch — Node witnesses the merge exactly. assembleTitle() turns a chosen
// (audio, text) pair into a sealed public-domain holo-title, carrying provenance from BOTH source libraries.

import { sealTitle, RIGHTS } from "./holo-title.mjs";

// ── work-key normalization: the join that lets a LibriVox recording meet its Gutenberg text ─────────────────
const ARTICLE = /^(the|a|an)\s+/i;
export const normTitle = (s) => String(s || "").toLowerCase().replace(ARTICLE, "").replace(/[^a-z0-9]+/g, " ").trim();
// the merge key uses the MAIN title only — strip the subtitle so "Frankenstein" (LibriVox) meets
// "Frankenstein; Or, The Modern Prometheus" (Gutenberg). Split on the first subtitle delimiter (: ; — / or).
export const mainTitle = (s) => normTitle(String(s || "").split(/\s*[:;—\/]\s*|\s+\bor\b\s+/i)[0]);
export const lang2 = (s) => { const l = String(s || "").toLowerCase(); return ({ eng: "en", fre: "fr", ger: "de", spa: "es", ita: "it", por: "pt" }[l] || l.slice(0, 2)) || "en"; };
// surname from "Mary Shelley" | "Shelley, Mary Wollstonecraft" | "Shelley" — the merge key tolerates each form.
export function authorKey(a) {
  const s = String(a || "").trim();
  if (!s) return "";
  if (s.includes(",")) return s.split(",")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const parts = s.split(/\s+/);
  return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, "");
}
export const workKey = (title, authors, lang) => `${mainTitle(title)}|${authorKey((authors || [])[0])}|${lang2(lang)}`;

// the three integration tiers (P4). A provider declares its tier; editions inherit it; the rights gate
// (holo-rights.mjs) reads it to decide what may be ingested vs only indexed/linked-out.
export const TIER = Object.freeze({ OPEN: "open", OWNED: "owned", COMMERCIAL: "commercial" });
export const tierOfKind = (k) => ({ open: "open", owned: "owned", server: "owned", commercial: "commercial" }[k] || "open");

export function createBookHub() {
  const providers = [];
  const register = (p) => { if (p && typeof p.search === "function") providers.push({ enabled: true, trust: 3, ...p }); return p; };
  const enabled = () => providers.filter((p) => p.enabled);
  const setEnabled = (id, on) => { const p = providers.find((x) => x.id === id); if (p) p.enabled = on; };

  // findWorks(q) → works merged across every provider, grouped by work key. A shelf is built per provider so a
  // provider that errors drops its editions, never the search.
  async function findWorks(q) {
    const byKey = new Map();
    for (const p of enabled()) {
      let eds = [];
      try { eds = (await p.search(q)) || []; } catch {}
      for (const ed0 of eds) {
        const ed = { ...ed0, mediaType: ed0.mediaType || p.mediaType, _provider: p.id, _providerName: p.name, _trust: p.trust, _tier: ed0.tier || p.tier || tierOfKind(p.kind) };
        const key = workKey(ed.title, ed.authors, ed.lang);
        let w = byKey.get(key);
        if (!w) { w = { key, title: ed.title, authors: ed.authors || [], lang: lang2(ed.lang), year: ed.year || null, cover: null, audio: [], text: [], meta: [], sources: [] }; byKey.set(key, w); }
        const bucket = ed.mediaType === "audio" ? w.audio : ed.mediaType === "text" ? w.text : w.meta;
        bucket.push(ed);
        if (!w.sources.includes(p.name)) w.sources.push(p.name);
        // cover preference: meta (Open Library, curated) > text (Gutenberg) > audio; first wins per tier.
        if (ed.cover && (!w.cover || (ed.mediaType === "meta"))) w.cover = ed.cover;
        if (!w.year && ed.year) w.year = ed.year;
        if ((!w.authors || !w.authors.length) && ed.authors?.length) w.authors = ed.authors;
      }
    }
    // surface works that can actually become a synced title first (have BOTH audio and text), then the rest.
    return [...byKey.values()].sort((a, b) => (manufacturable(b) - manufacturable(a)) || (b.audio.length + b.text.length) - (a.audio.length + a.text.length));
  }

  return { register, setEnabled, enabled, findWorks, _providers: providers };
}

// can this work be auto-manufactured into a read-along (audio AND text both available)?
export const manufacturable = (w) => (w.audio?.length && w.text?.length) ? 1 : 0;

// assembleTitle — turn a chosen (audioEdition, textEdition) pair, with their already-pinned κ values, into a
// sealed public-domain holo-title. Provenance records BOTH libraries; cover κ from the work. The actual byte-
// pinning (audio→holo-stream, text→text DAG) happens in the runtime; this seals the manifest over those κ.
export function assembleTitle(work, { audioEdition = null, textEdition = null, audioKappa = null, textKappa = null, syncmapKappa = null, coverKappa = null } = {}) {
  const sources = [];
  if (audioEdition) sources.push({ library: audioEdition._providerName, mediaType: "audio", ref: audioEdition.id, url: audioEdition.audioUrl || audioEdition._url || "" });
  if (textEdition) sources.push({ library: textEdition._providerName, mediaType: "text", ref: textEdition.id, url: textEdition.textUrl || textEdition._url || "" });
  return sealTitle({
    work: {
      title: work.title, authors: work.authors || [], lang: work.lang, year: work.year || null,
      cover: coverKappa || null,
      sourceAttribution: sources.map((s) => `${s.library} (${s.mediaType})`),
    },
    audio: audioKappa, text: textKappa, syncmap: syncmapKappa,
    provenance: { sources, license: "Public Domain", derived: !!syncmapKappa },
    rights: { class: RIGHTS.PUBLIC_DOMAIN },
  });
}

export default { createBookHub, workKey, normTitle, authorKey, lang2, manufacturable, assembleTitle };
if (typeof window !== "undefined") window.HoloBook = { createBookHub, workKey, manufacturable, assembleTitle };
