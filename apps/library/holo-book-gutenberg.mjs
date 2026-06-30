// holo-book-gutenberg.mjs — Project Gutenberg (via the open Gutendex API) as a TEXT BookProvider. Gutenberg is
// ~70k public-domain books with clean, machine-readable plain text — the perfect partner for LibriVox audio.
//   https://gutendex.com/books?search=frankenstein+shelley
//     → { results: [ { id, title, authors:[{name:"Shelley, Mary"}], languages:["en"],
//                       formats:{ "text/plain; charset=utf-8":url, "image/jpeg":coverUrl } } ] }
//
// createGutenberg({ fetch, cache }) — injected (Node-witnessable). Implements { search }; the plain-text URL is
// the locator the runtime fetches + normalizes into the addressable text DAG (chapters → spans).

const GX = "https://gutendex.com/books";
// pick the cleanest plain-text format Gutendex offers (prefer utf-8, avoid .zip).
function textUrl(formats) {
  const keys = Object.keys(formats || {});
  const utf8 = keys.find((k) => /text\/plain/.test(k) && /utf-8/i.test(k) && !/\.zip$/i.test(formats[k]));
  const plain = keys.find((k) => /text\/plain/.test(k) && !/\.zip$/i.test(formats[k]));
  return formats[utf8] || formats[plain] || null;
}
function coverUrl(formats) { const k = Object.keys(formats || {}).find((x) => /image\/jpeg/.test(x)); return k ? formats[k] : null; }

function normalize(b) {
  const tUrl = textUrl(b.formats);
  return {
    id: "gb:" + b.id, _gbId: b.id, mediaType: "text",
    title: b.title || "", authors: (b.authors || []).map((a) => a.name).filter(Boolean),
    lang: (b.languages || ["en"])[0], year: null,
    cover: coverUrl(b.formats),
    textUrl: tUrl, _url: tUrl,
    license: "Public Domain",
  };
}

export function createGutenberg({ fetch: f, cache } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error("holo-book-gutenberg: fetch required");
  async function api(url) {
    const fetcher = async () => { const r = await doFetch(url); if (!r.ok) throw new Error("gutendex " + r.status); return r.json(); };
    if (!cache) return fetcher();
    const { body } = await cache.through("gb|" + url, fetcher); return body;
  }
  return {
    id: "builtin:gutenberg", name: "Project Gutenberg", kind: "open", mediaType: "text", enabled: true, trust: 4,
    async search(q) {
      let data; try { data = await api(`${GX}?search=${encodeURIComponent(q)}`); } catch { return []; }
      return ((data && data.results) || []).map(normalize).filter((b) => b.title && b.textUrl);
    },
    // fetch the raw plain text for an edition (runtime normalizes → text DAG; here just the bytes locator).
    async fetchText(ed) {
      const r = await doFetch(ed.textUrl || ed._url); if (!r.ok) throw new Error("gutenberg text " + r.status); return r.text();
    },
  };
}

export default { createGutenberg };
if (typeof window !== "undefined") window.HoloBookGutenberg = { createGutenberg };
