// holo-book-commercial.mjs — Tier C: commercial catalogs (Audible, Apple Books, Spotify, xigxag…). These are
// DISCOVERY ONLY. The adapter yields metadata + a link-out URL and NOTHING playable — mediaType "meta", tier
// "commercial". Holo Library indexes these so a search is complete and surfaces "available here → buy/open",
// but the rights gate (holo-rights.mjs) refuses to ever ingest their bytes. If the user owns the same title on
// their OWN source (Tier B), that copy plays; otherwise this is a card with a link, never a stream.
//
// createCommercialCatalog({ id, name, fetch, endpoint, parse }) — injected fetch (Node-witnessable). `parse`
// maps the catalog's JSON to { title, authors[], lang, year, cover, linkOut }; a default handles a generic shape.

const defaultParse = (data) => {
  const rows = data?.products || data?.results || data?.items || [];
  return rows.map((r) => ({
    title: r.title || r.name || "", authors: (r.authors || []).map((a) => a.name || a) || [],
    lang: r.language || r.lang || "en", year: r.year || null,
    cover: r.cover || r.image || null,
    linkOut: r.buyUrl || r.url || r.link || "",
    _id: r.asin || r.id || r.title,
  }));
};

export function createCommercialCatalog({ id, name, fetch: f, endpoint, parse } = {}) {
  const doFetch = f || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error("holo-book-commercial: fetch required");
  if (!endpoint) throw new Error("holo-book-commercial: endpoint(q) required");
  const toRows = parse || defaultParse;
  return {
    id: "commercial:" + (id || "catalog"), name: name || "Commercial Catalog", kind: "commercial", tier: "commercial", mediaType: "meta", enabled: true, trust: 2,
    async search(q) {
      let data; try { const r = await doFetch(endpoint(q)); if (!r.ok) throw new Error("commercial " + r.status); data = await r.json(); } catch { return []; }
      return toRows(data).filter((x) => x.title).map((x) => ({
        id: "com:" + (id || "x") + ":" + (x._id || x.title), mediaType: "meta", tier: "commercial",
        title: x.title, authors: x.authors, lang: x.lang, year: x.year, cover: x.cover,
        linkOut: x.linkOut,                                  // the ONLY actionable thing: take me there to buy/open
        license: "",                                         // no content license — we never hold the content
      }));
    },
  };
}

export default { createCommercialCatalog };
if (typeof window !== "undefined") window.HoloBookCommercial = { createCommercialCatalog };
