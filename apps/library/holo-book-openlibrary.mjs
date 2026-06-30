// holo-book-openlibrary.mjs — Open Library as a METADATA BookProvider: canonical titles, authors, first-
// publish year, and high-quality covers for the whole of book-space, key-free. It rarely carries the content
// itself, so it contributes mediaType:"meta" — it enriches a work (and supplies the cover) but never claims to
// be playable text/audio. This keeps the rights model honest: metadata is not bytes.
//   https://openlibrary.org/search.json?q=frankenstein+shelley&limit=12
//     → { docs:[ { title, author_name:["Mary Shelley"], first_publish_year, cover_i, language:["eng"] } ] }
//   cover: https://covers.openlibrary.org/b/id/{cover_i}-L.jpg

const OL = "https://openlibrary.org/search.json";
const COVERS = "https://covers.openlibrary.org/b/id";

function normalize(d) {
  return {
    id: "ol:" + (d.key || d.cover_edition_key || (d.title + ":" + (d.first_publish_year || ""))).replace(/^\/+/, ""),
    mediaType: "meta",
    title: d.title || "", authors: d.author_name || [],
    lang: (d.language || ["eng"])[0], year: d.first_publish_year || null,
    cover: d.cover_i ? `${COVERS}/${d.cover_i}-L.jpg` : null,
    license: "",                                            // metadata only — no content license claim
  };
}

export function createOpenLibrary({ fetch: f, cache } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error("holo-book-openlibrary: fetch required");
  async function api(url) {
    const fetcher = async () => { const r = await doFetch(url); if (!r.ok) throw new Error("openlibrary " + r.status); return r.json(); };
    if (!cache) return fetcher();
    const { body } = await cache.through("ol|" + url, fetcher); return body;
  }
  return {
    id: "builtin:openlibrary", name: "Open Library", kind: "open", mediaType: "meta", enabled: true, trust: 4,
    async search(q) {
      let data; try { data = await api(`${OL}?q=${encodeURIComponent(q)}&limit=12&fields=key,title,author_name,first_publish_year,cover_i,language`); } catch { return []; }
      return ((data && data.docs) || []).map(normalize).filter((d) => d.title);
    },
  };
}

export default { createOpenLibrary };
if (typeof window !== "undefined") window.HoloBookOpenLibrary = { createOpenLibrary };
