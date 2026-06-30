// holo-manufacture.mjs — the live pipeline that turns a discovered WORK into an owned read-along holo-title, in
// the host. It is the orchestration the in-runtime session needs; it composes ONLY witnessed kernels + the M1
// glue, and takes the engine/store/already-fetched bytes by injection so it is testable headlessly (the host
// supplies the real Whisper engine, holo-content-net store, and network fetches).
//
//   createManufacture({ asr, store })
//     .build(work, { gutenbergText, sections:[{title,audioBytes,sec}], eagerChapters=1, threshold=0.5 })
//        → { dag, pins, map, alignChapter(i), title(), state }
//
// Design: text → holo-text DAG; audio sections → pinned by κ (holo-pin); sections↔chapters mapped
// (holo-chaptermap); each chapter aligned LAZILY (alignChapter(i)) so chapter 1 is read-along-ready in seconds
// while the rest align on demand; title() seals the current state into a holo-title (audio = the κ playlist
// manifest, text = the DAG κ, syncmap = κ over the aligned chapters). Rights: Tier-A public-domain only.

import { toTextDAG, chapterRefText } from "./holo-text.mjs";
import { pinTracks, resolveVerified } from "./holo-pin.mjs";
import { mapSections } from "./holo-chaptermap.mjs";
import { alignChapter as alignKernel } from "./holo-align.mjs";
import { flattenSyncmaps } from "./holo-read.mjs";
import { sealTitle, RIGHTS } from "./holo-title.mjs";
import { kappaOf } from "./holo-kappa.mjs";

const te = new TextEncoder();
const slug = (w) => String(w?.title || "book").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "book";

export function createManufacture({ asr, store } = {}) {
  if (!asr || typeof asr.toWords !== "function") throw new Error("holo-manufacture: an asr (holo-asr.createASR) is required");
  if (!store) throw new Error("holo-manufacture: a κ store (holo-pin) is required");

  async function build(work, { gutenbergText, sections = [], eagerChapters = 1, threshold = 0.5 } = {}) {
    const bookId = slug(work);
    const dag = toTextDAG(gutenbergText, { bookId });
    const pins = pinTracks(store, sections.map((s) => ({ bytes: s.audioBytes, sec: s.sec || 0, title: s.title || "" })));
    const map = mapSections(sections, dag.chapters);
    const pairByChapter = new Map(map.pairs.map((p) => [p.chapterId, p]));
    const syncByChapter = new Map();                                   // chapterIdx → syncmap (lazy cache)

    // align ONE chapter on demand: verify its audio (L5), run ASR → words, align against the chapter text.
    async function alignChapter(i) {
      if (syncByChapter.has(i)) return syncByChapter.get(i);
      const ch = dag.chapters[i]; if (!ch) return null;
      const pair = pairByChapter.get(ch.id); if (!pair) return null;   // no confident audio section → stays read-only
      const audioBytes = resolveVerified(store, pins[pair.sectionIndex].url);   // tamper-checked bytes
      const words = await asr.toWords(audioBytes, { timestamps: "word" });
      const sm = alignKernel({ refText: chapterRefText(dag, i), asrWords: words, chapterId: ch.id, threshold });
      syncByChapter.set(i, sm);
      return sm;
    }

    for (let i = 0; i < Math.min(eagerChapters, dag.chapters.length); i++) await alignChapter(i);

    // seal the current state into a holo-title. audio = κ over the ordered section-κ playlist; text = DAG κ;
    // syncmap = κ over the chapters aligned so far (re-seal as more align — the κ is honest about coverage).
    function title() {
      const playlist = pins.map((p) => p.kappa);
      const audioKappa = kappaOf(te.encode(JSON.stringify(playlist)));
      const alignedChapters = [...syncByChapter.entries()].sort((a, b) => a[0] - b[0])
        .map(([i, sm]) => ({ chapterId: dag.chapters[i].id, spans: sm.spans, durationMs: (sections[pairByChapter.get(dag.chapters[i].id)?.sectionIndex]?.sec || 0) * 1000 }));
      const flat = flattenSyncmaps(alignedChapters);
      const syncmapKappa = alignedChapters.length ? kappaOf(te.encode(JSON.stringify(alignedChapters))) : null;
      return {
        sealed: sealTitle({
          work: { title: work.title, authors: work.authors || [], lang: work.lang || "en", cover: null,
            sourceAttribution: ["LibriVox (audio)", "Project Gutenberg (text)"] },
          audio: audioKappa, text: dag.kappa, syncmap: syncmapKappa,
          provenance: { sources: [{ library: "LibriVox", mediaType: "audio" }, { library: "Project Gutenberg", mediaType: "text" }], license: "Public Domain", derived: !!syncmapKappa },
          rights: { class: RIGHTS.PUBLIC_DOMAIN },
        }),
        spans: flat, playlist, alignedCount: alignedChapters.length,
      };
    }

    return { dag, pins, map, alignChapter, title, get state() { return { chapters: dag.chapters.length, aligned: syncByChapter.size, sections: sections.length, unmatched: map.unmatched.length }; } };
  }

  return { build };
}

export default { createManufacture };
if (typeof window !== "undefined") window.HoloManufacture = { createManufacture };
