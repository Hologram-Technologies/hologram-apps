// holo-book-librivox.mjs — LibriVox as an AUDIO BookProvider. LibriVox is the world's largest collection of
// free public-domain audiobooks (volunteer-narrated), with an open, key-free JSON API. We normalize its books
// to editions tagged mediaType:"audio"; the per-chapter mp3s (hosted on archive.org) are resolved on demand.
//   https://librivox.org/api/feed/audiobooks/?title=^X&format=json&extended=1
//     → { books: [ { id, title, authors:[{first_name,last_name}], language, url_iarchive?, sections:[{listen_url,...}] } ] }
//
// createLibriVox({ fetch, cache }) — injected (Node-witnessable). Implements { search }, plus resolveTracks()
// to enumerate the chapter audio URLs (instant-play HTTP, later pinned by holo-stream).

const LV = "https://librivox.org/api/feed/audiobooks";
const fullName = (a) => [a.first_name, a.last_name].filter(Boolean).join(" ").trim() || a.last_name || a.first_name || "";

function normalizeBook(b) {
  return {
    id: "lv:" + b.id, _lvId: b.id, mediaType: "audio",
    title: b.title || "", authors: (b.authors || []).map(fullName).filter(Boolean),
    lang: b.language || "English", year: null,
    cover: null,                                            // LibriVox has no reliable cover; Open Library supplies it
    _iaId: b.url_iarchive ? String(b.url_iarchive).split("/").filter(Boolean).pop() : (b._iaId || null),
    _sections: Array.isArray(b.sections) ? b.sections.map((s) => ({ title: s.title || "", url: s.listen_url || "", sec: +s.playtime || 0 })) : [],
    license: "Public Domain",
  };
}

export function createLibriVox({ fetch: f, cache } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error("holo-book-librivox: fetch required");
  async function api(url) {
    const fetcher = async () => { const r = await doFetch(url); if (!r.ok) throw new Error("librivox " + r.status); return r.json(); };
    if (!cache) return fetcher();
    const { body } = await cache.through("lv|" + url, fetcher); return body;
  }
  return {
    id: "builtin:librivox", name: "LibriVox", kind: "open", mediaType: "audio", enabled: true, trust: 3,
    async search(q) {
      const url = `${LV}/?title=^${encodeURIComponent(q)}&format=json&extended=1&limit=12`;
      let data; try { data = await api(url); } catch { return []; }
      const books = (data && data.books) || [];
      return books.map(normalizeBook).filter((b) => b.title);
    },
    // the ordered chapter audio URLs for an edition (each later pinned by κ via holo-stream).
    async resolveTracks(ed) {
      if (ed._sections && ed._sections.length) return ed._sections.map((s) => ({ url: s.url, type: "audio/mpeg", sec: s.sec, title: s.title, httpDirect: true }));
      const data = await api(`${LV}/?id=${encodeURIComponent(ed._lvId)}&format=json&extended=1`);
      const b = ((data && data.books) || [])[0];
      return ((b && b.sections) || []).map((s) => ({ url: s.listen_url || "", type: "audio/mpeg", sec: +s.playtime || 0, title: s.title || "", httpDirect: true }));
    },
  };
}

export default { createLibriVox };
if (typeof window !== "undefined") window.HoloBookLibriVox = { createLibriVox };
